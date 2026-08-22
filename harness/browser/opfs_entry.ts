/// <reference lib="dom" />
// In-page OPFS smoke (the browser exercise of the REAL Origin Private
// File System behind @polyengine/wasi/filesystem-web — the unit suite runs
// against an in-memory fake because Deno has no `navigator.storage`;
// THIS is where the real thing is pinned).
//
// Bundled to `harness/browser/dist/opfs_entry.js`, loaded by `opfs.html`,
// driven by `tools/browser/opfs-smoke.ts` via
// `globalThis.__opfsSmoke()`. Two halves:
//
//   1. DIRECT: the 0.2/0.3 descriptor surface called as plain promises
//      against `navigator.storage.getDirectory()` — real createWritable
//      commit-on-close, real isSameEntry, real DOMException error names
//      through the backend's mapper, and the rename path the engine
//      actually has (`move()` on Chromium, the copy+delete fallback on
//      Firefox). No wasm involved, so this half needs no JSPI.
//
//   2. COMPOSED: the fs-probe wasip2 fixture (std::fs through wasi-libc)
//      instantiated with `filesystemWeb` serving a real OPFS preopen —
//      every sync 0.2 descriptor method parks through the A14 suspending
//      marks, so this half is ALSO the browser exercise of the parking
//      kernel over real async storage. Needs JSPI (Chromium default-on;
//      Firefox behind the pref the driver sets).
//
// Every check reports into a result list; the driver asserts and prints.

import { filesystemWeb, type OpfsDirectoryHandle } from "../../wasi/src/filesystem_web.ts";
import { wasi } from "../../wasi/src/mod.ts";
import { Translator } from "@polyengine/runtime/shim";
import { ComponentException, instantiate } from "@polyengine/runtime/embedder";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * JS realm the battery ran in (issue #129, realm neutrality — same
 * vocabulary as `harness/browser/entry.ts`'s `Realm`, kept independent so
 * this file has no import-time dependency on the sibling conformance-lane
 * track).
 */
export type OpfsRealm = "page" | "worker" | "shared-worker";

export interface OpfsSmokeReport {
  userAgent: string;
  renamePath: "move" | "copy-delete" | "unknown";
  /** Which realm actually ran the battery (issue #129). */
  realm: OpfsRealm;
  direct: CheckResult[];
  composed: CheckResult[];
}

// --- structural views of the WIT-facing surface (fs_web_test.ts's shapes) ---------

type Flags = Record<string, boolean>;
interface Stat {
  type: string;
  size: bigint;
  dataModificationTimestamp?: { seconds: bigint; nanoseconds: number };
}
interface D02 {
  getType(): string;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): Promise<D02>;
  read(len: bigint, off: bigint): Promise<[Uint8Array, boolean]>;
  write(buf: Uint8Array, off: bigint): Promise<bigint>;
  stat(): Promise<Stat>;
  statAt(pf: Flags, path: string): Promise<Stat>;
  setSize(n: bigint): Promise<void>;
  setTimes(a: unknown, m: unknown): Promise<void>;
  createDirectoryAt(p: string): Promise<void>;
  removeDirectoryAt(p: string): Promise<void>;
  unlinkFileAt(p: string): Promise<void>;
  renameAt(o: string, d: D02, n: string): Promise<void>;
  readDirectory(): Promise<{ readDirectoryEntry(): { name: string; type: string } | undefined }>;
  isSameObject(o: D02): Promise<boolean>;
  metadataHash(): Promise<{ lower: bigint; upper: bigint }>;
  readViaStream(off: bigint): {
    blockingRead(len: bigint): Uint8Array | Promise<Uint8Array>;
  };
  writeViaStream(off: bigint): {
    write(b: Uint8Array): void;
    blockingFlush(): void | Promise<void>;
  };
}
interface D03 {
  openAt(pf: Flags, path: string, of: Flags, df: Flags): Promise<D03>;
  writeViaStream(data: unknown, off: bigint): Promise<{ kind: string }>;
  readViaStream(off: bigint): [AsyncIterable<Uint8Array>, Promise<{ kind: string }>];
}

const FOLLOW: Flags = { symlinkFollow: true };
const RW: Flags = { read: true, write: true };

function assertEq(actual: unknown, expected: unknown, what: string): void {
  const a = typeof actual === "bigint" ? `${actual}n` : JSON.stringify(actual);
  const e = typeof expected === "bigint" ? `${expected}n` : JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function assertTrue(cond: boolean, what: string): void {
  if (!cond) throw new Error(`${what}: check failed`);
}

async function rejectedPayload(
  fn: () => Promise<unknown> | unknown, // a thunk: some guards throw SYNC
  what: string,
): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ComponentException) return e.payload;
    throw new Error(`${what}: expected ComponentException, got ${e}`);
  }
  throw new Error(`${what}: expected a rejection, got none`);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A fresh, empty smoke directory under the real OPFS root. */
