// READ-ONLY BY DEFAULT: the package-level `writable` grant of
// `wasi:filesystem` (fs_provider.ts header). Enforcement lives in the
// PROVIDER, so these run the node backend for the full enumeration —
// both tracks — and the OPFS fake for a spot-check that an async backend
// inherits the same refusals from the same site.
//
// What is under test, and why it is shaped as an enumeration: with one
// global flag there is no permission lattice for a guest to bridge
// across (no per-preopen cells, hence no wrong-side check on the
// two-descriptor ops `link-at`/`rename-at`). The proof obligation is
// therefore closed and mechanical — "every mutating leaf of the WIT
// refuses" — so every leaf gets its OWN named test and a regression
// names itself.
//
// The mutating leaves, derived from `wasi:filesystem/types` in both
// tracks:
//   0.2: write-via-stream, append-via-stream, write, set-size,
//        set-times, set-times-at, create-directory-at,
//        remove-directory-at, unlink-file-at, rename-at, link-at,
//        symlink-at, and open-at when it asks for write/mutate-directory
//        descriptor-flags or the create/truncate/exclusive open-flags.
//   0.3: the same list minus positional `write` (0.3 dropped
//        `read`/`write` in favour of the stream forms).
// NOT mutating, and deliberately still allowed read-only: read,
// read-via-stream, read-directory, readlink-at, stat, stat-at, get-flags,
// get-type, is-same-object, metadata-hash(-at), advise (advisory), and
// `sync`/`sync-data` — those FLUSH already-accepted writes rather than
// making new ones, so refusing them would be meaningless on a filesystem
// that never accepted a write.

import { ComponentException } from "@polyengine/runtime/embedder";
import { filesystemNode } from "../src/filesystem_node.ts";
import { filesystemWeb } from "../src/filesystem_web.ts";
import { FakeDirectoryHandle } from "./support/opfs_fake.ts";
import { assertEq, assertRejects, assertThrows, assertTrue } from "./asserts.ts";

type Flags = Record<string, boolean>;

interface OutStream02 {
  checkWrite(): bigint;
  write(b: Uint8Array): void;
  blockingFlush(): void;
}
interface Res03 {
  kind: string;
  value?: { kind: string };
}
interface D02 {
  getFlags(): Flags;
  getType(): string;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): D02;
  read(len: bigint, off: bigint): [Uint8Array, boolean];
  write(buf: Uint8Array, off: bigint): bigint;
  writeViaStream(off: bigint): OutStream02;
  appendViaStream(): OutStream02;
  setSize(n: bigint): void;
  setTimes(a: unknown, m: unknown): void;
  setTimesAt(pf: Flags, p: string, a: unknown, m: unknown): void;
  createDirectoryAt(p: string): void;
  removeDirectoryAt(p: string): void;
  unlinkFileAt(p: string): void;
  renameAt(o: string, d: D02, n: string): void;
  linkAt(pf: Flags, o: string, d: D02, n: string): void;
  symlinkAt(t: string, p: string): void;
  readlinkAt(p: string): string;
  statAt(pf: Flags, p: string): { type: string };
  sync(): void;
  syncData(): void;
}
interface D03 {
  getFlags(): Flags;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): D03 | Promise<D03>;
  writeViaStream(data: unknown, off: bigint): Promise<Res03>;
  appendViaStream(data: unknown): Promise<Res03>;
  setSize(n: bigint): void | Promise<void>;
  setTimes(a: unknown, m: unknown): void | Promise<void>;
  setTimesAt(pf: Flags, p: string, a: unknown, m: unknown): void | Promise<void>;
  createDirectoryAt(p: string): void | Promise<void>;
  removeDirectoryAt(p: string): void | Promise<void>;
  unlinkFileAt(p: string): void | Promise<void>;
  renameAt(o: string, d: D03, n: string): void | Promise<void>;
  linkAt(pf: Flags, o: string, d: D03, n: string): void | Promise<void>;
  symlinkAt(t: string, p: string): void | Promise<void>;
  statAt(pf: Flags, p: string): { type: string } | Promise<{ type: string }>;
}

const FOLLOW: Flags = { symlinkFollow: true };
const READ: Flags = { read: true };
const RW: Flags = { read: true, write: true };
const NOW = { kind: "now" };

/** A tree with content to mutate: the read-only cases must find their
 * targets present (so a refusal is a refusal, not a missing file). */
