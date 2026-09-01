// `@polyengine/wasi/filesystem-node` — `wasi:filesystem@0.2` + `@0.3` over the
// node `node:fs` builtin (via `process.getBuiltinModule`: real Node and
// Deno's stable node compat alike — the node-builtins-everywhere stance of
// sockets_platform.ts). It grants HOST FILESYSTEM access, so it never
// rides the default `wasi()` merge; preopens are explicit grants:
//
//   instantiate(a, { ...wasi(), ...filesystemNode({ preopens: { "/": "./sandbox" } }).imports })
//
// READ-ONLY BY DEFAULT: the grant above is read-only. Writes need the
// package-level `writable: true` — one flag for the whole
// implementation, never per-preopen (fs_provider.ts header for why, and
// for the enforcement site: it is the provider, not this backend).
//
// SYNC BY CONSTRUCTION: every backend op uses node's `*Sync` API, so the
// 0.2 track's sync WIT functions are served without parking — guests run
// in plain callback mode, no JSPI required (the park-capable marks stay off; see
// fs_provider.ts). The 0.3 track returns plain values from async funcs,
// which the runtime accepts.
//
// SECURITY: this containment is a CORRECTNESS mechanism, not a security
// boundary — see docs/security.md before granting a guest host access.
// It cannot see hardlinks or bind mounts (both resolve "inside" by every
// path-shaped measure) and it loses cross-process races. Guest paths are
// confined TEXTUALLY by fs_provider.ts ("`..`"
// cannot escape), and this backend adds PHYSICAL containment on top:
// every path-taking op realpaths the parent directory (and, when
// symlink-follow is set, chases the final component's link chain) and
// refuses — `not-permitted` — anything that resolves outside the
// preopen's realpath root. Symlinks the guest creates itself therefore
// cannot be used to read or write outside the preopen, and neither can
// symlinks that were already in the preopened tree (issue #177).
//
// Residual risk is cross-process TOCTOU: node has no openat2 /
// RESOLVE_BENEATH analogue, so between the realpath check and the OS
// call another PROCESS could swap a component for a symlink. The guest
// itself cannot interleave — every backend op is synchronous on the
// guest's own thread — so this is only reachable when something else
// with write access to the preopened tree races us.
//
// PLATFORM TRAPS the containment code deliberately works around — both
// observed on Deno's node compat, both silent, both only when the
// process runs WITHOUT blanket read/write permission (i.e. under this
// package's own `deno task test` flags, which is how they were found):
//   * `openSync` drops `O_NOFOLLOW`, so a nofollow open of a symlink
//     opens the target. `openAt` therefore raises ELOOP itself after an
//     lstat rather than trusting the flag.
//   * `realpathSync` normalizes `..` LEXICALLY, so
//     `realpathSync("<root>/link-pointing-out/..")` answers `<root>`
//     instead of the outside parent. Nothing here ever hands a `..` to
//     realpathSync: link targets are walked one component at a time
//     (see `walkReal`).
//
// Fidelity notes: `append` stats-then-writes (not O_APPEND atomic);
// set-times converts to seconds-resolution node utimes (ns precision is
// reported by stat but not settable); `..` resolves textually, not
// physically through symlinked intermediates.

import {
  type DescriptorType,
  type FilesystemAccessOptions,
  type FilesystemFragment,
  type FsBackend,
  type FsErrorCode,
  type FsIdentity,
  type FsStat,
  makeFilesystem,
  type MaybeAsync,
  type Opened,
  type OpenOptions,
  type TimeSpec,
} from "./internal/fs_provider.ts";

// --- the node:fs surface we consume (structural, no @types dependency) ------------

interface NodeBigIntStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  nlink: bigint;
  size: bigint;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
}

