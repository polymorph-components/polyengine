// INTERNAL shared core for the real `wasi:filesystem` impls
// (filesystem_node.ts, filesystem_web.ts) — not a package export. The
// backend seam (`FsBackend`) is the sockets_platform.ts move applied to
// files: everything WIT-shaped (value mapping, path validation, error
// shaping, stream plumbing, resource classes) lives here once; a backend
// supplies raw handle operations and an error mapper.
//
// TRACKS. Both impls serve `@0.2` (WASI 0.2.12 WIT) and `@0.3` (WASI
// 0.3.1). The same descriptor method NAMES carry different signatures
// across tracks (`read-via-stream(offset) -> input-stream` vs
// `read-via-stream(offset) -> tuple<stream<u8>, future<...>>`), so each
// track gets its OWN resource class per `makeFilesystem` call — a guest
// links one track and never mixes instances.
//
// ERROR SHAPES (the A10 family, and the reason this file exists twice
// over): 0.2's `error-code` is an ENUM — the err payload is the bare
// kebab-case string ("no-entry") — while 0.3's is a VARIANT (it grew
// `other(option<string>)`) — the payload is `{ kind: "no-entry" }`.
// Backends throw raw platform errors; `mapError` names the code and the
// per-track guards shape it. A branded `ComponentException` from inner
// code passes through untouched; an unmapped throw would be a trap, so
// the guards map everything.
//
// SYNC vs PARKING (A14). 0.2 descriptor methods are sync WIT functions.
// A sync backend (node) returns plain values from every op — no parking,
// callback-mode guests work untouched. An async backend (OPFS) returns
// promises, so every backend-touching 0.2 method is wrapped `suspending`
// on the freshly-minted class prototype (per-call classes are what make
// the marking per-backend rather than global). The 0.3 track needs no
// marks: its methods are `async func` in WIT, and async-typed imports
// accept thenables.
//
// READ-ONLY BY DEFAULT (`makeFilesystem(..., { writable })`). Write
// access is a PACKAGE-LEVEL opt-in: one flag for the whole
// implementation, never per-preopen. The rationale is a proof
// obligation, not ergonomics. Per-preopen permissions form a lattice,
// and the two-descriptor operations (`link-at`, `rename-at`) are edges
// between its cells: each is a place where the check can be attached to
// the wrong descriptor, letting a guest bridge from a read-only preopen
// into a writable one — wasmtime-wasi shipped a vulnerability of exactly
// that shape. With a single global flag there is no lattice to bridge,
// so the obligation collapses to a closed enumeration ("every mutating
// leaf refuses"), checkable against the WIT method list rather than
// requiring per-path reasoning. Enforcement therefore lives HERE, in the
// provider, and nowhere else: both backends and both tracks inherit it
// from one site. Refusals use the WIT `read-only` error code.
//
// Two DISTINCT concerns, deliberately not merged:
//   * the global grant (`requireWritable`) -> `read-only`: this
//     filesystem is read-only, whatever the descriptor says. It runs
//     FIRST on every mutating leaf, so a read-only package answers
//     `read-only` uniformly rather than leaking descriptor bookkeeping.
//   * per-descriptor flags, which SPLIT by descriptor kind because the
//     WIT dictates one half and is silent on the other:
//       - directories (`requireDirMutate`) -> `read-only`. WIT-mandated:
//         of `mutate-directory`, "When this flag is unset on a
//         descriptor, operations using the descriptor which would
//         create, rename, delete, modify the data or metadata of
//         filesystem objects, or obtain another handle which would
//         permit any of those, shall fail with `error-code::read-only`".
//       - files (`requireFileWrite`) -> `bad-descriptor`. The WIT says
//         nothing about a file descriptor opened without `write`; POSIX
//         answers EBADF for a write on a handle not opened for writing,
//         so we do. `mutate-directory` is NOT accepted here: the WIT
//         says it "may only be set on directories".
// The "obtain another handle" fragment is why `open-at` carries an
// ESCALATION clause: through a directory descriptor without
// `mutate-directory`, an open asking for `write`/`mutate-directory` (or
// `create`/`truncate`/`exclusive`) is refused `read-only` — otherwise
// the handle it mints would launder the missing permission.
// Path-ops check kind before permission (`requireDir` first), so a
// path-op through a FILE descriptor reports `not-directory` rather than
// a bogus `read-only` — wasmtime's `Descriptor::dir()` ordering.
//
// PATHS. Guest paths are resolved TEXTUALLY: split on "/", drop "." and
// empty segments, ".." pops (underflow = `not-permitted`), absolute
// paths and NUL rejected. Backends receive clean, non-escaping segment
// lists. SECURITY: containment here is a CORRECTNESS mechanism, not a
// security boundary — see docs/security.md. This layer confines lookups
// TEXTUALLY only — it does
// not chase symlinks per-component (no openat2/RESOLVE_BENEATH analogue
// in node or OPFS). PHYSICAL containment is the backend's job: the node
// backend realpaths every op against the preopen root before the OS call
// (filesystem_node.ts header, issue #177), so guest-created and
// pre-existing escaping symlinks alike are refused with `not-permitted`;
// OPFS has no symlinks, so the web backend is immune by construction.

import { ComponentException, isStream, suspending, type Stream } from "@polyengine/protocol";
import { FedInputStream, IoError, OutputStream, Pollable, SinkOutputStream } from "../io.ts";

/** `wasi:filesystem/types.error-code` labels. 0.2 (enum): all of these,
 * bare. 0.3 (variant): all but `would-block`, as `{kind}` — this package
 * never produces `would-block`, so the union serves both tracks. */