function seedTree(): string {
  const dir = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-ro-" });
  Deno.writeTextFileSync(`${dir}/seed.txt`, "seed");
  Deno.writeTextFileSync(`${dir}/other.txt`, "other");
  Deno.mkdirSync(`${dir}/sub`);
  Deno.mkdirSync(`${dir}/empty`);
  return dir;
}

interface Setup {
  root02: D02;
  root03: D03;
  dir: string;
}

function setup(writable: boolean): Setup {
  const dir = seedTree();
  const { imports } = filesystemNode({ preopens: { "/": dir }, writable });
  const [[root02]] = (imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): [D02, string][];
  }).getDirectories();
  const [[root03]] = (imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [D03, string][];
  }).getDirectories();
  return { root02, root03, dir };
}

function payload(f: () => unknown): unknown {
  const e = assertThrows(f);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException).payload;
}

async function rejectedPayload(f: () => unknown): Promise<unknown> {
  const e = await assertRejects(f);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException).payload;
}

/** 0.2's error-code is an ENUM: the payload is the bare kebab string. */
function assertReadOnly02(f: () => unknown): void {
  assertEq(payload(f), "read-only");
}

/** 0.3's error-code is a VARIANT: the payload is `{ kind }`. */
function assertReadOnly03(f: () => unknown): void {
  assertEq((payload(f) as { kind: string }).kind, "read-only");
}

/** 0.3's stream ops report through the future value, not a throw. */
function assertReadOnlyResult03(r: Res03): void {
  assertEq(r.kind, "err");
  assertEq(r.value?.kind, "read-only");
}

// --- 0.2: one named test per mutating leaf ----------------------------------------

/** Leaves reachable from the preopen directory descriptor alone. */
const DIR_LEAVES_02: [string, (s: Setup) => unknown][] = [
  ["set-times-at", ({ root02 }) => root02.setTimesAt(FOLLOW, "seed.txt", NOW, NOW)],
  ["create-directory-at", ({ root02 }) => root02.createDirectoryAt("made")],
  ["remove-directory-at", ({ root02 }) => root02.removeDirectoryAt("empty")],
  ["unlink-file-at", ({ root02 }) => root02.unlinkFileAt("seed.txt")],
  ["rename-at", ({ root02 }) => root02.renameAt("seed.txt", root02, "moved.txt")],
  ["link-at", ({ root02 }) => root02.linkAt({}, "seed.txt", root02, "linked.txt")],
  ["symlink-at", ({ root02 }) => root02.symlinkAt("seed.txt", "alias.txt")],
];

/** Leaves on an open FILE descriptor. Read-only can still OPEN for
 * reading, which is what makes these refusals meaningful. */
const FILE_LEAVES_02: [string, (s: Setup, f: D02) => unknown][] = [
  ["write-via-stream", (_s, f) => f.writeViaStream(0n)],
  ["append-via-stream", (_s, f) => f.appendViaStream()],
  ["write", (_s, f) => f.write(new Uint8Array([1]), 0n)],
  ["set-size", (_s, f) => f.setSize(0n)],
  ["set-times", (_s, f) => f.setTimes(NOW, NOW)],
];

for (const [name, op] of DIR_LEAVES_02) {
  Deno.test(`fs-readonly 0.2: ${name} refuses with read-only`, () => {
    const s = setup(false);
    assertReadOnly02(() => op(s));
  });
  Deno.test(`fs-readonly 0.2: ${name} succeeds with writable: true`, () => {
    const s = setup(true);
    op(s); // no throw
  });
}

for (const [name, op] of FILE_LEAVES_02) {
  Deno.test(`fs-readonly 0.2: ${name} refuses with read-only`, () => {
    const s = setup(false);
    const f = s.root02.openAt(FOLLOW, "seed.txt", {}, READ);
    assertReadOnly02(() => op(s, f));
  });
  Deno.test(`fs-readonly 0.2: ${name} succeeds with writable: true`, () => {
    const s = setup(true);
    const f = s.root02.openAt(FOLLOW, "seed.txt", {}, RW);
    op(s, f); // no throw
  });
}

