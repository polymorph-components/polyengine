// The node backend of wasi:filesystem (filesystem_node.ts +
// fs_provider.ts), against a real tempdir through node:fs (Deno's node
// compat serves the builtin — the same backend runs on real Node via the
// pinned-Node smoke). Direct calls on the WIT-facing resource surface;
// the lift/lower path is covered by the fs-probe integration fixture.
//
// The load-bearing assertions:
//   * SYNC-NESS: every 0.2 descriptor method returns a PLAIN value (the
//     node backend's callback-mode guarantee — no parking, no JSPI).
//   * ERROR SHAPES: 0.2 err payloads are BARE enum strings ("no-entry");
//     0.3 payloads are variant records ({ kind: "no-entry" }).

import { ComponentException } from "@polyengine/protocol";
import { filesystemNode } from "../src/filesystem_node.ts";
import { FsIoError } from "../src/internal/fs_provider.ts";
import { assertEq, assertThrows, assertTrue } from "./asserts.ts";

// --- structural views of the per-call resource classes -----------------------------

type Flags = Record<string, boolean>;
interface Stat {
  type: string;
  linkCount: bigint;
  size: bigint;
  dataAccessTimestamp?: { seconds: bigint; nanoseconds: number };
  dataModificationTimestamp?: { seconds: bigint; nanoseconds: number };
}
interface Hash {
  lower: bigint;
  upper: bigint;
}
interface InStream02 {
  read(len: bigint): Uint8Array;
  blockingRead(len: bigint): Uint8Array;
}
interface OutStream02 {
  checkWrite(): bigint;
  write(b: Uint8Array): void;
  blockingFlush(): void;
}
interface DirStream02 {
  readDirectoryEntry(): { type: string; name: string } | undefined;
}
interface D02 {
  getType(): string;
  getFlags(): Flags;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): D02;
  read(len: bigint, off: bigint): [Uint8Array, boolean];
  write(buf: Uint8Array, off: bigint): bigint;
  stat(): Stat;
  statAt(pf: Flags, path: string): Stat;
  readViaStream(off: bigint): InStream02;
  writeViaStream(off: bigint): OutStream02;
  appendViaStream(): OutStream02;
  readDirectory(): DirStream02;
  createDirectoryAt(p: string): void;
  removeDirectoryAt(p: string): void;
  unlinkFileAt(p: string): void;
  renameAt(o: string, d: D02, n: string): void;
  linkAt(pf: Flags, o: string, d: D02, n: string): void;
  symlinkAt(t: string, p: string): void;
  readlinkAt(p: string): string;
  setSize(n: bigint): void;
  setTimes(a: unknown, m: unknown): void;
  sync(): void;
  syncData(): void;
  isSameObject(o: D02): boolean;
  metadataHash(): Hash;
  metadataHashAt(pf: Flags, p: string): Hash;
}
interface D03 {
  getType(): string;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): D03 | Promise<D03>;
  stat(): Stat | Promise<Stat>;
  statAt(pf: Flags, path: string): Stat | Promise<Stat>;
  readViaStream(
    off: bigint,
  ): [AsyncIterable<Uint8Array>, Promise<{ kind: string; value?: { kind: string } }>];
  writeViaStream(
    data: unknown,
    off: bigint,
  ): Promise<{ kind: string; value?: { kind: string } }>;
  appendViaStream(data: unknown): Promise<{ kind: string; value?: { kind: string } }>;
  readDirectory():
    | [Iterable<{ type: string; name: string }>, Promise<{ kind: string }>]
    | Promise<[Iterable<{ type: string; name: string }>, Promise<{ kind: string }>]>;
}

const FOLLOW: Flags = { symlinkFollow: true };
const NOFOLLOW: Flags = {};
const RW: Flags = { read: true, write: true };

