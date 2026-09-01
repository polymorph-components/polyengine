// `@polyengine/wasi/filesystem-web` — `wasi:filesystem@0.2` + `@0.3` over the
// Origin Private File System (the browser's `navigator.storage` file API;
// any object implementing the structural handle interfaces below works,
// including in-memory fakes for tests). Preopens are explicit handle
// grants:
//
//   const root = await navigator.storage.getDirectory();
//   instantiate(a, { ...wasi(), ...filesystemWeb({ preopens: { "/": root } }).imports })
//
// READ-ONLY BY DEFAULT: the grant above is read-only. Writes need the
// package-level `writable: true` — one flag for the whole
// implementation, never per-preopen (fs_provider.ts header for why, and
// for the enforcement site: it is the provider, not this backend).
//
// ASYNC BY CONSTRUCTION: every OPFS op returns a promise, so the 0.2
// track's sync WIT descriptor methods are marked park-capable (embedder-api.md
// §"The WASI parking kernel", on the per-call class prototypes — fs_provider.ts):
// a p2 guest that
// touches the filesystem parks through the suspending kernel and needs
// JSPI; on engines without it a genuine wait raises `NeedsJspi` at the
// park site. The 0.3 track is async in WIT and needs no parking. (The
// synchronous OPFS access handles — `createSyncAccessHandle` — exist
// only in dedicated workers; this impl deliberately targets the portable
// async API.)
//
// Fidelity notes, honest and deliberate:
//   * every positional write is open-writable → write → close (OPFS
//     writables COMMIT on close; keeping one open would make reads stale
//     and crashes lossy). Durable and simple, not fast.
//   * OPFS has no symlinks, hard links, or settable timestamps:
//     `link-at`/`symlink-at`/`readlink-at`/`set-times*` fail
//     `unsupported`. Stat reports mtime only (files; from
//     `File.lastModified`, ms resolution), link-count 1.
//   * `exclusive` create and `rename-at` are emulated (probe-then-act /
//     `move()` where the engine ships it, copy+delete for files
//     otherwise; directory renames without `move()` are `unsupported`).
//   * object identity (metadata-hash, is-same-object) derives from the
//     guest path (FNV via the provider) and `isSameEntry`.

import {
  type DescriptorType,
  type FilesystemAccessOptions,
  type FilesystemFragment,
  type FsBackend,
  type FsErrorCode,
  type FsIdentity,
  type FsStat,
  makeFilesystem,
  type Opened,
  type OpenOptions,
} from "./internal/fs_provider.ts";

// --- the OPFS surface we consume (structural: works with fakes) -------------------

export interface OpfsFileLike {
  readonly size: number;
  readonly lastModified: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsWritable {
  write(params: { type: "write"; position: number; data: Uint8Array }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<OpfsFileLike>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  isSameEntry(other: OpfsFileHandle | OpfsDirectoryHandle): Promise<boolean>;
  /** Chromium's FileSystemHandle.move; absent on Firefox/Safari. */
  move?(parent: OpfsDirectoryHandle, name: string): Promise<void>;
}

export interface OpfsDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, OpfsDirectoryHandle | OpfsFileHandle]>;
  isSameEntry(other: OpfsFileHandle | OpfsDirectoryHandle): Promise<boolean>;
  move?(parent: OpfsDirectoryHandle, name: string): Promise<void>;
}

// --- error mapping -----------------------------------------------------------------

const DOM_ERROR_MAP: Record<string, FsErrorCode> = {
  NotFoundError: "no-entry",
  TypeMismatchError: "not-directory",
  NotAllowedError: "access",
  SecurityError: "access",
  QuotaExceededError: "quota",
  InvalidModificationError: "not-empty",
  AbortError: "interrupted",
  NoModificationAllowedError: "busy",
};

function domError(code: FsErrorCode, message: string): Error {
  return Object.assign(new Error(message), { fsCode: code });
}

// --- the backend -------------------------------------------------------------------

/** A descriptor handle: the OPFS handle plus its guest path (identity). */
interface WebHandle {
  handle: OpfsDirectoryHandle | OpfsFileHandle;
  path: string;
}

const NS_PER_MS = 1_000_000n;