Deno.test("fs-readonly 0.2: open-at refuses create/truncate/exclusive and write flags", () => {
  const { root02 } = setup(false);
  assertReadOnly02(() => root02.openAt(FOLLOW, "new.txt", { create: true }, READ));
  assertReadOnly02(() => root02.openAt(FOLLOW, "seed.txt", { truncate: true }, READ));
  assertReadOnly02(() => root02.openAt(FOLLOW, "new.txt", { exclusive: true }, READ));
  assertReadOnly02(() => root02.openAt(FOLLOW, "seed.txt", {}, RW));
  assertReadOnly02(() =>
    root02.openAt(FOLLOW, "sub", { directory: true }, { read: true, mutateDirectory: true })
  );
  // ...and the read-only opens it must still allow.
  assertEq(root02.openAt(FOLLOW, "seed.txt", {}, READ).getType(), "regular-file");
  assertEq(root02.openAt(FOLLOW, "sub", { directory: true }, READ).getType(), "directory");
});

Deno.test("fs-readonly 0.2: non-mutating leaves stay available", () => {
  const { root02 } = setup(false);
  const f = root02.openAt(FOLLOW, "seed.txt", {}, READ);
  assertEq(new TextDecoder().decode(f.read(64n, 0n)[0]), "seed");
  assertEq(root02.statAt(FOLLOW, "seed.txt").type, "regular-file");
  // sync/sync-data FLUSH rather than mutate (module header): allowed.
  f.sync();
  f.syncData();
});

// --- 0.3: the same enumeration, variant-shaped errors -----------------------------

const DIR_LEAVES_03: [string, (s: Setup) => unknown][] = [
  ["set-times-at", ({ root03 }) => root03.setTimesAt(FOLLOW, "seed.txt", NOW, NOW)],
  ["create-directory-at", ({ root03 }) => root03.createDirectoryAt("made")],
  ["remove-directory-at", ({ root03 }) => root03.removeDirectoryAt("empty")],
  ["unlink-file-at", ({ root03 }) => root03.unlinkFileAt("seed.txt")],
  ["rename-at", ({ root03 }) => root03.renameAt("seed.txt", root03, "moved.txt")],
  ["link-at", ({ root03 }) => root03.linkAt({}, "seed.txt", root03, "linked.txt")],
  ["symlink-at", ({ root03 }) => root03.symlinkAt("seed.txt", "alias.txt")],
];

for (const [name, op] of DIR_LEAVES_03) {
  Deno.test(`fs-readonly 0.3: ${name} refuses with read-only`, () => {
    const s = setup(false);
    assertReadOnly03(() => op(s));
  });
  Deno.test(`fs-readonly 0.3: ${name} succeeds with writable: true`, async () => {
    const s = setup(true);
    await op(s); // no throw / no rejection
  });
}

const FILE_LEAVES_03: [string, (f: D03) => unknown][] = [
  ["set-size", (f) => f.setSize(0n)],
  ["set-times", (f) => f.setTimes(NOW, NOW)],
];

for (const [name, op] of FILE_LEAVES_03) {
  Deno.test(`fs-readonly 0.3: ${name} refuses with read-only`, async () => {
    const s = setup(false);
    const f = await s.root03.openAt(FOLLOW, "seed.txt", {}, READ);
    assertReadOnly03(() => op(f));
  });
  Deno.test(`fs-readonly 0.3: ${name} succeeds with writable: true`, async () => {
    const s = setup(true);
    const f = await s.root03.openAt(FOLLOW, "seed.txt", {}, RW);
    await op(f);
  });
}

Deno.test("fs-readonly 0.3: write-via-stream refuses with read-only", async () => {
  const s = setup(false);
  const f = await s.root03.openAt(FOLLOW, "seed.txt", {}, READ);
  assertReadOnlyResult03(await f.writeViaStream([new Uint8Array([1])], 0n));
  assertEq(Deno.readTextFileSync(`${s.dir}/seed.txt`), "seed");
});

Deno.test("fs-readonly 0.3: append-via-stream refuses with read-only", async () => {
  const s = setup(false);
  const f = await s.root03.openAt(FOLLOW, "seed.txt", {}, READ);
  assertReadOnlyResult03(await f.appendViaStream([new Uint8Array([1])]));
  assertEq(Deno.readTextFileSync(`${s.dir}/seed.txt`), "seed");
});

Deno.test("fs-readonly 0.3: the stream writers work with writable: true", async () => {
  const s = setup(true);
  const f = await s.root03.openAt(FOLLOW, "seed.txt", {}, RW);
  assertEq((await f.writeViaStream([new TextEncoder().encode("A")], 0n)).kind, "ok");
  assertEq((await f.appendViaStream([new TextEncoder().encode("B")])).kind, "ok");
  assertEq(Deno.readTextFileSync(`${s.dir}/seed.txt`), "AeedB");
});