interface NodeDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface NodeFsModule {
  constants: {
    O_RDONLY: number;
    O_WRONLY: number;
    O_RDWR: number;
    O_CREAT: number;
    O_EXCL: number;
    O_TRUNC: number;
    O_NOFOLLOW: number;
    O_DIRECTORY: number;
  };
  openSync(path: string, flags: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  fstatSync(fd: number, opts: { bigint: true }): NodeBigIntStats;
  statSync(path: string, opts: { bigint: true }): NodeBigIntStats;
  lstatSync(path: string, opts: { bigint: true }): NodeBigIntStats;
  readdirSync(path: string, opts: { withFileTypes: true }): NodeDirent[];
  mkdirSync(path: string): void;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  linkSync(existingPath: string, newPath: string): void;
  symlinkSync(target: string, path: string): void;
  readlinkSync(path: string): string;
  ftruncateSync(fd: number, len: number): void;
  truncateSync(path: string, len: number): void;
  fsyncSync(fd: number): void;
  fdatasyncSync(fd: number): void;
  futimesSync(fd: number, atime: number, mtime: number): void;
  utimesSync(path: string, atime: number, mtime: number): void;
  lutimesSync(path: string, atime: number, mtime: number): void;
  realpathSync(path: string): string;
}

/** The `node:path` surface we consume (containment arithmetic). */
interface NodePathModule {
  sep: string;
  dirname(p: string): string;
  basename(p: string): string;
  isAbsolute(p: string): boolean;
}

/** `process.getBuiltinModule(name)`, if this host has it (Node, Deno, Bun). */
function nodeBuiltin(name: string): unknown {
  const proc = (globalThis as {
    process?: { getBuiltinModule?: (name: string) => unknown };
  }).process;
  const get = proc?.getBuiltinModule;
  return get === undefined ? undefined : get.call(proc, name);
}

// --- errno mapping ---------------------------------------------------------------

const ERRNO_MAP: Record<string, FsErrorCode> = {
  EACCES: "access",
  EPERM: "not-permitted",
  ENOENT: "no-entry",
  EEXIST: "exist",
  ENOTDIR: "not-directory",
  EISDIR: "is-directory",
  ENOTEMPTY: "not-empty",
  EINVAL: "invalid",
  ELOOP: "loop",
  EXDEV: "cross-device",
  ENAMETOOLONG: "name-too-long",
  EBUSY: "busy",
  EROFS: "read-only",
  EBADF: "bad-descriptor",
  EFBIG: "file-too-large",
  ENOSPC: "insufficient-space",
  EDQUOT: "quota",
  EMLINK: "too-many-links",
  ESPIPE: "invalid-seek",
  ENXIO: "no-such-device",
  ENODEV: "no-device",
  ETXTBSY: "text-file-busy",
  EOVERFLOW: "overflow",
  EINTR: "interrupted",
  EAGAIN: "would-block",
  ENOMEM: "insufficient-memory",
  ENOTSUP: "unsupported",
  EOPNOTSUPP: "unsupported",
  EILSEQ: "illegal-byte-sequence",
};

// --- the backend -----------------------------------------------------------------

/** A descriptor handle: dirs are path-only; files carry the open fd.
 * `root` is the realpath of the preopen this handle descends from — the
 * containment boundary every path-taking op is checked against. */
interface NodeHandle {
  path: string;
  root: string;
  type: DescriptorType;
  fd?: number;
}

function direntType(d: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}): DescriptorType {
  if (d.isDirectory()) return "directory";
  if (d.isFile()) return "regular-file";
  if (d.isSymbolicLink()) return "symbolic-link";
  if (d.isBlockDevice()) return "block-device";
  if (d.isCharacterDevice()) return "character-device";
  if (d.isFIFO()) return "fifo";
  if (d.isSocket()) return "socket";
  return "unknown";
}