function setup(): { root02: D02; root03: D03; dir: string } {
  const dir = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-node-" });
  const { imports } = filesystemNode({ preopens: { "/": dir }, writable: true });
  const p02 = imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): [D02, string][];
  };
  const p03 = imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [D03, string][];
  };
  const [[root02, name02]] = p02.getDirectories();
  const [[root03, name03]] = p03.getDirectories();
  assertEq(name02, "/");
  assertEq(name03, "/");
  return { root02, root03, dir };
}

/** The callback-mode guarantee: a plain value, not a thenable. */
function plain<T>(v: T, what: string): T {
  assertTrue(!(v instanceof Promise), `${what}: expected a plain (sync) value`);
  return v;
}

function errPayload(f: () => unknown): unknown {
  const e = assertThrows(f);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException).payload;
}

Deno.test("fs-node: preopens serve both tracks; flags reflect the grant", () => {
  const { root02, root03 } = setup();
  assertEq(plain(root02.getType(), "get-type"), "directory");
  assertEq(root03.getType(), "directory");
  const flags = root02.getFlags();
  assertTrue(flags.read && flags.write && flags.mutateDirectory, "preopen rw+mutate");
});

Deno.test("fs-node 0.2: open/write/read positional, sync throughout", () => {
  const { root02 } = setup();
  const f = plain(
    root02.openAt(FOLLOW, "hello.txt", { create: true }, RW),
    "open-at",
  );
  assertEq(f.getType(), "regular-file");
  const data = new TextEncoder().encode("hello filesystem");
  assertEq(plain(f.write(data, 0n), "write"), BigInt(data.length));
  const [bytes, eof] = plain(f.read(1024n, 0n), "read");
  assertEq(new TextDecoder().decode(bytes), "hello filesystem");
  assertEq(eof, false); // bytes came back with the read
  const [empty, eof2] = f.read(16n, BigInt(data.length));
  assertEq(empty.length, 0);
  assertEq(eof2, true);
  const st = plain(f.stat(), "stat");
  assertEq(st.type, "regular-file");
  assertEq(st.size, BigInt(data.length));
  assertTrue(st.dataModificationTimestamp !== undefined, "mtime reported");
  f.setSize(5n);
  assertEq((f.stat() as Stat).size, 5n);
});

Deno.test("fs-node 0.2: via-stream read/write/append (sync streams)", () => {
  const { root02 } = setup();
  const f = root02.openAt(FOLLOW, "s.txt", { create: true }, RW);
  const out = plain(f.writeViaStream(0n), "write-via-stream");
  assertTrue(out.checkWrite() > 0n, "permit");
  out.write(new TextEncoder().encode("abcdef"));
  plain(out.blockingFlush(), "blocking-flush");
  const app = f.appendViaStream();
  app.write(new TextEncoder().encode("-tail"));

  const src = plain(f.readViaStream(2n), "read-via-stream"); // offset 2
  assertEq(new TextDecoder().decode(plain(src.blockingRead(4n), "blocking-read")), "cdef");
  assertEq(new TextDecoder().decode(src.read(64n)), "-tail");
  // Drained + EOF = the `closed` stream-error.
  const closed = errPayload(() => src.read(1n));
  assertEq((closed as { kind: string }).kind, "closed");
});

Deno.test("fs-node 0.2: error payloads are BARE enum strings", () => {
  const { root02 } = setup();
  assertEq(errPayload(() => root02.statAt(FOLLOW, "missing")), "no-entry");
  assertEq(errPayload(() => root02.openAt(FOLLOW, "/etc/passwd", {}, RW)), "not-permitted");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "../escape")), "not-permitted");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "a\0b")), "invalid");
  // ".." that stays inside resolves textually.
  root02.createDirectoryAt("sub");
  const st = root02.statAt(FOLLOW, "sub/../sub");
  assertEq(st.type, "directory");
});