Deno.test("fs-readonly 0.3: open-at refuses create/truncate/exclusive and write", async () => {
  const { root03 } = setup(false);
  assertReadOnly03(() => root03.openAt(FOLLOW, "new.txt", { create: true }, READ));
  assertReadOnly03(() => root03.openAt(FOLLOW, "seed.txt", { truncate: true }, READ));
  assertReadOnly03(() => root03.openAt(FOLLOW, "new.txt", { exclusive: true }, READ));
  assertReadOnly03(() => root03.openAt(FOLLOW, "seed.txt", {}, RW));
  assertEq((await root03.statAt(FOLLOW, "seed.txt")).type, "regular-file");
});

// --- flags tell the truth ---------------------------------------------------------

Deno.test("fs-readonly: preopen descriptors advertise no write/mutate-directory", () => {
  const ro = setup(false);
  for (const flags of [ro.root02.getFlags(), ro.root03.getFlags()]) {
    assertTrue(flags.read, "read-only preopens are still readable");
    assertTrue(!flags.write, "read-only preopen must not advertise write");
    assertTrue(!flags.mutateDirectory, "read-only preopen must not advertise mutate-directory");
  }
  const rw = setup(true);
  for (const flags of [rw.root02.getFlags(), rw.root03.getFlags()]) {
    assertTrue(flags.read && flags.write && flags.mutateDirectory, "writable preopen: rw+mutate");
  }
});

Deno.test("fs-readonly: get-flags on an opened descriptor tells the same story", () => {
  const ro = setup(false);
  // The only opens a read-only package allows are read-only ones, so the
  // flags it hands back can never carry write.
  const f = ro.root02.openAt(FOLLOW, "seed.txt", {}, READ);
  const flags = f.getFlags();
  assertTrue(flags.read && !flags.write && !flags.mutateDirectory, "read-only open: read only");

  const rw = setup(true);
  const g = rw.root02.openAt(FOLLOW, "seed.txt", {}, RW);
  assertTrue(g.getFlags().write, "writable open advertises write");
});

// --- the motivating scenario: no bridging via the two-descriptor ops ---------------

Deno.test("fs-readonly: link-at/rename-at/symlink-at bridge nowhere by default", () => {
  const { root02, dir } = setup(false); // default grant is read-only
  const sub = root02.openAt(FOLLOW, "sub", { directory: true }, READ);
  // Every combination of source/destination descriptor: both ends refuse,
  // so there is no "writable cell" to reach from a read-only one.
  const pairs = [[root02, root02], [root02, sub], [sub, root02], [sub, sub]] as [D02, D02][];
  for (const [a, b] of pairs) {
    assertReadOnly02(() => a.renameAt("seed.txt", b, "moved.txt"));
    assertReadOnly02(() => a.linkAt({}, "seed.txt", b, "linked.txt"));
  }
  assertReadOnly02(() => root02.symlinkAt("/etc/passwd", "escape"));
  // Nothing was created, moved, or removed.
  const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
  assertEq(names.join(","), "empty,other.txt,seed.txt,sub");
  assertEq([...Deno.readDirSync(`${dir}/sub`)].length, 0);
});

// --- per-descriptor flags: the enforcement that is NOT the global grant ------------
//
// Independent of `writable`, a descriptor that was not opened with the
// right flag is refused — and the CODE depends on the descriptor kind
// (fs_provider.ts header). For directories the WIT dictates it: of
// `mutate-directory`, "When this flag is unset on a descriptor,
// operations using the descriptor which would create, rename, delete,
// modify the data or metadata of filesystem objects, or obtain another
// handle which would permit any of those, shall fail with
// `error-code::read-only` if they would otherwise succeed." For files
// the WIT is silent and we answer `bad-descriptor` (POSIX EBADF).
// Before this track the directory-mutating ops answered `bad-descriptor`
// too, contradicting that sentence.

const DIR_FLAG_LEAVES: [string, (root: D02, ro: D02) => unknown][] = [
  ["create-directory-at", (_r, ro) => ro.createDirectoryAt("made")],
  ["remove-directory-at", (_r, ro) => ro.removeDirectoryAt("nested")],
  ["unlink-file-at", (_r, ro) => ro.unlinkFileAt("inner.txt")],
  ["set-times-at", (_r, ro) => ro.setTimesAt(FOLLOW, "inner.txt", NOW, NOW)],
  ["symlink-at", (_r, ro) => ro.symlinkAt("inner.txt", "alias")],
  ["rename-at (source side)", (root, ro) => ro.renameAt("inner.txt", root, "pulled.txt")],
  ["rename-at (destination side)", (root, ro) => root.renameAt("seed.txt", ro, "pushed.txt")],
  ["link-at (source side)", (root, ro) => ro.linkAt({}, "inner.txt", root, "pulled.txt")],
  ["link-at (destination side)", (root, ro) => root.linkAt({}, "seed.txt", ro, "pushed.txt")],
];

