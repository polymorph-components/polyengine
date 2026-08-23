// The web (OPFS) backend of wasi:filesystem (filesystem_web.ts +
// fs_provider.ts), against the in-memory fake (tests/support/opfs_fake.ts
// — Deno has no `navigator.storage.getDirectory`; the REAL OPFS runs in
// the OPFS smoke, `just smoke-opfs` / tools/browser/opfs-smoke.ts).
// Direct calls on the WIT-facing surface.
//
// The load-bearing assertions, mirror-image of fs_node_test.ts:
//   * PARKING: the 0.2 descriptor methods are `suspending`-marked (A14 —
//     the per-call prototype carries the brand) and genuinely return
//     promises; the streams from read/write-via-stream are the io.ts
//     async-backed classes whose blocking ops park.
//   * ERROR SHAPES: 0.2 bare enum strings; 0.3 `{kind}` variants.
//   * OPFS honesty: set-times/link/symlink fail `unsupported`; rename
//     without `move()` falls back to copy+delete for files and fails
//     `unsupported` for directories.

import { ComponentException, isSuspending } from "@polyengine/protocol";
import { filesystemWeb } from "../src/filesystem_web.ts";
import { FakeDirectoryHandle } from "./support/opfs_fake.ts";
import { assertEq, assertRejects, assertTrue } from "./asserts.ts";

type Flags = Record<string, boolean>;
interface Stat {
  type: string;
  linkCount: bigint;
  size: bigint;
  dataModificationTimestamp?: { seconds: bigint; nanoseconds: number };
}
interface InStream02 {
  read(len: bigint): Uint8Array;
  blockingRead(len: bigint): Uint8Array | Promise<Uint8Array>;
  subscribe(): { ready(): boolean };
}
interface OutStream02 {
  write(b: Uint8Array): void;
  blockingFlush(): void | Promise<void>;
}
interface D02 {
  getType(): string;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): Promise<D02>;
  read(len: bigint, off: bigint): Promise<[Uint8Array, boolean]>;
  write(buf: Uint8Array, off: bigint): Promise<bigint>;
  stat(): Promise<Stat>;
  statAt(pf: Flags, path: string): Promise<Stat>;
  readViaStream(off: bigint): InStream02;
  writeViaStream(off: bigint): OutStream02;
  readDirectory(): Promise<{ readDirectoryEntry(): { name: string } | undefined }>;
  createDirectoryAt(p: string): Promise<void>;
  removeDirectoryAt(p: string): Promise<void>;
  unlinkFileAt(p: string): Promise<void>;
  renameAt(o: string, d: D02, n: string): Promise<void>;
  symlinkAt(t: string, p: string): Promise<void>;
  setTimes(a: unknown, m: unknown): Promise<void>;
  setSize(n: bigint): Promise<void>;
  isSameObject(o: D02): Promise<boolean>;
  metadataHash(): Promise<{ lower: bigint; upper: bigint }>;
}
interface D03 {
  openAt(pf: Flags, path: string, of: Flags, df: Flags): Promise<D03>;
  statAt(pf: Flags, path: string): Promise<Stat>;
  readViaStream(off: bigint): [AsyncIterable<Uint8Array>, Promise<{ kind: string }>];
  writeViaStream(data: unknown, off: bigint): Promise<{ kind: string; value?: { kind: string } }>;
}

const FOLLOW: Flags = { symlinkFollow: true };
const RW: Flags = { read: true, write: true };

function setup(): { root02: D02; root03: D03; fake: FakeDirectoryHandle } {
  const fake = new FakeDirectoryHandle("");
  const { imports } = filesystemWeb({ preopens: { "/": fake }, writable: true });
  const [[root02]] = (imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): [D02, string][];
  }).getDirectories();
  const [[root03]] = (imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [D03, string][];
  }).getDirectories();
  return { root02, root03, fake };
}

async function rejectedPayload(f: () => unknown): Promise<unknown> {
  const e = await assertRejects(f);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException).payload;
}

Deno.test("fs-web: 0.2 descriptor methods carry the A14 suspending marks", () => {
  const { root02 } = setup();
  const proto = Object.getPrototypeOf(root02) as Record<string, unknown>;
  for (const name of ["openAt", "stat", "statAt", "read", "write", "readDirectory"]) {
    assertTrue(isSuspending(proto[name]), `${name} must be suspending-marked`);
  }
  // The node backend's prototype must NOT be marked (callback-mode pin) —
  // covered in spirit by fs_node_test's plain-value assertions; here we
  // pin that getType (wrapper state, never backend-touching) stays plain.
  assertTrue(!isSuspending(proto.getType), "getType stays unmarked");
});