Deno.test("fs-node 0.2: directory ops + listing", () => {
  const { root02 } = setup();
  root02.createDirectoryAt("d");
  const f = root02.openAt(FOLLOW, "d/x.txt", { create: true }, RW);
  f.write(new Uint8Array([1, 2, 3]), 0n);
  const d = root02.openAt(FOLLOW, "d", { directory: true }, { read: true, mutateDirectory: true });
  const listing = plain(d.readDirectory(), "read-directory");
  const first = listing.readDirectoryEntry();
  assertEq(first?.name, "x.txt");
  assertEq(first?.type, "regular-file");
  assertEq(listing.readDirectoryEntry(), undefined);

  assertEq(errPayload(() => root02.removeDirectoryAt("d")), "not-empty");
  root02.renameAt("d/x.txt", root02, "y.txt");
  root02.removeDirectoryAt("d");
  root02.unlinkFileAt("y.txt");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "y.txt")), "no-entry");
});

Deno.test("fs-node 0.2: symlinks, follow vs nofollow, readlink", () => {
  const { root02 } = setup();
  const f = root02.openAt(FOLLOW, "target.txt", { create: true }, RW);
  f.write(new TextEncoder().encode("x"), 0n);
  root02.symlinkAt("target.txt", "link");
  assertEq(root02.readlinkAt("link"), "target.txt");
  assertEq(root02.statAt(FOLLOW, "link").type, "regular-file");
  assertEq(root02.statAt(NOFOLLOW, "link").type, "symbolic-link");
});

Deno.test("fs-node 0.2: identity — metadata-hash and is-same-object", () => {
  const { root02 } = setup();
  root02.openAt(FOLLOW, "a.txt", { create: true }, RW);
  root02.openAt(FOLLOW, "b.txt", { create: true }, RW);
  const a1 = root02.openAt(FOLLOW, "a.txt", {}, { read: true });
  const a2 = root02.openAt(FOLLOW, "a.txt", {}, { read: true });
  const b = root02.openAt(FOLLOW, "b.txt", {}, { read: true });
  assertEq(plain(a1.isSameObject(a2), "is-same-object"), true);
  assertEq(a1.isSameObject(b), false);
  const h1 = plain(a1.metadataHash(), "metadata-hash");
  const h2 = a2.metadataHash();
  assertTrue(h1.lower === h2.lower && h1.upper === h2.upper, "same object, same hash");
  const hb = b.metadataHash();
  assertTrue(h1.lower !== hb.lower || h1.upper !== hb.upper, "different objects differ");
  const hAt = root02.metadataHashAt(FOLLOW, "a.txt");
  assertEq(hAt.lower, h1.lower);
});

Deno.test("fs-node 0.3: stream tuples and variant error shapes", async () => {
  const { root03 } = setup();
  const f = await root03.openAt(FOLLOW, "three.txt", { create: true }, RW);

  // write-via-stream: the promise IS the future (embedder-api.md §"Streams
  // and futures").
  const wrote = await f.writeViaStream(
    (async function* () {
      yield new TextEncoder().encode("stream");
      yield new TextEncoder().encode("-payload");
    })(),
    0n,
  );
  assertEq(wrote.kind, "ok");
  await f.appendViaStream((async function* () {
    yield new TextEncoder().encode("!");
  })());

  // read-via-stream: tuple<stream<u8>, future<result<_, error-code>>>.
  const [source, done] = f.readViaStream(0n);
  const chunks: Uint8Array[] = [];
  for await (const c of source) chunks.push(c);
  const text = new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((c) => [...c])),
  );
  assertEq(text, "stream-payload!");
  assertEq((await done).kind, "ok");

  // read-directory: tuple<stream<directory-entry>, future<...>>.
  const [entries, listDone] = await root03.readDirectory();
  assertEq([...entries].filter((e) => e.name === "three.txt").length, 1);
  assertEq((await listDone).kind, "ok");

  // 0.3 err payloads are VARIANT records.
  try {
    await root03.statAt(FOLLOW, "missing");
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
    assertEq(((e as ComponentException).payload as { kind: string }).kind, "no-entry");
  }
});