async function smokeDir(name: string): Promise<OpfsDirectoryHandle> {
  const storage = (navigator as { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  if (storage?.getDirectory === undefined) {
    throw new Error("this browser exposes no navigator.storage.getDirectory");
  }
  const root = await storage.getDirectory() as unknown as
    & OpfsDirectoryHandle
    & { removeEntry(n: string, o?: { recursive?: boolean }): Promise<void> };
  try {
    await root.removeEntry(name, { recursive: true }); // leftovers from --keep-open runs
  } catch {
    // Nothing to clean.
  }
  return await root.getDirectoryHandle(name, { create: true });
}

// --- half 1: the direct battery ----------------------------------------------------

/**
 * The battery itself (both halves), exported so `opfs_worker_entry.ts` can
 * run the SAME code inside a dedicated/shared worker realm. Pure functions
 * of a report object plus real ambient (navigator.storage, fetch) — nothing
 * here is page-only, so it is import-safe from a worker module.
 */
export async function runDirect(report: OpfsSmokeReport): Promise<void> {
  const dir = await smokeDir("polyengine-opfs-smoke-direct");
  // The rename-path probe belongs on a FILE handle: Chromium ships
  // `move()` there (not on directory handles); Firefox on neither.
  const probe = await dir.getFileHandle("rename-probe", { create: true });
  report.renamePath = (probe as { move?: unknown }).move !== undefined ? "move" : "copy-delete";
  await dir.removeEntry("rename-probe");
  const { imports } = filesystemWeb({ preopens: { "/": dir }, writable: true });
  const [[root02]] = (imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): [D02, string][];
  }).getDirectories();
  const [[root03]] = (imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [D03, string][];
  }).getDirectories();

  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      report.direct.push({ name, ok: true });
    } catch (e) {
      report.direct.push({
        name,
        ok: false,
        detail: String((e as Error)?.stack ?? e),
      });
    }
  };

  await check("open/write/read/stat/truncate against real OPFS", async () => {
    const f = await root02.openAt(FOLLOW, "hello.txt", { create: true }, RW);
    assertEq(f.getType(), "regular-file", "type");
    const data = new TextEncoder().encode("real opfs bytes");
    assertEq(await f.write(data, 0n), BigInt(data.length), "write count");
    const [bytes, eof] = await f.read(64n, 0n);
    assertEq(new TextDecoder().decode(bytes), "real opfs bytes", "read-back");
    assertEq(eof, false, "eof flag");
    const st = await f.stat();
    assertEq(st.size, BigInt(data.length), "stat size");
    assertTrue(st.dataModificationTimestamp !== undefined, "mtime from File.lastModified");
    await f.setSize(4n);
    assertEq((await f.stat()).size, 4n, "truncated");
  });

  await check("0.2 via-streams over real createWritable/getFile", async () => {
    const f = await root02.openAt(FOLLOW, "s.txt", { create: true }, RW);
    const out = f.writeViaStream(0n);
    out.write(new TextEncoder().encode("abcdef"));
    await out.blockingFlush(); // commit-on-close inside the backend
    const src = f.readViaStream(2n);
    assertEq(new TextDecoder().decode(await src.blockingRead(8n)), "cdef", "offset read");
  });

  await check("directories: mkdir/exist/list/not-empty (real DOMException names)", async () => {
    await root02.createDirectoryAt("d");
    assertEq(await rejectedPayload(() => root02.createDirectoryAt("d"), "mkdir twice"), "exist", "exist");
    const f = await root02.openAt(FOLLOW, "d/x.bin", { create: true }, RW);
    await f.write(new Uint8Array([7, 8, 9]), 0n);
    assertEq(
      await rejectedPayload(() => root02.removeDirectoryAt("d"), "rmdir non-empty"),
      "not-empty",
      "not-empty (InvalidModificationError)",
    );
    assertEq(
      await rejectedPayload(
        () => root02.openAt(FOLLOW, "d/x.bin", { create: true, exclusive: true }, RW),
        "exclusive on existing",
      ),
      "exist",
      "exclusive create",
    );
  });

  await check("rename via the engine's real path, then unlink/no-entry", async () => {
    await root02.renameAt("d/x.bin", root02, "y.bin");
    assertEq((await root02.statAt(FOLLOW, "y.bin")).size, 3n, "renamed content");
    assertEq(
      await rejectedPayload(() => root02.statAt(FOLLOW, "d/x.bin"), "old gone"),
      "no-entry",
      "old gone (NotFoundError)",
    );
    await root02.removeDirectoryAt("d");
    await root02.unlinkFileAt("y.bin");
    assertEq(
      await rejectedPayload(() => root02.statAt(FOLLOW, "y.bin"), "unlinked"),
      "no-entry",
      "unlinked",
    );
  });

  await check("identity via real isSameEntry; metadata-hash stability", async () => {
    await root02.openAt(FOLLOW, "a.txt", { create: true }, RW);
    const a1 = await root02.openAt(FOLLOW, "a.txt", {}, { read: true });
    const a2 = await root02.openAt(FOLLOW, "a.txt", {}, { read: true });
    assertEq(await a1.isSameObject(a2), true, "same entry");
    assertEq(await a1.isSameObject(root02), false, "file vs dir");
    const h1 = await a1.metadataHash();
    const h2 = await a2.metadataHash();
    assertTrue(h1.lower === h2.lower && h1.upper === h2.upper, "hash stable");
  });

  await check("unsupported families answer honestly", async () => {
    assertEq(
      await rejectedPayload(
        () => root02.setTimes({ kind: "now" }, { kind: "now" }),
        "set-times",
      ),
      "unsupported",
      "set-times",
    );
  });

  await check("0.3 stream tuples through real storage", async () => {
    const f = await root03.openAt(FOLLOW, "w3.bin", { create: true }, RW);
    const wrote = await f.writeViaStream(
      (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
      0n,
    );
    assertEq(wrote.kind, "ok", "write future");
    const [source, done] = f.readViaStream(0n);
    let total = 0;
    for await (const chunk of source) total += chunk.length;
    assertEq(total, 3, "streamed bytes");
    assertEq((await done).kind, "ok", "read future");
  });
}