export type FsErrorCode =
  | "access"
  | "would-block"
  | "already"
  | "bad-descriptor"
  | "busy"
  | "deadlock"
  | "quota"
  | "exist"
  | "file-too-large"
  | "illegal-byte-sequence"
  | "in-progress"
  | "interrupted"
  | "invalid"
  | "io"
  | "is-directory"
  | "loop"
  | "too-many-links"
  | "message-size"
  | "name-too-long"
  | "no-device"
  | "no-entry"
  | "no-lock"
  | "insufficient-memory"
  | "insufficient-space"
  | "not-directory"
  | "not-empty"
  | "not-recoverable"
  | "unsupported"
  | "no-tty"
  | "no-such-device"
  | "overflow"
  | "not-permitted"
  | "pipe"
  | "read-only"
  | "invalid-seek"
  | "text-file-busy"
  | "cross-device";

/** `descriptor-type` (enum: bare strings). */
export type DescriptorType =
  | "unknown"
  | "block-device"
  | "character-device"
  | "directory"
  | "fifo"
  | "symbolic-link"
  | "regular-file"
  | "socket";

/** `wasi:clocks` wall-clock `datetime` record, as a value. */
export interface Datetime {
  seconds: bigint;
  nanoseconds: number;
}

/** What a backend reports from stat; absent timestamp = unavailable. */
export interface FsStat {
  type: DescriptorType;
  linkCount: bigint;
  size: bigint;
  atimeNs?: bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
}

/** A stable per-object identity (dev/ino-ish) for metadata-hash and
 * is-same-object; backends without a native one synthesize (e.g. from
 * the path). */
export interface FsIdentity {
  a: bigint;
  b: bigint;
}

/** A set-times instruction, backend-facing (ns since epoch). */
export type TimeSpec =
  | { kind: "no-change" }
  | { kind: "now" }
  | { kind: "timestamp"; ns: bigint };

/** Decoded open-at intent (path-flags + open-flags + descriptor-flags). */
export interface OpenOptions {
  follow: boolean;
  create: boolean;
  directory: boolean;
  exclusive: boolean;
  truncate: boolean;
  read: boolean;
  write: boolean;
}

export interface Opened<H> {
  handle: H;
  type: DescriptorType;
}

/**
 * @internal — used only in the (unexported) `FsBackend` seam interface;
 * re-exported from `filesystem_node.ts`/`filesystem_web.ts` but never part
 * of `FilesystemFragment`'s public shape (`{ imports: Record<string,
 * unknown> }`), so no importer outside wasi/src references it.
 */
export type MaybeAsync<T> = T | Promise<T>;

/**
 * The backend seam. `isSync: true` promises every op returns a plain
 * value (node); `false` allows promises everywhere and buys the 0.2
 * track its suspending marks (OPFS). Ops receive validated, non-escaping
 * segment lists (possibly empty = the base itself). Ops throw RAW
 * platform errors; `mapError` names them.
 */
export interface FsBackend<H> {
  isSync: boolean;
  mapError(e: unknown): FsErrorCode;
  openAt(base: H, segments: string[], opts: OpenOptions): MaybeAsync<Opened<H>>;
  close(h: H): void;
  stat(h: H): MaybeAsync<FsStat>;
  statAt(base: H, segments: string[], follow: boolean): MaybeAsync<FsStat>;
  /** Short reads are fine; empty result with `length > 0` = EOF. */
  read(h: H, length: number, offset: number): MaybeAsync<Uint8Array>;
  write(h: H, buffer: Uint8Array, offset: number): MaybeAsync<number>;
  append(h: H, buffer: Uint8Array): MaybeAsync<number>;
  setSize(h: H, size: number): MaybeAsync<void>;
  setTimes(h: H, atime: TimeSpec, mtime: TimeSpec): MaybeAsync<void>;
  setTimesAt(
    base: H,
    segments: string[],
    follow: boolean,
    atime: TimeSpec,
    mtime: TimeSpec,
  ): MaybeAsync<void>;
  syncAll(h: H): MaybeAsync<void>;
  syncData(h: H): MaybeAsync<void>;
  readDirectory(h: H): MaybeAsync<{ name: string; type: DescriptorType }[]>;
  createDirectoryAt(base: H, segments: string[]): MaybeAsync<void>;
  removeDirectoryAt(base: H, segments: string[]): MaybeAsync<void>;
  unlinkFileAt(base: H, segments: string[]): MaybeAsync<void>;
  renameAt(
    oldBase: H,
    oldSegments: string[],
    newBase: H,
    newSegments: string[],
  ): MaybeAsync<void>;
  /** Optional families: absent = `unsupported`. */
  linkAt?(
    oldBase: H,
    oldSegments: string[],
    follow: boolean,
    newBase: H,
    newSegments: string[],
  ): MaybeAsync<void>;
  symlinkAt?(target: string, base: H, segments: string[]): MaybeAsync<void>;
  readlinkAt?(base: H, segments: string[]): MaybeAsync<string>;
  identity(h: H): MaybeAsync<FsIdentity>;
  identityAt(base: H, segments: string[], follow: boolean): MaybeAsync<FsIdentity>;
  isSame(a: H, b: H): MaybeAsync<boolean>;
}

// --- WIT-boundary value shapes ---------------------------------------------------

/** `descriptor-stat` record as a value (option fields: absent = none). */
export interface DescriptorStatValue {
  type: DescriptorType;
  linkCount: bigint;
  size: bigint;
  dataAccessTimestamp?: Datetime;
  dataModificationTimestamp?: Datetime;
  statusChangeTimestamp?: Datetime;
}