Deno.test("fs-node: filesystem-error-code downcasts our stream errors only", () => {
  const { imports } = filesystemNode({
    preopens: { "/": Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-node-" }) },
  });
  const types = imports["wasi:filesystem/types@0.2"] as {
    filesystemErrorCode(err: unknown): string | undefined;
  };
  assertEq(types.filesystemErrorCode(new FsIoError("no-entry", "gone")), "no-entry");
  assertEq(types.filesystemErrorCode(new Error("random")), undefined);
});

// --- symlink confinement (issue #177) ---------------------------------------------
//
// The guest can create symlinks itself, so "don't preopen trees with
// adversarial symlinks" was never a sufficient mitigation. These verify
// the node backend refuses to resolve ANY path — guest-made or not —
// that lands outside the preopen's realpath root, with `not-permitted`.

Deno.test("fs-node: rejects opening through a guest-created absolute symlink", () => {
  const { root02 } = setup();
  root02.symlinkAt("/etc", "escape"); // creation itself stays permissive
  assertEq(root02.readlinkAt("escape"), "/etc");
  // follow=true: the chain resolves outside the root.
  assertEq(errPayload(() => root02.openAt(FOLLOW, "escape/passwd", {}, { read: true })), "not-permitted");
  assertEq(errPayload(() => root02.openAt(FOLLOW, "escape", {}, { read: true })), "not-permitted");
  // follow=false: the final component is refused as a symlink (ELOOP), and
  // an intermediate escaping component is refused outright.
  assertEq(errPayload(() => root02.openAt(NOFOLLOW, "escape", {}, { read: true })), "loop");
  assertEq(
    errPayload(() => root02.openAt(NOFOLLOW, "escape/passwd", {}, { read: true })),
    "not-permitted",
  );
});

Deno.test("fs-node: rejects writes and creation through an escaping symlink", () => {
  const { root02, dir } = setup();
  const outside = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-outside-" });
  root02.symlinkAt(outside, "out");
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "out/new.txt", { create: true }, RW)),
    "not-permitted",
  );
  assertEq(errPayload(() => root02.createDirectoryAt("out/d")), "not-permitted");
  assertEq(errPayload(() => root02.unlinkFileAt("out/x")), "not-permitted");
  assertEq(errPayload(() => root02.renameAt("out/x", root02, "y")), "not-permitted");
  assertEq(errPayload(() => root02.symlinkAt("t", "out/l")), "not-permitted");
  assertTrue([...Deno.readDirSync(outside)].length === 0, "nothing was created outside");
  // A dangling escaping link is refused too (create must not reach out).
  root02.symlinkAt(`${outside}/gone/x`, "dangling");
  // Containment is decided before existence, so a dangling ESCAPING
  // target is refused as an escape and never reports whether the
  // outside path exists.
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "dangling", { create: true }, RW)),
    "not-permitted",
  );
  assertTrue(dir.length > 0, "sandbox dir named");
});

Deno.test("fs-node: confines but permits symlinks resolving inside the sandbox", () => {
  const { root02 } = setup();
  root02.createDirectoryAt("real");
  const f = root02.openAt(FOLLOW, "real/data.txt", { create: true }, RW);
  f.write(new TextEncoder().encode("inside"), 0n);
  root02.symlinkAt("real", "alias"); // relative, stays inside
  root02.symlinkAt("./real/data.txt", "afile");
  assertEq(root02.statAt(FOLLOW, "alias").type, "directory");
  assertEq(root02.statAt(FOLLOW, "afile").type, "regular-file");
  const via = root02.openAt(FOLLOW, "alias/data.txt", {}, { read: true });
  assertEq(new TextDecoder().decode(via.read(64n, 0n)[0]), "inside");
  const d = root02.openAt(FOLLOW, "alias", { directory: true }, { read: true });
  assertEq(d.readDirectory().readDirectoryEntry()?.name, "data.txt");
  // A link that climbs out and back in is still inside.
  root02.symlinkAt("../real", "alias/back");
  assertEq(root02.statAt(FOLLOW, "alias/back").type, "directory");
});