/** Seed `sub` with the targets DIR_FLAG_LEAVES names, then open it with
 * `df` — a writable package, so only descriptor flags can refuse. */
function subDescriptor(df: Flags): { root02: D02; sub: D02; dir: string } {
  const { root02, dir } = setup(true);
  Deno.writeTextFileSync(`${dir}/sub/inner.txt`, "inner");
  Deno.mkdirSync(`${dir}/sub/nested`);
  return { root02, sub: root02.openAt(FOLLOW, "sub", { directory: true }, df), dir };
}

for (const [name, op] of DIR_FLAG_LEAVES) {
  Deno.test(`fs-descriptor-flags 0.2: ${name} refuses a non-mutating descriptor`, () => {
    const { root02, sub } = subDescriptor(READ);
    assertEq(payload(() => op(root02, sub)), "read-only");
  });
  // The residual of #194: `write` alone is NOT mutate-directory. A
  // descriptor opened read+write on a DIRECTORY still may not mutate its
  // contents — "This may only be set on directories" cuts both ways.
  Deno.test(`fs-descriptor-flags 0.2: ${name} refuses a write-but-not-mutate directory`, () => {
    const { root02, sub } = subDescriptor(RW);
    assertEq(payload(() => op(root02, sub)), "read-only");
  });
}

Deno.test("fs-descriptor-flags 0.2: a mutate-directory descriptor still works", () => {
  const { root02, dir } = setup(true);
  Deno.writeTextFileSync(`${dir}/sub/inner.txt`, "inner");
  const rw = root02.openAt(FOLLOW, "sub", { directory: true }, {
    read: true,
    mutateDirectory: true,
  });
  rw.createDirectoryAt("made");
  rw.unlinkFileAt("inner.txt");
  assertEq([...Deno.readDirSync(`${dir}/sub`)].map((e) => e.name).join(","), "made");
});

// --- open-at escalation: "obtain another handle which would permit any of those" ---

Deno.test("fs-descriptor-flags 0.2: open-at refuses to escalate through a read-only dir", () => {
  const { root02, dir } = setup(true); // writable package: only flags can refuse
  Deno.writeTextFileSync(`${dir}/sub/inner.txt`, "inner");
  Deno.mkdirSync(`${dir}/sub/nested`);
  const ro = root02.openAt(FOLLOW, "sub", { directory: true }, READ);
  assertEq(payload(() => ro.openAt(FOLLOW, "inner.txt", {}, RW)), "read-only");
  assertEq(
    payload(() => ro.openAt(FOLLOW, "nested", { directory: true }, {
      read: true,
      mutateDirectory: true,
    })),
    "read-only",
  );
  assertEq(payload(() => ro.openAt(FOLLOW, "new.txt", { create: true }, READ)), "read-only");
  assertEq(payload(() => ro.openAt(FOLLOW, "inner.txt", { truncate: true }, READ)), "read-only");
  assertEq(payload(() => ro.openAt(FOLLOW, "new.txt", { exclusive: true }, READ)), "read-only");
  // Plain reads through the same descriptor stay allowed.
  assertEq(ro.openAt(FOLLOW, "inner.txt", {}, READ).getType(), "regular-file");
  assertEq(ro.openAt(FOLLOW, "nested", { directory: true }, READ).getType(), "directory");
});

Deno.test("fs-descriptor-flags 0.2: a mutate-directory child is not escalation-blocked", () => {
  const { root02, dir } = setup(true);
  Deno.writeTextFileSync(`${dir}/sub/inner.txt`, "inner");
  const rw = root02.openAt(FOLLOW, "sub", { directory: true }, {
    read: true,
    mutateDirectory: true,
  });
  assertEq(rw.openAt(FOLLOW, "inner.txt", {}, RW).getType(), "regular-file");
  rw.openAt(FOLLOW, "fresh.txt", { create: true }, RW);
  rw.createDirectoryAt("made");
  assertTrue(Deno.statSync(`${dir}/sub/made`).isDirectory, "the child dir was created");
});

// --- set-times: the type dispatch -------------------------------------------------