function makeNodeBackend(fs: NodeFsModule, path: NodePathModule): FsBackend<NodeHandle> {
  const join = (base: NodeHandle, segments: string[]): string =>
    segments.length === 0 ? base.path : `${base.path}/${segments.join("/")}`;

  // --- physical containment (issue #177) -----------------------------------------
  //
  // fs_provider.ts confines guest paths textually; the OS still resolves
  // symlinks, so containment has to be re-established against REAL paths
  // before every OS call. `not-permitted` is the escape code, matching
  // parsePath's choice for `..` underflow and absolute paths. Raw EPERM
  // is what we throw: mapError names it, so both WIT tracks shape it.

  const escape = (full: string): Error =>
    Object.assign(new Error(`path escapes the preopen: ${full}`), { code: "EPERM" });

  /** `real` must be the root itself or strictly beneath it. */
  const requireInside = (real: string, root: string, full: string): void => {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (real !== root && !real.startsWith(prefix)) throw escape(full);
  };

  const errCode = (e: unknown): unknown => (e as { code?: unknown })?.code;

  const joinReal = (dir: string, seg: string): string =>
    dir.endsWith(path.sep) ? `${dir}${seg}` : `${dir}${path.sep}${seg}`;

  /**
   * Walk `rel` from the ALREADY-REALPATHED directory `dir`, one
   * component at a time, keeping the accumulated directory a realpath at
   * every step and requiring containment at every step.
   *
   * Why component-wise, and why `..` is handled here rather than handed
   * to the OS: `..` is where lexical and physical resolution diverge —
   * the kernel applies it after traversing the preceding component, so
   * with `esc` an escaping symlink, `esc/..` is the OUTSIDE parent while
   * any string collapse says "back where we started". realpathSync is
   * the physical authority, but it cannot be handed a `..` either:
   * Deno's node-compat realpathSync normalizes `..` LEXICALLY when the
   * process runs without blanket read permission — exactly the flags
   * `deno task test` uses — so `realpathSync("<root>/esc/..")` answers
   * `<root>` there and the outside parent under `-A`. Resolving one
   * component at a time keeps every string we hand to node free of
   * `..`, which is the only form both modes agree on.
   *
   * `..` itself is then a pure lexical `dirname` — and that is exact,
   * because `dir` is a realpath: it contains no symlinks and no `..`,
   * so its lexical parent IS its physical parent.
   */
  const walkReal = (dir: string, rel: string, root: string, full: string): string => {
    let d = dir;
    for (const seg of rel.split(path.sep)) {
      if (seg === "" || seg === ".") continue;
      // A climb above the root is refused here rather than allowed to
      // dip back in, matching parsePath's `..`-underflow rule.
      d = seg === ".." ? path.dirname(d) : fs.realpathSync(joinReal(d, seg));
      requireInside(d, root, full);
    }
    return d;
  };

  /**
   * Follow the final component's symlink chain, requiring the result to
   * land inside `root`. `parentReal` is the caller's already-resolved,
   * already-contained parent directory. Dangling chains are chased so a
   * create through `link -> outside/new` cannot plant a file outside.
   */
  const chaseFinal = (full: string, root: string, parentReal: string): void => {
    // `dir` is a realpath at all times; `name` is a single component
    // (never "." or ".." — those are folded into `dir` below). `full`
    // itself carries no "." / ".." segments: parsePath removed them
    // before the backend saw the path.
    let dir = parentReal;
    let name = path.basename(full);
    for (let i = 0; i < 40; i++) {
      if (name === "") {
        requireInside(dir, root, full); // chain ended at a directory
        return;
      }
      const cur = joinReal(dir, name);
      try {
        // The whole chain resolved: this is the physical truth the OS
        // call will see, and the string is `..`-free, so both Deno
        // permission modes agree on it. One check settles it.
        requireInside(fs.realpathSync(cur), root, full);
        return;
      } catch (e) {
        // EPERM (our escape), ELOOP, ENOTDIR, EACCES … all stand.
        if (errCode(e) !== "ENOENT") throw e;
      }
      // ENOENT: either `cur` does not exist (fine — its directory is
      // contained, so a create lands inside), or it is a link whose
      // chain dangles. Only the latter needs chasing.
      let st: NodeBigIntStats;
      try {
        st = fs.lstatSync(cur, { bigint: true });
      } catch {
        return; // genuinely absent
      }
      if (!st.isSymbolicLink()) return;
      const target = fs.readlinkSync(cur);
      // Split off the last component TEXTUALLY — this only separates
      // "directory part" from "name", it normalizes nothing. The
      // directory part is then walked physically; absolute and relative
      // targets differ only in where that walk starts.
      const cut = target.lastIndexOf(path.sep);
      name = cut < 0 ? target : target.slice(cut + 1);
      dir = walkReal(
        path.isAbsolute(target) ? path.sep : dir,
        cut < 0 ? "" : target.slice(0, cut),
        root,
        full,
      );
      if (name === "." || name === "..") {
        dir = walkReal(dir, name, root, full);
        name = "";
      }
    }
    throw Object.assign(new Error("too many symbolic links"), { code: "ELOOP" });
  };

  /**
   * The guard every path-taking op runs before touching the OS: resolve
   * the PARENT physically and require containment; with `follow`, the
   * final component's link chain must stay contained too. Returns the
   * path to hand to node.
   */
  const guard = (base: NodeHandle, segments: string[], follow: boolean): string => {
    const full = join(base, segments);
    if (segments.length === 0) {
      // The base itself (no parent to check — its parent is typically the
      // preopen's own parent, outside the root by construction).
      requireInside(fs.realpathSync(full), base.root, full);
      return full;
    }
    const parentReal = fs.realpathSync(path.dirname(full));
    requireInside(parentReal, base.root, full);
    if (follow) chaseFinal(full, base.root, parentReal);
    return full;
  };

  const requireFd = (h: NodeHandle): number => {
    if (h.fd === undefined) {
      // Directory handles carry no fd; byte ops on one are EISDIR.
      throw Object.assign(new Error("descriptor is a directory"), { code: "EISDIR" });
    }
    return h.fd;
  };

  const statOf = (st: NodeBigIntStats): FsStat => ({
    type: direntType(st),
    linkCount: st.nlink,
    size: st.size,
    atimeNs: st.atimeNs,
    mtimeNs: st.mtimeNs,
    ctimeNs: st.ctimeNs,
  });

  const statHandle = (h: NodeHandle): NodeBigIntStats =>
    h.fd === undefined ? fs.statSync(h.path, { bigint: true }) : fs.fstatSync(h.fd, { bigint: true });

  /** node utimes take seconds (fractional); "no-change" re-applies the
   * current value (POSIX UTIME_OMIT has no node spelling). */
  const timeArgs = (
    current: () => NodeBigIntStats,
    atime: TimeSpec,
    mtime: TimeSpec,
  ): [number, number] => {
    const now = Date.now() / 1000;
    const secs = (spec: TimeSpec, currentNs: () => bigint): number => {
      switch (spec.kind) {
        case "no-change":
          return Number(currentNs()) / 1e9;
        case "now":
          return now;
        case "timestamp":
          return Number(spec.ns) / 1e9;
      }
    };
    let st: NodeBigIntStats | undefined;
    const cached = (): NodeBigIntStats => (st ??= current());
    return [
      secs(atime, () => cached().atimeNs),
      secs(mtime, () => cached().mtimeNs),
    ];
  };

  return {
    isSync: true,

    mapError(e: unknown): FsErrorCode {
      const code = (e as { code?: unknown })?.code;
      return (typeof code === "string" ? ERRNO_MAP[code] : undefined) ?? "io";
    },

    openAt(base, segments, opts): Opened<NodeHandle> {
      // Guarded BEFORE any fs call, including the directory fast path
      // below — which returns a path handle without ever reaching
      // openSync, so O_NOFOLLOW alone never covered directory opens.
      const full = guard(base, segments, opts.follow);
      const root = base.root;
      const c = fs.constants;
      let flags = opts.write ? (opts.read ? c.O_RDWR : c.O_WRONLY) : c.O_RDONLY;
      if (opts.create) flags |= c.O_CREAT;
      if (opts.exclusive) flags |= c.O_EXCL;
      if (opts.truncate) flags |= c.O_TRUNC;
      if (!opts.follow) flags |= c.O_NOFOLLOW;
      if (opts.directory) flags |= c.O_DIRECTORY;
      // Directories: path handles (no fd — every dir op is path-based).
      const st = (opts.follow ? fs.statSync : fs.lstatSync).bind(fs);
      let existing: NodeBigIntStats | undefined;
      try {
        existing = st(full, { bigint: true });
      } catch {
        existing = undefined; // may be about to be created
      }
      if (!opts.follow && existing?.isSymbolicLink()) {
        // O_NOFOLLOW is NOT dependable here: Deno's node:fs compat drops
        // the flag when the process runs without blanket read/write
        // permission (openSync then happily opens the link target). The
        // POSIX answer for a nofollow open of a symlink is ELOOP, so we
        // give it ourselves rather than trusting the flag.
        throw Object.assign(new Error("nofollow open of a symbolic link"), { code: "ELOOP" });
      }
      if (existing?.isDirectory()) {
        if (opts.exclusive && opts.create) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
        return { handle: { path: full, root, type: "directory" }, type: "directory" };
      }
      if (opts.directory && existing !== undefined) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
      const fd = fs.openSync(full, flags);
      const opened = fs.fstatSync(fd, { bigint: true });
      const type = direntType(opened);
      if (type === "directory") {
        // Raced into a directory: fall back to a path handle.
        fs.closeSync(fd);
        return { handle: { path: full, root, type }, type };
      }
      return { handle: { path: full, root, type, fd }, type };
    },

    close(h): void {
      if (h.fd !== undefined) fs.closeSync(h.fd);
    },

    stat: (h): FsStat => statOf(statHandle(h)),

    statAt(base, segments, follow): FsStat {
      const st = (follow ? fs.statSync : fs.lstatSync).bind(fs);
      return statOf(st(guard(base, segments, follow), { bigint: true }));
    },

    read(h, length, offset): Uint8Array {
      const out = new Uint8Array(length);
      const n = fs.readSync(requireFd(h), out, 0, length, offset);
      return out.subarray(0, n);
    },

    write(h, buffer, offset): number {
      return fs.writeSync(requireFd(h), buffer, 0, buffer.length, offset);
    },

    append(h, buffer): number {
      const fd = requireFd(h);
      const size = Number(fs.fstatSync(fd, { bigint: true }).size);
      return fs.writeSync(fd, buffer, 0, buffer.length, size);
    },

    setSize(h, size): void {
      if (h.fd === undefined) fs.truncateSync(h.path, size);
      else fs.ftruncateSync(h.fd, size);
    },

    setTimes(h, atime, mtime): void {
      const [a, m] = timeArgs(() => statHandle(h), atime, mtime);
      if (h.fd === undefined) fs.utimesSync(h.path, a, m);
      else fs.futimesSync(h.fd, a, m);
    },

    setTimesAt(base, segments, follow, atime, mtime): void {
      const full = guard(base, segments, follow);
      const st = (follow ? fs.statSync : fs.lstatSync).bind(fs);
      const [a, m] = timeArgs(() => st(full, { bigint: true }), atime, mtime);
      (follow ? fs.utimesSync : fs.lutimesSync).call(fs, full, a, m);
    },

    syncAll(h): void {
      if (h.fd !== undefined) fs.fsyncSync(h.fd);
    },

    syncData(h): void {
      if (h.fd !== undefined) fs.fdatasyncSync(h.fd);
    },

    readDirectory(h): { name: string; type: DescriptorType }[] {
      // Handle-only op: re-check the handle's own path (a directory
      // handle is path-based, so it is re-resolved on every listing).
      requireInside(fs.realpathSync(h.path), h.root, h.path);
      return fs.readdirSync(h.path, { withFileTypes: true }).map((d) => ({
        name: d.name,
        type: direntType(d),
      }));
    },

    createDirectoryAt(base, segments): void {
      fs.mkdirSync(guard(base, segments, false));
    },

    removeDirectoryAt(base, segments): void {
      fs.rmdirSync(guard(base, segments, false));
    },

    unlinkFileAt(base, segments): void {
      fs.unlinkSync(guard(base, segments, false));
    },

    renameAt(oldBase, oldSegments, newBase, newSegments): void {
      // Both endpoints are guarded; neither op follows the final link.
      fs.renameSync(
        guard(oldBase, oldSegments, false),
        guard(newBase, newSegments, false),
      );
    },

    linkAt(oldBase, oldSegments, follow, newBase, newSegments): void {
      fs.linkSync(
        guard(oldBase, oldSegments, follow),
        guard(newBase, newSegments, false),
      );
    },

    symlinkAt(target, base, segments): void {
      // The LINK path is confined; `target` is deliberately not
      // restricted (an absolute or escaping target is inert — every
      // later resolution through it is refused by `guard`). wasmtime-wasi
      // could not be confirmed to reject absolute targets at creation,
      // so we stay permissive: containment is enforced at resolution.
      fs.symlinkSync(target, guard(base, segments, false));
    },

    readlinkAt(base, segments): string {
      return fs.readlinkSync(guard(base, segments, false));
    },

    identity(h): FsIdentity {
      const st = statHandle(h);
      return { a: st.dev, b: st.ino };
    },

    identityAt(base, segments, follow): FsIdentity {
      const st = (follow ? fs.statSync : fs.lstatSync).bind(fs);
      const s = st(guard(base, segments, follow), { bigint: true });
      return { a: s.dev, b: s.ino };
    },

    isSame(a, b): boolean {
      const sa = statHandle(a);
      const sb = statHandle(b);
      return sa.dev === sb.dev && sa.ino === sb.ino;
    },
  };
}