/** `descriptor-flags` as a value (flags record: camelCase booleans). */
export interface DescriptorFlagsValue {
  read: boolean;
  write: boolean;
  fileIntegritySync: boolean;
  dataIntegritySync: boolean;
  requestedWriteSync: boolean;
  mutateDirectory: boolean;
}

interface PathFlagsValue {
  symlinkFollow?: boolean;
}

interface OpenFlagsValue {
  create?: boolean;
  directory?: boolean;
  exclusive?: boolean;
  truncate?: boolean;
}

/** `new-timestamp` variant, guest→host shape. */
type NewTimestampValue =
  | { kind: "no-change" }
  | { kind: "now" }
  | { kind: "timestamp"; value: Datetime };

/** `directory-entry` record. */
export interface DirectoryEntryValue {
  type: DescriptorType;
  name: string;
}

export interface MetadataHashValue {
  lower: bigint;
  upper: bigint;
}

/** 0.3 `result<_, error-code>` as a future/tuple VALUE (A12 shapes). */
export type FsResult03 =
  | { kind: "ok" }
  | { kind: "err"; value: { kind: FsErrorCode } };

const OK03: FsResult03 = { kind: "ok" };

/** What 0.3 write/append-via-stream accepts (the lifted stream handle or
 * any byte producer, mirroring cli's CliByteSource). */
export type FsByteSource =
  | Stream<number>
  | AsyncIterable<Uint8Array | number[]>
  | Iterable<Uint8Array | number[]>;

// --- errors ----------------------------------------------------------------------

/**
 * The io `error` resource minted by filesystem STREAM failures, carrying
 * the error-code so 0.2's `filesystem-error-code(borrow<error>)` can
 * downcast it (SinkOutputStream preserves IoError subclasses).
 */