Deno.test("fs-descriptor-flags 0.2: set-times splits by descriptor kind", () => {
  const { root02, dir } = setup(true);
  Deno.writeTextFileSync(`${dir}/sub/inner.txt`, "inner");
  const roDir = root02.openAt(FOLLOW, "sub", { directory: true }, READ);
  assertEq(payload(() => roDir.setTimes(NOW, NOW)), "read-only");
  const roFile = root02.openAt(FOLLOW, "seed.txt", {}, READ);
  assertEq(payload(() => roFile.setTimes(NOW, NOW)), "bad-descriptor");
  root02.openAt(FOLLOW, "seed.txt", {}, RW).setTimes(NOW, NOW); // no throw
});

// --- kind before permission: a path-op through a FILE is not-directory ------------

Deno.test("fs-descriptor-flags 0.2: path ops on a file descriptor say not-directory", () => {
  const { root02 } = setup(true);
  const f = root02.openAt(FOLLOW, "seed.txt", {}, READ);
  assertEq(payload(() => f.createDirectoryAt("made")), "not-directory");
  assertEq(payload(() => f.unlinkFileAt("other.txt")), "not-directory");
  // Two-descriptor op, wrong-kind DESTINATION: still not-directory, and
  // reported before any permission verdict.
  assertEq(payload(() => root02.renameAt("seed.txt", f, "moved.txt")), "not-directory");
});

Deno.test("fs-descriptor-flags 0.2: a write-only file descriptor still writes", () => {
  const { root02, dir } = setup(true);
  const f = root02.openAt(FOLLOW, "seed.txt", {}, { write: true });
  assertEq(f.write(new TextEncoder().encode("X"), 0n), 1n);
  f.setSize(1n);
  assertEq(Deno.readTextFileSync(`${dir}/seed.txt`), "X");
});

// --- 0.3: the per-descriptor layer is the same code, spot-checked -----------------

Deno.test("fs-descriptor-flags 0.3: the same refusals, variant-shaped", async () => {
  const { root03, dir } = setup(true);
  Deno.writeTextFileSync(`${dir}/sub/inner.txt`, "inner");
  const ro = (await root03.openAt(FOLLOW, "sub", { directory: true }, READ)) as D03;
  assertReadOnly03(() => ro.createDirectoryAt("made"));
  assertReadOnly03(() => ro.openAt(FOLLOW, "inner.txt", {}, RW));
  // set-times dispatch: directory -> read-only, file -> bad-descriptor.
  assertReadOnly03(() => ro.setTimes(NOW, NOW));
  const roFile = (await root03.openAt(FOLLOW, "seed.txt", {}, READ)) as D03;
  assertEq((payload(() => roFile.setTimes(NOW, NOW)) as { kind: string }).kind, "bad-descriptor");
});

// --- the async backend inherits the same refusals ---------------------------------

function setupWeb(writable: boolean): { root02: D02; root03: D03; fake: FakeDirectoryHandle } {
  const fake = new FakeDirectoryHandle("");
  const { imports } = filesystemWeb({ preopens: { "/": fake }, writable });
  const [[root02]] = (imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): [D02, string][];
  }).getDirectories();
  const [[root03]] = (imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [D03, string][];
  }).getDirectories();
  return { root02, root03, fake };
}

Deno.test("fs-readonly (web backend): refusals come from the provider", async () => {
  const { root02, root03 } = setupWeb(false);
  // 0.2 on an async backend: the methods are suspending-marked, so the
  // refusal surfaces as a rejection rather than a throw.
  assertEq(
    await rejectedPayload(() => root02.openAt(FOLLOW, "x.txt", { create: true }, RW)),
    "read-only",
  );
  assertEq(await rejectedPayload(() => root02.createDirectoryAt("d")), "read-only");
  assertEq(await rejectedPayload(() => root02.unlinkFileAt("x.txt")), "read-only");
  assertEq(
    ((await rejectedPayload(() => root03.createDirectoryAt("d"))) as { kind: string }).kind,
    "read-only",
  );
  assertTrue(!root02.getFlags().write, "web preopen: no write when read-only");
});

Deno.test("fs-readonly (web backend): writable: true restores the writes", async () => {
  const { root02, fake } = setupWeb(true);
  const f = await (root02.openAt(FOLLOW, "x.txt", { create: true }, RW) as unknown as Promise<D02>);
  assertEq(await (f.write(new TextEncoder().encode("hi"), 0n) as unknown as Promise<bigint>), 2n);
  assertTrue((await fake.getFileHandle("x.txt")) !== undefined, "the file exists");
});