Deno.test("fs-node: rejects opening or descending an escaping directory symlink", () => {
  const { root02 } = setup();
  const outside = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-outside-" });
  Deno.writeTextFileSync(`${outside}/secret.txt`, "secret");
  root02.symlinkAt(outside, "outdir");
  // Directory opens return a path handle before openSync — they get the
  // same containment check, so no handle is ever minted for the escape.
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "outdir", { directory: true }, { read: true })),
    "not-permitted",
  );
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "outdir/secret.txt", {}, { read: true })),
    "not-permitted",
  );
  // ".." laundering through the escaping link is refused as well.
  assertEq(
    errPayload(() => root02.statAt(FOLLOW, "outdir/../outdir/secret.txt")),
    "not-permitted",
  );
});

Deno.test("fs-node: rejects stat/readlink/metadata-hash through an escaping symlink", () => {
  const { root02, root03 } = setup();
  root02.symlinkAt("/etc", "e");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "e/passwd")), "not-permitted");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "e")), "not-permitted");
  assertEq(errPayload(() => root02.metadataHashAt(FOLLOW, "e")), "not-permitted");
  assertEq(errPayload(() => root02.readlinkAt("e/passwd")), "not-permitted");
  // nofollow stat sees the link itself — that entry IS inside the sandbox.
  assertEq(root02.statAt(NOFOLLOW, "e").type, "symbolic-link");
  assertTrue(root03 !== undefined, "0.3 track shares the backend guard");
});

Deno.test("fs-node 0.3: rejects escaping symlink resolution with the variant shape", async () => {
  const { root02, root03 } = setup();
  root02.symlinkAt("/etc", "e");
  try {
    await root03.statAt(FOLLOW, "e/passwd");
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
    assertEq(((e as ComponentException).payload as { kind: string }).kind, "not-permitted");
  }
});

// A symlink TARGET containing ".." is where lexical and physical
// resolution diverge: the kernel walks the preceding component first, so
// `esc/../secret` with `esc` an escaping link lands OUTSIDE, while any
// lexical collapse of `esc/..` lands back inside. Containment must be
// decided by realpath, never by string arithmetic.

Deno.test("fs-node: rejects a '..' chain laundered through an escaping symlink", () => {
  const { root02 } = setup();
  const outside = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-outside-" });
  Deno.mkdirSync(`${outside}/inner`);
  Deno.writeTextFileSync(`${outside}/secret.txt`, "secret payload");
  root02.symlinkAt(`${outside}/inner`, "esc"); // creation stays permissive
  // `esc/..` is the OUTSIDE directory: lexically it collapses back into
  // the sandbox, physically it does not.
  root02.symlinkAt("esc/../secret.txt", "L");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "L")), "not-permitted");
  assertEq(errPayload(() => root02.metadataHashAt(FOLLOW, "L")), "not-permitted");
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "L", {}, { read: true })),
    "not-permitted",
  );
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "L", {}, RW)),
    "not-permitted",
  );
  // Two-path op: link-at DOES follow its old path when asked, so the
  // laundered chain is refused there too.
  assertEq(
    errPayload(() => root02.linkAt(FOLLOW, "L", root02, "hard")),
    "not-permitted",
  );
  // rename-at never follows its final component (POSIX): renaming the
  // link itself stays inside and must keep working — the guard must not
  // over-refuse. The moved entry is still a symlink, not the target.
  root02.renameAt("L", root02, "moved");
  assertEq(root02.statAt(NOFOLLOW, "moved").type, "symbolic-link");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "moved")), "not-permitted");
  // The same shape spelled as a GUEST path is neutralized a layer up:
  // parsePath pops ".." textually, so "esc/../secret.txt" reaches the
  // backend as "secret.txt" and simply is not there. Guest-level ".."
  // can only ever climb the guest-visible tree, never out of it — the
  // hazard was ".." inside symlink TARGETS, which parsePath never sees.
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "esc/../secret.txt", {}, { read: true })),
    "no-entry",
  );
});