Deno.test("fs-web 0.2: open/write/read, parking path", async () => {
  const { root02, fake } = setup();
  const f = await root02.openAt(FOLLOW, "hello.txt", { create: true }, RW);
  assertEq(f.getType(), "regular-file");
  const data = new TextEncoder().encode("opfs bytes");
  assertEq(await f.write(data, 0n), BigInt(data.length));
  const [bytes, eof] = await f.read(64n, 0n);
  assertEq(new TextDecoder().decode(bytes), "opfs bytes");
  assertEq(eof, false);
  const [, eof2] = await f.read(8n, BigInt(data.length));
  assertEq(eof2, true);
  const st = await f.stat();
  assertEq(st.type, "regular-file");
  assertEq(st.size, BigInt(data.length));
  assertTrue(st.dataModificationTimestamp !== undefined, "mtime from File.lastModified");
  await f.setSize(4n);
  assertEq((await f.stat()).size, 4n);
  // Committed to the fake's backing store, not a shadow copy.
  const committed = (await (await fake.getFileHandle("hello.txt")).getFile()).size;
  assertEq(committed, 4);
});

Deno.test("fs-web 0.2: async-backed via-streams (blocking ops park)", async () => {
  const { root02 } = setup();
  const f = await root02.openAt(FOLLOW, "s.txt", { create: true }, RW);
  const out = f.writeViaStream(0n);
  out.write(new TextEncoder().encode("abcdef"));
  await out.blockingFlush(); // parks until the sink committed

  const src = f.readViaStream(0n);
  const first = await src.blockingRead(6n); // parks until the feed delivers
  assertEq(new TextDecoder().decode(first), "abcdef");
  // Feed hits EOF; drained stream closes.
  const closed = await assertRejects(async () => {
    for (;;) {
      const r = await src.blockingRead(8n);
      if (r.length === 0) continue;
    }
  });
  assertEq(((closed as ComponentException).payload as { kind: string }).kind, "closed");
});

Deno.test("fs-web: error shapes per track; unsupported families", async () => {
  const { root02, root03 } = setup();
  assertEq(await rejectedPayload(() => root02.statAt(FOLLOW, "missing")), "no-entry");
  assertEq(
    ((await rejectedPayload(() => root03.statAt(FOLLOW, "missing"))) as { kind: string }).kind,
    "no-entry",
  );
  assertEq(await rejectedPayload(() => root02.setTimes({ kind: "now" }, { kind: "now" })), "unsupported");
  assertEq(await rejectedPayload(() => root02.symlinkAt("a", "b")), "unsupported");
});

Deno.test("fs-web 0.2: directories, exclusive create, rename fallback", async () => {
  const { root02 } = setup();
  await root02.createDirectoryAt("d");
  assertEq(await rejectedPayload(() => root02.createDirectoryAt("d")), "exist");
  const f = await root02.openAt(FOLLOW, "d/x.txt", { create: true }, RW);
  await f.write(new Uint8Array([7, 8, 9]), 0n);
  assertEq(
    await rejectedPayload(() => root02.openAt(FOLLOW, "d/x.txt", { create: true, exclusive: true }, RW)),
    "exist",
  );
  assertEq(await rejectedPayload(() => root02.removeDirectoryAt("d")), "not-empty");

  // No move() on the fake: file rename takes the copy+delete fallback...
  await root02.renameAt("d/x.txt", root02, "y.txt");
  assertEq((await root02.statAt(FOLLOW, "y.txt")).size, 3n);
  assertEq(await rejectedPayload(() => root02.statAt(FOLLOW, "d/x.txt")), "no-entry");
  // ...and directory rename is honestly unsupported.
  assertEq(await rejectedPayload(() => root02.renameAt("d", root02, "e")), "unsupported");

  const listing = await root02.readDirectory();
  const names: string[] = [];
  for (let e = listing.readDirectoryEntry(); e !== undefined; e = listing.readDirectoryEntry()) {
    names.push(e.name);
  }
  assertEq(names.sort().join(","), "d,y.txt");
});

Deno.test("fs-web: identity is path-derived; is-same-object via isSameEntry", async () => {
  const { root02 } = setup();
  await root02.openAt(FOLLOW, "a.txt", { create: true }, RW);
  const a1 = await root02.openAt(FOLLOW, "a.txt", {}, { read: true });
  const a2 = await root02.openAt(FOLLOW, "a.txt", {}, { read: true });
  assertEq(await a1.isSameObject(a2), true);
  assertEq(await a1.isSameObject(root02), false);
  const h1 = await a1.metadataHash();
  const h2 = await a2.metadataHash();
  assertTrue(h1.lower === h2.lower && h1.upper === h2.upper, "same path, same hash");
});

Deno.test("fs-web 0.3: write-via-stream commits through the fake", async () => {
  const { root03, fake } = setup();
  const f = await root03.openAt(FOLLOW, "w.bin", { create: true }, RW);
  const result = await f.writeViaStream(
    (async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    })(),
    0n,
  );
  assertEq(result.kind, "ok");
  const [source, done] = f.readViaStream(0n);
  let total = 0;
  for await (const c of source) total += c.length;
  assertEq(total, 3);
  assertEq((await done).kind, "ok");
  assertEq((await (await fake.getFileHandle("w.bin")).getFile()).size, 3);
});