// --- half 2: the composed fs-probe guest --------------------------------------------

export async function runComposed(report: OpfsSmokeReport): Promise<void> {
  const push = (name: string, ok: boolean, detail?: string): void => {
    report.composed.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };
  try {
    const [shimWasm, componentBytes] = await Promise.all([
      fetchBytes("/corpus/translator_shim.wasm"),
      fetchBytes("/fixtures/fs-probe.component.wasm"),
    ]);
    const dir = await smokeDir("polyengine-opfs-smoke-composed");
    const translator = await Translator.create(shimWasm);
    const { plan, adapters } = translator.translate(componentBytes);
    const c = await instantiate(
      { plan, componentBytes, adapters },
      {
        ...wasi(),
        ...filesystemWeb({ preopens: { "/": dir }, writable: true }).imports,
      },
      // Default mode selection picks jspi from the A14 marks; make the
      // requirement explicit so a silent fallback cannot pass vacuously.
      { jspi: true },
    );
    const summary = await c.exports.run() as string;
    push("std::fs battery over real OPFS (parking via A14/JSPI)", summary === "fs probe ok", summary);
    // The guest cleaned up: its preopen is empty again.
    let leftovers = 0;
    for await (const _ of dir.entries()) leftovers++;
    push("guest cleanup reached real OPFS", leftovers === 0, `${leftovers} entries left`);
  } catch (e) {
    push("composed run", false, String((e as Error)?.stack ?? e));
  }
}

async function runSmokeInPage(): Promise<OpfsSmokeReport> {
  const report: OpfsSmokeReport = {
    userAgent: navigator.userAgent,
    renamePath: "unknown",
    realm: "page",
    direct: [],
    composed: [],
  };
  try {
    await runDirect(report);
  } catch (e) {
    report.direct.push({ name: "direct setup", ok: false, detail: String((e as Error)?.stack ?? e) });
  }
  await runComposed(report);
  return report;
}

/**
 * "worker" / "shared-worker": spawn `/dist/opfs_worker_entry.js` as the
 * respective worker kind and run the SAME battery inside that realm — the
 * OPFS × JSPI-parking × worker-realm intersection issue #129 exists to pin.
 * The worker posts back `{kind:"report",report}` or
 * `{kind:"fatal",detail}`; this resolves/rejects accordingly.
 */
function runSmokeInWorker(realm: "worker" | "shared-worker"): Promise<OpfsSmokeReport> {
  return new Promise((resolve, reject) => {
    type Msg =
      | { kind: "report"; report: OpfsSmokeReport }
      | { kind: "fatal"; detail: string };

    const onMessage = (data: Msg) => {
      if (data.kind === "report") resolve(data.report);
      else reject(new Error(`worker realm fatal: ${data.detail}`));
    };

    if (realm === "worker") {
      const w = new Worker("/dist/opfs_worker_entry.js", { type: "module" });
      w.onmessage = (ev: MessageEvent) => onMessage(ev.data as Msg);
      w.onerror = (ev: ErrorEvent) =>
        reject(new Error(`dedicated worker error: ${ev.message}`));
      w.postMessage({ kind: "start", realm });
    } else {
      const w = new SharedWorker("/dist/opfs_worker_entry.js", { type: "module" });
      w.port.onmessage = (ev: MessageEvent) => onMessage(ev.data as Msg);
      w.onerror = (ev: Event) =>
        reject(new Error(`shared worker error: ${(ev as ErrorEvent).message ?? "unknown"}`));
      w.port.start();
      w.port.postMessage({ kind: "start", realm });
    }
  });
}

async function runSmoke(realm?: OpfsRealm): Promise<OpfsSmokeReport> {
  if (realm === undefined || realm === "page") return await runSmokeInPage();
  return await runSmokeInWorker(realm);
}

(globalThis as { __opfsSmoke?: (realm?: OpfsRealm) => Promise<OpfsSmokeReport> }).__opfsSmoke = runSmoke;