function makeWebBackend(): FsBackend<WebHandle> {
  const childPath = (base: WebHandle, segments: string[]): string =>
    segments.length === 0 ? base.path : `${base.path}/${segments.join("/")}`;

  const requireDir = (h: WebHandle): OpfsDirectoryHandle => {
    if (h.handle.kind !== "directory") {
      throw domError("not-directory", `${h.path}: not a directory`);
    }
    return h.handle;
  };

  const requireFile = (h: WebHandle): OpfsFileHandle => {
    if (h.handle.kind !== "file") {
      throw domError("is-directory", `${h.path}: is a directory`);
    }
    return h.handle;
  };

  /** Walk intermediate segments (never creating); returns the parent dir
   * for the final component, or the base itself for []. */
  const walk = async (
    base: WebHandle,
    segments: string[],
  ): Promise<OpfsDirectoryHandle> => {
    let dir = requireDir(base);
    for (const seg of segments) dir = await dir.getDirectoryHandle(seg);
    return dir;
  };

  const parentOf = (base: WebHandle, segments: string[]) => walk(base, segments.slice(0, -1));

  /** Resolve segments to a handle (file or directory), never creating. */
  const resolve = async (
    base: WebHandle,
    segments: string[],
  ): Promise<OpfsDirectoryHandle | OpfsFileHandle> => {
    if (segments.length === 0) return base.handle;
    const parent = await parentOf(base, segments);
    const name = segments[segments.length - 1];
    try {
      return await parent.getFileHandle(name);
    } catch (e) {
      if ((e as { name?: string })?.name === "TypeMismatchError") {
        return await parent.getDirectoryHandle(name);
      }
      throw e;
    }
  };

  const statOfFile = async (file: OpfsFileHandle): Promise<FsStat> => {
    const f = await file.getFile();
    return {
      type: "regular-file",
      linkCount: 1n,
      size: BigInt(f.size),
      mtimeNs: BigInt(f.lastModified) * NS_PER_MS,
    };
  };

  const statOfHandle = (h: OpfsDirectoryHandle | OpfsFileHandle): Promise<FsStat> =>
    h.kind === "file" ? statOfFile(h) : Promise.resolve({
      type: "directory" as const,
      linkCount: 1n,
      size: 0n,
    });

  /** FNV-1a over the guest path: OPFS has no dev/ino (module header). */
  const pathIdentity = (path: string): FsIdentity => {
    let h = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(path)) {
      h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return { a: h, b: BigInt(path.length) };
  };

  const writeAt = async (file: OpfsFileHandle, data: Uint8Array, position: number): Promise<void> => {
    const w = await file.createWritable({ keepExistingData: true });
    try {
      await w.write({ type: "write", position, data });
    } finally {
      await w.close(); // commit (or persist what was written before a failure)
    }
  };

  return {
    isSync: false,

    mapError(e: unknown): FsErrorCode {
      const tagged = (e as { fsCode?: FsErrorCode })?.fsCode;
      if (tagged !== undefined) return tagged;
      const name = (e as { name?: unknown })?.name;
      return (typeof name === "string" ? DOM_ERROR_MAP[name] : undefined) ?? "io";
    },

    async openAt(base, segments, opts): Promise<Opened<WebHandle>> {
      const path = childPath(base, segments);
      if (segments.length === 0) {
        // Opening "." — the base itself.
        if (opts.exclusive && opts.create) throw domError("exist", `${path}: exists`);
        return { handle: { handle: base.handle, path }, type: base.handle.kind === "file" ? "regular-file" : "directory" };
      }
      const parent = await parentOf(base, segments);
      const name = segments[segments.length - 1];

      if (opts.directory) {
        const dir = await parent.getDirectoryHandle(name, { create: opts.create });
        return { handle: { handle: dir, path }, type: "directory" };
      }

      // Does it already exist, and as what?
      let existing: OpfsDirectoryHandle | OpfsFileHandle | undefined;
      try {
        existing = await parent.getFileHandle(name);
      } catch (e) {
        const en = (e as { name?: string })?.name;
        if (en === "TypeMismatchError") existing = await parent.getDirectoryHandle(name);
        else if (en !== "NotFoundError") throw e;
      }

      if (existing?.kind === "directory") {
        if (opts.create && opts.exclusive) throw domError("exist", `${path}: exists`);
        return { handle: { handle: existing, path }, type: "directory" };
      }
      if (existing !== undefined && opts.create && opts.exclusive) {
        throw domError("exist", `${path}: exists`);
      }
      const file = existing as OpfsFileHandle | undefined ??
        await (opts.create
          ? parent.getFileHandle(name, { create: true })
          : parent.getFileHandle(name)); // throws NotFoundError
      if (opts.truncate) {
        const w = await file.createWritable({ keepExistingData: false });
        await w.close();
      }
      return { handle: { handle: file, path }, type: "regular-file" };
    },

    close(_h): void {
      // OPFS handles hold no OS resources between operations.
    },

    stat: (h) => statOfHandle(h.handle),

    async statAt(base, segments, _follow): Promise<FsStat> {
      return await statOfHandle(await resolve(base, segments));
    },

    async read(h, length, offset): Promise<Uint8Array> {
      const f = await requireFile(h).getFile();
      if (offset >= f.size || length === 0) return new Uint8Array(0);
      const end = Math.min(offset + length, f.size);
      return new Uint8Array(await f.slice(offset, end).arrayBuffer());
    },

    async write(h, buffer, offset): Promise<number> {
      await writeAt(requireFile(h), buffer, offset);
      return buffer.length;
    },

    async append(h, buffer): Promise<number> {
      const file = requireFile(h);
      const size = (await file.getFile()).size;
      await writeAt(file, buffer, size);
      return buffer.length;
    },

    async setSize(h, size): Promise<void> {
      const w = await requireFile(h).createWritable({ keepExistingData: true });
      try {
        await w.truncate(size);
      } finally {
        await w.close();
      }
    },

    setTimes(): never {
      throw domError("unsupported", "OPFS: timestamps are not settable");
    },

    setTimesAt(): never {
      throw domError("unsupported", "OPFS: timestamps are not settable");
    },

    syncAll(): void {
      // Per-operation commits (module header): nothing buffered to sync.
    },

    syncData(): void {},

    async readDirectory(h): Promise<{ name: string; type: DescriptorType }[]> {
      const out: { name: string; type: DescriptorType }[] = [];
      for await (const [name, handle] of requireDir(h).entries()) {
        out.push({ name, type: handle.kind === "directory" ? "directory" : "regular-file" });
      }
      return out;
    },

    async createDirectoryAt(base, segments): Promise<void> {
      const parent = await parentOf(base, segments);
      const name = segments[segments.length - 1];
      // POSIX mkdir fails on ANY existing entry; getDirectoryHandle
      // ({create}) would silently accept an existing directory.
      let exists = true;
      try {
        await resolve({ handle: parent, path: "" }, [name]);
      } catch (e) {
        if ((e as { name?: string })?.name !== "NotFoundError") throw e;
        exists = false;
      }
      if (exists) throw domError("exist", `${childPath(base, segments)}: exists`);
      await parent.getDirectoryHandle(name, { create: true });
    },

    async removeDirectoryAt(base, segments): Promise<void> {
      const parent = await parentOf(base, segments);
      const name = segments[segments.length - 1];
      await parent.getDirectoryHandle(name); // TypeMismatchError → not-directory
      await parent.removeEntry(name); // InvalidModificationError → not-empty
    },

    async unlinkFileAt(base, segments): Promise<void> {
      const parent = await parentOf(base, segments);
      const name = segments[segments.length - 1];
      try {
        await parent.getFileHandle(name);
      } catch (e) {
        if ((e as { name?: string })?.name === "TypeMismatchError") {
          throw domError("is-directory", `${childPath(base, segments)}: is a directory`);
        }
        throw e;
      }
      await parent.removeEntry(name);
    },

    async renameAt(oldBase, oldSegments, newBase, newSegments): Promise<void> {
      const target = await resolve(oldBase, oldSegments);
      const newParent = await parentOf(newBase, newSegments);
      const newName = newSegments[newSegments.length - 1];
      if (target.move !== undefined) {
        await target.move(newParent, newName);
        return;
      }
      if (target.kind === "directory") {
        throw domError("unsupported", "OPFS: directory rename requires FileSystemHandle.move");
      }
      // Fallback: copy + delete (non-atomic, module header).
      const bytes = new Uint8Array(await (await target.getFile()).arrayBuffer());
      const dest = await newParent.getFileHandle(newName, { create: true });
      const w = await dest.createWritable({ keepExistingData: false });
      try {
        await w.write({ type: "write", position: 0, data: bytes });
      } finally {
        await w.close();
      }
      const oldParent = await parentOf(oldBase, oldSegments);
      await oldParent.removeEntry(oldSegments[oldSegments.length - 1]);
    },

    // linkAt / symlinkAt / readlinkAt: absent → the provider answers
    // `unsupported` (OPFS has no links).

    identity: (h) => pathIdentity(h.path),

    async identityAt(base, segments, _follow): Promise<FsIdentity> {
      await resolve(base, segments); // existence check (NotFound → no-entry)
      return pathIdentity(childPath(base, segments));
    },

    isSame(a, b): Promise<boolean> {
      return a.handle.isSameEntry(b.handle);
    },
  };
}

// --- the fragment ------------------------------------------------------------------

export interface FilesystemWebOptions extends FilesystemAccessOptions {
  /**
   * Guest name → OPFS directory handle. Each entry becomes a preopen.
   * No default: filesystem access is an explicit grant — pass
   * `await navigator.storage.getDirectory()` (or any structural
   * equivalent, e.g. an in-memory fake) yourself. Read-only unless
   * `writable` is set.
   */
  preopens: Record<string, OpfsDirectoryHandle>;
}

/**
 * `wasi:filesystem` over the Origin Private File System (module header).
 * Serves both the `@0.2` (parking, JSPI) and `@0.3` tracks.
 */
export function filesystemWeb(options: FilesystemWebOptions): FilesystemFragment {
  const preopens: [WebHandle, string][] = Object.entries(options.preopens).map(
    ([guestName, handle]) => {
      if (handle.kind !== "directory") {
        throw new TypeError(`filesystemWeb: preopen ${guestName} is not a directory handle`);
      }
      return [{ handle, path: guestName }, guestName];
    },
  );
  return makeFilesystem(makeWebBackend(), preopens, {
    writable: options.writable === true,
  });
}

export type { FilesystemFragment };