// --- the fragment ----------------------------------------------------------------

export interface FilesystemNodeOptions extends FilesystemAccessOptions {
  /**
   * Guest name → host directory path. Each entry becomes a preopen
   * (`preopens#get-directories`). No default: filesystem access is an
   * explicit grant. Host paths are resolved (realpath) at construction
   * and must name directories. Read-only unless `writable` is set.
   */
  preopens: Record<string, string>;
}

/**
 * `wasi:filesystem` over node's `node:fs` builtin (module header).
 * Serves both the `@0.2` and `@0.3` tracks.
 */
export function filesystemNode(options: FilesystemNodeOptions): FilesystemFragment {
  const fs = nodeBuiltin("node:fs") as NodeFsModule | undefined;
  const path = nodeBuiltin("node:path") as NodePathModule | undefined;
  if (fs === undefined || path === undefined) {
    throw new TypeError(
      "filesystemNode: no `process.getBuiltinModule` on this host — " +
        "node:fs and node:path are required (real Node, or Deno's stable " +
        "node compat); browsers want @polyengine/wasi/filesystem-web",
    );
  }
  const preopens: [NodeHandle, string][] = Object.entries(options.preopens).map(
    ([guestName, hostPath]) => {
      const real = fs.realpathSync(hostPath);
      if (!fs.statSync(real, { bigint: true }).isDirectory()) {
        throw new TypeError(`filesystemNode: preopen ${hostPath} is not a directory`);
      }
      return [{ path: real, root: real, type: "directory" }, guestName];
    },
  );
  return makeFilesystem(makeNodeBackend(fs, path), preopens, {
    writable: options.writable === true,
  });
}

// Re-exported for tests and typed embedders.
export type { FilesystemFragment, MaybeAsync };