export class FsIoError extends IoError {
  constructor(readonly code: FsErrorCode, message: string) {
    super(message);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function err02(code: FsErrorCode): ComponentException<FsErrorCode> {
  return new ComponentException(code);
}

function err03(code: FsErrorCode): ComponentException<{ kind: FsErrorCode }> {
  return new ComponentException({ kind: code });
}

type ErrShape = (code: FsErrorCode) => ComponentException<unknown>;

/** Chain over MaybeAsync without forcing sync backends through a tick. */
function chain<T, U>(v: MaybeAsync<T>, f: (v: T) => MaybeAsync<U>): MaybeAsync<U> {
  return v instanceof Promise ? v.then(f) : f(v);
}

/** Run `fn`, mapping raw throws/rejections to the track's error shape;
 * branded ComponentExceptions pass through. */
function guarded<T>(
  map: (e: unknown) => FsErrorCode,
  shape: ErrShape,
  fn: () => MaybeAsync<T>,
): MaybeAsync<T> {
  // The explicit annotation is what lets TS's flow analysis treat the
  // catch-arm call as never-returning.
  const rethrow: (e: unknown) => never = (e) => {
    if (e instanceof ComponentException) throw e;
    throw shape(map(e));
  };
  try {
    const r = fn();
    return r instanceof Promise ? r.catch(rethrow) : r;
  } catch (e) {
    return rethrow(e);
  }
}

// --- paths -----------------------------------------------------------------------

/**
 * Validate and normalize a guest path to non-escaping segments (module
 * header). `shape` picks the track's error payload.
 */
export function parsePath(path: string, shape: ErrShape): string[] {
  if (path.includes("\0")) throw shape("invalid");
  if (path.startsWith("/")) throw shape("not-permitted");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) throw shape("not-permitted");
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** Ops that name an entry (create/remove/unlink/rename/link/symlink)
 * need a final component; "" or "." resolve to none. */
function requireFinal(segments: string[], shape: ErrShape): string[] {
  if (segments.length === 0) throw shape("invalid");
  return segments;
}

// --- conversions -----------------------------------------------------------------

const NS_PER_SEC = 1_000_000_000n;

function nsToDatetime(ns: bigint): Datetime {
  return { seconds: ns / NS_PER_SEC, nanoseconds: Number(ns % NS_PER_SEC) };
}

function newTimestampToSpec(v: NewTimestampValue): TimeSpec {
  switch (v.kind) {
    case "no-change":
    case "now":
      return { kind: v.kind };
    case "timestamp":
      return {
        kind: "timestamp",
        ns: v.value.seconds * NS_PER_SEC + BigInt(v.value.nanoseconds),
      };
  }
}

function statValue(st: FsStat): DescriptorStatValue {
  return {
    type: st.type,
    linkCount: st.linkCount,
    size: st.size,
    ...(st.atimeNs === undefined ? {} : { dataAccessTimestamp: nsToDatetime(st.atimeNs) }),
    ...(st.mtimeNs === undefined ? {} : { dataModificationTimestamp: nsToDatetime(st.mtimeNs) }),
    ...(st.ctimeNs === undefined ? {} : { statusChangeTimestamp: nsToDatetime(st.ctimeNs) }),
  };
}

// FNV-1a 64-bit over the identity words: a deterministic, per-object
// metadata-hash (the WIT contract is only "same object + same hash input
// => same value"; wasmtime likewise hashes host metadata).
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

function fnv64(words: bigint[]): bigint {
  let h = FNV_OFFSET;
  for (const w of words) {
    for (let i = 0n; i < 8n; i++) {
      h ^= (w >> (i * 8n)) & 0xffn;
      h = (h * FNV_PRIME) & U64;
    }
  }
  return h;
}

function hashIdentity(id: FsIdentity): MetadataHashValue {
  return {
    lower: fnv64([id.a, id.b]),
    upper: fnv64([id.b ^ 0x9e3779b97f4a7c15n, id.a]),
  };
}

const READ_CHUNK = 65536;

// --- the factory -----------------------------------------------------------------

export interface FilesystemFragment {
  imports: Record<string, unknown>;
}

/** 0.2 methods wrapped `suspending` for async backends (A14; module
 * header). Everything that touches the backend — stream CONSTRUCTION
 * stays plain (the streams themselves park via io.ts's marks). */
const PARKED_02 = [
  "advise",
  "syncData",
  "setSize",
  "setTimes",
  "read",
  "write",
  "readDirectory",
  "sync",
  "createDirectoryAt",
  "stat",
  "statAt",
  "setTimesAt",
  "linkAt",
  "openAt",
  "readlinkAt",
  "removeDirectoryAt",
  "renameAt",
  "symlinkAt",
  "unlinkFileAt",
  "isSameObject",
  "metadataHash",
  "metadataHashAt",
] as const;

/**
 * Package-level capability options shared by every `wasi:filesystem`
 * implementation (module header, "READ-ONLY BY DEFAULT").
 */
export interface FilesystemAccessOptions {
  /**
   * Grant write access to the WHOLE implementation. Default `false`:
   * every mutating operation refuses with the WIT `read-only` error
   * code, `get-flags` never advertises `write`/`mutate-directory`, and
   * `open-at` refuses write descriptor-flags as well as the
   * `create`/`truncate`/`exclusive` open-flags.
   *
   * Deliberately NOT per-preopen: see the module header for why a
   * global flag is the checkable design.
   */
  writable?: boolean;
}

/**
 * Build the two-track `wasi:filesystem` import fragment over a backend.
 * `preopens`: directory handles with their guest names, served (as fresh
 * per-call descriptors) by both tracks' `preopens#get-directories`.
 * `access.writable` (default false) is the package-level write grant.
 */
export function makeFilesystem<H>(
  backend: FsBackend<H>,
  preopens: [H, string][],
  access: FilesystemAccessOptions = {},
): FilesystemFragment {
  const writable = access.writable === true;
  const map = (e: unknown): FsErrorCode => backend.mapError(e);
  const g02 = <T>(fn: () => MaybeAsync<T>): MaybeAsync<T> => guarded(map, err02, fn);
  const g03 = <T>(fn: () => MaybeAsync<T>): MaybeAsync<T> => guarded(map, err03, fn);

  /** A stream-facing sink/source error: an IoError subclass carrying the
   * code, so 0.2 stream failures downcast via filesystem-error-code. */
  const streamError = (e: unknown): FsIoError =>
    e instanceof FsIoError ? e : new FsIoError(map(e), message(e));

  const decodeOpen = (
    pf: PathFlagsValue,
    of: OpenFlagsValue,
    df: Partial<DescriptorFlagsValue>,
  ): OpenOptions => ({
    follow: pf.symlinkFollow === true,
    create: of.create === true,
    directory: of.directory === true,
    exclusive: of.exclusive === true,
    truncate: of.truncate === true,
    read: df.read === true,
    write: df.write === true || df.mutateDirectory === true,
  });

  /** Descriptor flags as VALUES, masked by the package grant: a
   * read-only package never advertises `write`/`mutate-directory`, on
   * preopens or on anything `open-at` mints, so a guest that checks
   * flags before acting sees the same story the operations tell. */
  const flagsValue = (df: Partial<DescriptorFlagsValue>): DescriptorFlagsValue => ({
    read: df.read === true,
    write: writable && df.write === true,
    fileIntegritySync: df.fileIntegritySync === true,
    dataIntegritySync: df.dataIntegritySync === true,
    requestedWriteSync: df.requestedWriteSync === true,
    mutateDirectory: writable && df.mutateDirectory === true,
  });

  const PREOPEN_FLAGS = flagsValue({ read: true, write: true, mutateDirectory: true });

  /** The package-level grant. Refuses with the WIT `read-only` code —
   * distinct from the per-descriptor checks (`requireDirMutate`,
   * `requireFileWrite`; module header). Called FIRST by every mutating
   * leaf. */
  const requireWritable = (shape: ErrShape): void => {
    if (!writable) throw shape("read-only");
  };

  /** `open-at` is mutating exactly when it asks for write access or for
   * an open-flag that creates/truncates: read-only means a guest cannot
   * bring a file into existence either. */
  const requireOpenAllowed = (
    of: OpenFlagsValue,
    df: Partial<DescriptorFlagsValue>,
    shape: ErrShape,
  ): void => {
    if (writable) return;
    if (
      df.write === true || df.mutateDirectory === true ||
      of.create === true || of.truncate === true || of.exclusive === true
    ) {
      throw shape("read-only");
    }
  };

  /** An async pull over positional reads: the byte source for both
   * tracks' read-via-stream on any backend. */
  async function* readFrom(h: H, offset: number): AsyncGenerator<Uint8Array> {
    let at = offset;
    for (;;) {
      const bytes = await backend.read(h, READ_CHUNK, at);
      if (bytes.length === 0) return;
      at += bytes.length;
      yield bytes;
    }
  }

  // --- 0.2 sync streams (sync backends only: plain values, never park) --------

  class SyncFileInputStream {
    #h: H;
    #cursor: number;
    #closed = false;

    constructor(h: H, offset: number) {
      this.#h = h;
      this.#cursor = offset;
    }

    read(len: bigint): Uint8Array {
      if (this.#closed) throw new ComponentException({ kind: "closed" });
      const n = Number(len);
      let bytes: Uint8Array;
      try {
        bytes = backend.read(this.#h, n, this.#cursor) as Uint8Array;
      } catch (e) {
        throw new ComponentException({
          kind: "last-operation-failed",
          value: streamError(e),
        });
      }
      this.#cursor += bytes.length;
      if (n > 0 && bytes.length === 0) {
        throw new ComponentException({ kind: "closed" }); // EOF
      }
      return bytes;
    }

    blockingRead(len: bigint): Uint8Array {
      return this.read(len);
    }

    skip(len: bigint): bigint {
      return BigInt(this.read(len).length);
    }

    blockingSkip(len: bigint): bigint {
      return this.skip(len);
    }

    subscribe(): Pollable {
      return new Pollable(); // file bytes are always "ready"
    }

    [Symbol.dispose](): void {
      this.#closed = true;
    }
  }

  /** Sync positional/append writes ride the buffer-backed OutputStream
   * base; the sink converts raw failures to stream-errors. */
  const syncWriteStream = (write: (chunk: Uint8Array) => void): OutputStream =>
    new OutputStream((chunk) => {
      try {
        write(chunk);
      } catch (e) {
        throw new ComponentException({
          kind: "last-operation-failed",
          value: streamError(e),
        });
      }
    });

  /** Async sinks for SinkOutputStream: failures carry the code. */
  const asyncSink = (write: (chunk: Uint8Array) => Promise<void>) => async (chunk: Uint8Array) => {
    try {
      await write(chunk);
    } catch (e) {
      throw streamError(e);
    }
  };

  // --- shared core ops (MaybeAsync; the track classes shape errors) -----------

  type Core = {
    h: H;
    type: DescriptorType;
    flags: DescriptorFlagsValue;
  };

  const requireFile = (c: Core, shape: ErrShape): void => {
    if (c.type === "directory") throw shape("is-directory");
  };
  const requireDir = (c: Core, shape: ErrShape): void => {
    if (c.type !== "directory") throw shape("not-directory");
  };
  const requireRead = (c: Core, shape: ErrShape): void => {
    if (!c.flags.read) throw shape("bad-descriptor");
  };
  /** Per-descriptor write permission on a FILE. WIT-silent; POSIX EBADF
   * (module header). `mutate-directory` deliberately does NOT satisfy
   * it: the WIT says that flag "may only be set on directories". */
  const requireFileWrite = (c: Core, shape: ErrShape): void => {
    if (!c.flags.write) throw shape("bad-descriptor");
  };
  /** Per-descriptor mutation permission on a DIRECTORY. The WIT's
   * `mutate-directory` doc mandates the code: operations that would
   * create/rename/delete/modify "shall fail with
   * `error-code::read-only`". */
  const requireDirMutate = (c: Core, shape: ErrShape): void => {
    if (!c.flags.mutateDirectory) throw shape("read-only");
  };

  // --- the 0.2 track ---------------------------------------------------------

  class DirectoryEntryStream02 {
    #entries: DirectoryEntryValue[];
    #at = 0;
    constructor(entries: DirectoryEntryValue[]) {
      this.#entries = entries;
    }
    readDirectoryEntry(): DirectoryEntryValue | undefined {
      return this.#at < this.#entries.length ? this.#entries[this.#at++] : undefined;
    }
    [Symbol.dispose](): void {
      this.#at = this.#entries.length;
    }
  }

  class Descriptor02 {
    readonly core: Core;

    constructor(h: H, type: DescriptorType, flags: DescriptorFlagsValue) {
      this.core = { h, type, flags };
    }

    readViaStream(offset: bigint): SyncFileInputStream | FedInputStream {
      return g02(() => {
        requireFile(this.core, err02);
        requireRead(this.core, err02);
        return backend.isSync
          ? new SyncFileInputStream(this.core.h, Number(offset))
          : new FedInputStream(readFrom(this.core.h, Number(offset)));
      }) as SyncFileInputStream | FedInputStream;
    }

    writeViaStream(offset: bigint): OutputStream | SinkOutputStream {
      return g02(() => {
        requireWritable(err02);
        requireFile(this.core, err02);
        requireFileWrite(this.core, err02);
        let cursor = Number(offset);
        if (backend.isSync) {
          return syncWriteStream((chunk) => {
            cursor += backend.write(this.core.h, chunk, cursor) as number;
          });
        }
        return new SinkOutputStream(asyncSink(async (chunk) => {
          cursor += await backend.write(this.core.h, chunk, cursor);
        }));
      }) as OutputStream | SinkOutputStream;
    }

    appendViaStream(): OutputStream | SinkOutputStream {
      return g02(() => {
        requireWritable(err02);
        requireFile(this.core, err02);
        requireFileWrite(this.core, err02);
        if (backend.isSync) {
          return syncWriteStream((chunk) => void backend.append(this.core.h, chunk));
        }
        return new SinkOutputStream(asyncSink(async (chunk) => {
          await backend.append(this.core.h, chunk);
        }));
      }) as OutputStream | SinkOutputStream;
    }

    advise(_offset: bigint, _length: bigint, _advice: string): MaybeAsync<void> {
      return g02(() => requireFile(this.core, err02)); // advisory: accept and ignore
    }

    syncData(): MaybeAsync<void> {
      return g02(() => backend.syncData(this.core.h));
    }

    getFlags(): DescriptorFlagsValue {
      return { ...this.core.flags };
    }

    getType(): DescriptorType {
      return this.core.type;
    }

    setSize(size: bigint): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        requireFileWrite(this.core, err02);
        return backend.setSize(this.core.h, Number(size));
      });
    }

    setTimes(atime: NewTimestampValue, mtime: NewTimestampValue): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        // The descriptor's OWN times: which half of the per-descriptor
        // rule applies depends on what this descriptor IS (module header).
        if (this.core.type === "directory") requireDirMutate(this.core, err02);
        else requireFileWrite(this.core, err02);
        return backend.setTimes(
          this.core.h,
          newTimestampToSpec(atime),
          newTimestampToSpec(mtime),
        );
      });
    }

    read(length: bigint, offset: bigint): MaybeAsync<[Uint8Array, boolean]> {
      return g02(() => {
        requireFile(this.core, err02);
        requireRead(this.core, err02);
        const n = Number(length);
        return chain(
          backend.read(this.core.h, n, Number(offset)),
          (bytes): [Uint8Array, boolean] => [bytes, n > 0 && bytes.length === 0],
        );
      });
    }

    write(buffer: Uint8Array, offset: bigint): MaybeAsync<bigint> {
      return g02(() => {
        requireWritable(err02);
        requireFile(this.core, err02);
        requireFileWrite(this.core, err02);
        return chain(backend.write(this.core.h, buffer, Number(offset)), BigInt);
      });
    }

    readDirectory(): MaybeAsync<DirectoryEntryStream02> {
      return g02(() => {
        requireDir(this.core, err02);
        return chain(
          backend.readDirectory(this.core.h),
          (entries) => new DirectoryEntryStream02(entries),
        );
      });
    }

    sync(): MaybeAsync<void> {
      return g02(() => backend.syncAll(this.core.h));
    }

    createDirectoryAt(path: string): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        return backend.createDirectoryAt(
          this.core.h,
          requireFinal(parsePath(path, err02), err02),
        );
      });
    }

    stat(): MaybeAsync<DescriptorStatValue> {
      return g02(() => chain(backend.stat(this.core.h), statValue));
    }

    statAt(pathFlags: PathFlagsValue, path: string): MaybeAsync<DescriptorStatValue> {
      return g02(() =>
        chain(
          backend.statAt(
            this.core.h,
            parsePath(path, err02),
            pathFlags.symlinkFollow === true,
          ),
          statValue,
        )
      );
    }

    setTimesAt(
      pathFlags: PathFlagsValue,
      path: string,
      atime: NewTimestampValue,
      mtime: NewTimestampValue,
    ): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        return backend.setTimesAt(
          this.core.h,
          parsePath(path, err02),
          pathFlags.symlinkFollow === true,
          newTimestampToSpec(atime),
          newTimestampToSpec(mtime),
        );
      });
    }

    linkAt(
      oldPathFlags: PathFlagsValue,
      oldPath: string,
      newDescriptor: Descriptor02,
      newPath: string,
    ): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        if (backend.linkAt === undefined) throw err02("unsupported");
        // Both ends: a two-descriptor op checked on one side only is the
        // classic bridge bug (module header).
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        requireDir(newDescriptor.core, err02);
        requireDirMutate(newDescriptor.core, err02);
        return backend.linkAt(
          this.core.h,
          requireFinal(parsePath(oldPath, err02), err02),
          oldPathFlags.symlinkFollow === true,
          newDescriptor.core.h,
          requireFinal(parsePath(newPath, err02), err02),
        );
      });
    }

    openAt(
      pathFlags: PathFlagsValue,
      path: string,
      openFlags: OpenFlagsValue,
      flags: Partial<DescriptorFlagsValue>,
    ): MaybeAsync<Descriptor02> {
      return g02(() => {
        requireOpenAllowed(openFlags, flags, err02);
        requireDir(this.core, err02);
        // "obtain another handle which would permit any of those" (WIT,
        // mutate-directory): a base directory without mutate-directory
        // cannot mint a handle that escalates. `exclusive` is included
        // beyond the WIT's literal create/truncate to mirror the
        // package-level `requireOpenAllowed` enumeration.
        if (
          flags.write === true || flags.mutateDirectory === true ||
          openFlags.create === true || openFlags.truncate === true ||
          openFlags.exclusive === true
        ) {
          requireDirMutate(this.core, err02);
        }
        return chain(
          backend.openAt(
            this.core.h,
            parsePath(path, err02),
            decodeOpen(pathFlags, openFlags, flags),
          ),
          ({ handle, type }) => new Descriptor02(handle, type, flagsValue(flags)),
        );
      });
    }

    readlinkAt(path: string): MaybeAsync<string> {
      return g02(() => {
        if (backend.readlinkAt === undefined) throw err02("unsupported");
        return backend.readlinkAt(this.core.h, requireFinal(parsePath(path, err02), err02));
      });
    }

    removeDirectoryAt(path: string): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        return backend.removeDirectoryAt(
          this.core.h,
          requireFinal(parsePath(path, err02), err02),
        );
      });
    }

    renameAt(oldPath: string, newDescriptor: Descriptor02, newPath: string): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        // Both ends (see link-at).
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        requireDir(newDescriptor.core, err02);
        requireDirMutate(newDescriptor.core, err02);
        return backend.renameAt(
          this.core.h,
          requireFinal(parsePath(oldPath, err02), err02),
          newDescriptor.core.h,
          requireFinal(parsePath(newPath, err02), err02),
        );
      });
    }

    symlinkAt(oldPath: string, newPath: string): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        if (backend.symlinkAt === undefined) throw err02("unsupported");
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        // old-path is the link CONTENTS (never validated as a lookup path).
        return backend.symlinkAt(
          oldPath,
          this.core.h,
          requireFinal(parsePath(newPath, err02), err02),
        );
      });
    }

    unlinkFileAt(path: string): MaybeAsync<void> {
      return g02(() => {
        requireWritable(err02);
        requireDir(this.core, err02);
        requireDirMutate(this.core, err02);
        return backend.unlinkFileAt(
          this.core.h,
          requireFinal(parsePath(path, err02), err02),
        );
      });
    }

    /** Returns bool, not result: backend failures TRAP (unguarded). */
    isSameObject(other: Descriptor02): MaybeAsync<boolean> {
      return backend.isSame(this.core.h, other.core.h);
    }

    metadataHash(): MaybeAsync<MetadataHashValue> {
      return g02(() => chain(backend.identity(this.core.h), hashIdentity));
    }

    metadataHashAt(pathFlags: PathFlagsValue, path: string): MaybeAsync<MetadataHashValue> {
      return g02(() =>
        chain(
          backend.identityAt(
            this.core.h,
            parsePath(path, err02),
            pathFlags.symlinkFollow === true,
          ),
          hashIdentity,
        )
      );
    }

    [Symbol.dispose](): void {
      backend.close(this.core.h);
    }
  }

  // --- the 0.3 track ---------------------------------------------------------

  class Descriptor03 {
    readonly core: Core;

    constructor(h: H, type: DescriptorType, flags: DescriptorFlagsValue) {
      this.core = { h, type, flags };
    }

    /** tuple<stream<u8>, future<result<_, error-code>>> */
    readViaStream(offset: bigint): [AsyncIterable<Uint8Array>, Promise<FsResult03>] {
      requireFile(this.core, err03);
      requireRead(this.core, err03);
      let settle!: (r: FsResult03) => void;
      const done = new Promise<FsResult03>((r) => (settle = r));
      const h = this.core.h;
      const source = (async function* (): AsyncGenerator<Uint8Array> {
        try {
          yield* readFrom(h, Number(offset));
          settle(OK03);
        } catch (e) {
          settle({ kind: "err", value: { kind: map(e) } });
        } finally {
          settle(OK03); // reader dropped early: no-op if already settled
        }
      })();
      return [source, done];
    }

    /** The promise IS the future source (A12): drain the guest's stream. */
    async writeViaStream(data: FsByteSource, offset: bigint): Promise<FsResult03> {
      try {
        requireWritable(err03);
        requireFile(this.core, err03);
        requireFileWrite(this.core, err03);
        let cursor = Number(offset);
        for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
          const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
          cursor += await backend.write(this.core.h, bytes, cursor);
        }
        return OK03;
      } catch (e) {
        if (isStream(data)) data.drop(); // the guest's writer must not hang
        return {
          kind: "err",
          value: { kind: e instanceof ComponentException ? (e.payload as { kind: FsErrorCode }).kind : map(e) },
        };
      }
    }

    async appendViaStream(data: FsByteSource): Promise<FsResult03> {
      try {
        requireWritable(err03);
        requireFile(this.core, err03);
        requireFileWrite(this.core, err03);
        for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
          const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
          await backend.append(this.core.h, bytes);
        }
        return OK03;
      } catch (e) {
        if (isStream(data)) data.drop();
        return {
          kind: "err",
          value: { kind: e instanceof ComponentException ? (e.payload as { kind: FsErrorCode }).kind : map(e) },
        };
      }
    }

    advise(_offset: bigint, _length: bigint, _advice: string): MaybeAsync<void> {
      return g03(() => requireFile(this.core, err03));
    }

    syncData(): MaybeAsync<void> {
      return g03(() => backend.syncData(this.core.h));
    }

    getFlags(): DescriptorFlagsValue {
      return { ...this.core.flags };
    }

    getType(): DescriptorType {
      return this.core.type;
    }

    setSize(size: bigint): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        requireFileWrite(this.core, err03);
        return backend.setSize(this.core.h, Number(size));
      });
    }

    setTimes(atime: NewTimestampValue, mtime: NewTimestampValue): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        // The descriptor's OWN times: which half of the per-descriptor
        // rule applies depends on what this descriptor IS (module header).
        if (this.core.type === "directory") requireDirMutate(this.core, err03);
        else requireFileWrite(this.core, err03);
        return backend.setTimes(
          this.core.h,
          newTimestampToSpec(atime),
          newTimestampToSpec(mtime),
        );
      });
    }

    /** tuple<stream<directory-entry>, future<result<_, error-code>>> */
    readDirectory(): MaybeAsync<[Iterable<DirectoryEntryValue>, Promise<FsResult03>]> {
      return g03(() => {
        requireDir(this.core, err03);
        return chain(
          backend.readDirectory(this.core.h),
          (entries): [Iterable<DirectoryEntryValue>, Promise<FsResult03>] => [
            entries,
            Promise.resolve(OK03),
          ],
        );
      });
    }

    sync(): MaybeAsync<void> {
      return g03(() => backend.syncAll(this.core.h));
    }

    createDirectoryAt(path: string): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        return backend.createDirectoryAt(
          this.core.h,
          requireFinal(parsePath(path, err03), err03),
        );
      });
    }

    stat(): MaybeAsync<DescriptorStatValue> {
      return g03(() => chain(backend.stat(this.core.h), statValue));
    }

    statAt(pathFlags: PathFlagsValue, path: string): MaybeAsync<DescriptorStatValue> {
      return g03(() =>
        chain(
          backend.statAt(
            this.core.h,
            parsePath(path, err03),
            pathFlags.symlinkFollow === true,
          ),
          statValue,
        )
      );
    }

    setTimesAt(
      pathFlags: PathFlagsValue,
      path: string,
      atime: NewTimestampValue,
      mtime: NewTimestampValue,
    ): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        return backend.setTimesAt(
          this.core.h,
          parsePath(path, err03),
          pathFlags.symlinkFollow === true,
          newTimestampToSpec(atime),
          newTimestampToSpec(mtime),
        );
      });
    }

    linkAt(
      oldPathFlags: PathFlagsValue,
      oldPath: string,
      newDescriptor: Descriptor03,
      newPath: string,
    ): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        if (backend.linkAt === undefined) throw err03("unsupported");
        // Both ends: a two-descriptor op checked on one side only is the
        // classic bridge bug (module header).
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        requireDir(newDescriptor.core, err03);
        requireDirMutate(newDescriptor.core, err03);
        return backend.linkAt(
          this.core.h,
          requireFinal(parsePath(oldPath, err03), err03),
          oldPathFlags.symlinkFollow === true,
          newDescriptor.core.h,
          requireFinal(parsePath(newPath, err03), err03),
        );
      });
    }

    openAt(
      pathFlags: PathFlagsValue,
      path: string,
      openFlags: OpenFlagsValue,
      flags: Partial<DescriptorFlagsValue>,
    ): MaybeAsync<Descriptor03> {
      return g03(() => {
        requireOpenAllowed(openFlags, flags, err03);
        requireDir(this.core, err03);
        // "obtain another handle which would permit any of those" (WIT,
        // mutate-directory): a base directory without mutate-directory
        // cannot mint a handle that escalates. `exclusive` is included
        // beyond the WIT's literal create/truncate to mirror the
        // package-level `requireOpenAllowed` enumeration.
        if (
          flags.write === true || flags.mutateDirectory === true ||
          openFlags.create === true || openFlags.truncate === true ||
          openFlags.exclusive === true
        ) {
          requireDirMutate(this.core, err03);
        }
        return chain(
          backend.openAt(
            this.core.h,
            parsePath(path, err03),
            decodeOpen(pathFlags, openFlags, flags),
          ),
          ({ handle, type }) => new Descriptor03(handle, type, flagsValue(flags)),
        );
      });
    }

    readlinkAt(path: string): MaybeAsync<string> {
      return g03(() => {
        if (backend.readlinkAt === undefined) throw err03("unsupported");
        return backend.readlinkAt(this.core.h, requireFinal(parsePath(path, err03), err03));
      });
    }

    removeDirectoryAt(path: string): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        return backend.removeDirectoryAt(
          this.core.h,
          requireFinal(parsePath(path, err03), err03),
        );
      });
    }

    renameAt(oldPath: string, newDescriptor: Descriptor03, newPath: string): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        // Both ends (see link-at).
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        requireDir(newDescriptor.core, err03);
        requireDirMutate(newDescriptor.core, err03);
        return backend.renameAt(
          this.core.h,
          requireFinal(parsePath(oldPath, err03), err03),
          newDescriptor.core.h,
          requireFinal(parsePath(newPath, err03), err03),
        );
      });
    }

    symlinkAt(oldPath: string, newPath: string): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        if (backend.symlinkAt === undefined) throw err03("unsupported");
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        return backend.symlinkAt(
          oldPath,
          this.core.h,
          requireFinal(parsePath(newPath, err03), err03),
        );
      });
    }

    unlinkFileAt(path: string): MaybeAsync<void> {
      return g03(() => {
        requireWritable(err03);
        requireDir(this.core, err03);
        requireDirMutate(this.core, err03);
        return backend.unlinkFileAt(
          this.core.h,
          requireFinal(parsePath(path, err03), err03),
        );
      });
    }

    isSameObject(other: Descriptor03): MaybeAsync<boolean> {
      return backend.isSame(this.core.h, other.core.h); // bool, not result: raw throw = trap
    }

    metadataHash(): MaybeAsync<MetadataHashValue> {
      return g03(() => chain(backend.identity(this.core.h), hashIdentity));
    }

    metadataHashAt(pathFlags: PathFlagsValue, path: string): MaybeAsync<MetadataHashValue> {
      return g03(() =>
        chain(
          backend.identityAt(
            this.core.h,
            parsePath(path, err03),
            pathFlags.symlinkFollow === true,
          ),
          hashIdentity,
        )
      );
    }

    [Symbol.dispose](): void {
      backend.close(this.core.h);
    }
  }

  // Async backends: mark the 0.2 track's backend-touching methods
  // park-capable on the freshly-minted prototype (module header; A14).
  if (!backend.isSync) {
    const proto = Descriptor02.prototype as unknown as Record<string, (...a: never[]) => unknown>;
    for (const name of PARKED_02) {
      proto[name] = suspending(proto[name]);
    }
  }

  const getDirectories02 = (): [Descriptor02, string][] =>
    preopens.map(([h, name]) => [new Descriptor02(h, "directory", PREOPEN_FLAGS), name]);
  const getDirectories03 = (): [Descriptor03, string][] =>
    preopens.map(([h, name]) => [new Descriptor03(h, "directory", PREOPEN_FLAGS), name]);

  return {
    imports: {
      "wasi:filesystem/types@0.2": {
        Descriptor: Descriptor02,
        DirectoryEntryStream: DirectoryEntryStream02,
        // `filesystem-error-code(err: borrow<error>) -> option<error-code>`:
        // downcast succeeds exactly for the io errors OUR streams minted.
        filesystemErrorCode: (err: unknown): FsErrorCode | undefined =>
          err instanceof FsIoError ? err.code : undefined,
      },
      "wasi:filesystem/preopens@0.2": { getDirectories: getDirectories02 },
      "wasi:filesystem/types@0.3": { Descriptor: Descriptor03 },
      "wasi:filesystem/preopens@0.3": { getDirectories: getDirectories03 },
    },
  };
}