Deno.test("fs-node: rejects creating through a dangling '..'-laundered symlink", () => {
  const { root02 } = setup();
  const outside = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-outside-" });
  Deno.mkdirSync(`${outside}/inner`);
  root02.symlinkAt(`${outside}/inner`, "esc");
  root02.symlinkAt("esc/../planted.txt", "D"); // dangles, outside
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "D", { create: true }, RW)),
    "not-permitted",
  );
  assertTrue(
    [...Deno.readDirSync(outside)].every((e) => e.name === "inner"),
    "nothing was planted outside the sandbox",
  );
});

Deno.test("fs-node: confines but permits an in-sandbox '..' link target", () => {
  const { root02 } = setup();
  root02.createDirectoryAt("real");
  root02.createDirectoryAt("sub"); // a REAL directory, not a link
  const f = root02.openAt(FOLLOW, "real/data.txt", { create: true }, RW);
  f.write(new TextEncoder().encode("inside"), 0n);
  root02.symlinkAt("sub/../real", "ok"); // climbs out of a real dir, stays inside
  assertEq(root02.statAt(FOLLOW, "ok").type, "directory");
  const via = root02.openAt(FOLLOW, "ok/data.txt", {}, { read: true });
  assertEq(new TextDecoder().decode(via.read(64n, 0n)[0]), "inside");
  const d = root02.openAt(FOLLOW, "ok", { directory: true }, { read: true });
  assertEq(d.readDirectory().readDirectoryEntry()?.name, "data.txt");
});

Deno.test("fs-node: rejects listing and descending a laundered escaping directory link", () => {
  const { root02 } = setup();
  const outside = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-outside-" });
  Deno.mkdirSync(`${outside}/target`);
  Deno.writeTextFileSync(`${outside}/target/f.txt`, "x");
  root02.symlinkAt(`${outside}/target`, "esc");
  root02.symlinkAt("esc/../target", "LD"); // a DIRECTORY, laundered
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "LD", { directory: true }, { read: true })),
    "not-permitted",
  );
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "LD/f.txt", {}, { read: true })),
    "not-permitted",
  );
  assertEq(errPayload(() => root02.statAt(FOLLOW, "LD/f.txt")), "not-permitted");
});

Deno.test("fs-node: confines symlink targets that are bare '..' components", () => {
  const { root02 } = setup();
  const outside = Deno.makeTempDirSync({ dir: "/tmp", prefix: "polyengine-fs-outside-" });
  Deno.mkdirSync(`${outside}/inner`);
  root02.createDirectoryAt("sub");
  root02.symlinkAt(`${outside}/inner`, "esc");
  // The whole target is a climb: "esc/.." is the outside directory.
  root02.symlinkAt("esc/..", "up");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "up")), "not-permitted");
  assertEq(
    errPayload(() => root02.openAt(FOLLOW, "up", { directory: true }, { read: true })),
    "not-permitted",
  );
  // A climb out of the ROOT is refused (parsePath's underflow rule,
  // applied to link targets).
  root02.symlinkAt("..", "root-up");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "root-up")), "not-permitted");
  // The same shape that stays inside still resolves.
  root02.symlinkAt("sub/..", "self");
  assertEq(root02.statAt(FOLLOW, "self").type, "directory");
  // Multi-hop: a chain of links, each individually inside.
  root02.symlinkAt("self", "hop1");
  root02.symlinkAt("hop1", "hop2");
  assertEq(root02.statAt(FOLLOW, "hop2").type, "directory");
  // Multi-hop ending outside is still caught.
  root02.symlinkAt("up", "hop-out");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "hop-out")), "not-permitted");
});
