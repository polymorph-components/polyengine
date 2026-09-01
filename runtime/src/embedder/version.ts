// Version-canonical import resolution (contracts/embedder-api.md
// §"Version canonicalization").
//
// Authorities, read before writing this:
//   * Explainer.md §"canonical interface names" (`canonversion`) — the spec's
//     compatibility-track split;
//   * wasmtime-environ `component::names::{NameMap, alternate_lookup_key}`,
//     which is what `component::Linker` and `Component::get_export` actually
//     do. This file is a transcription of `alternate_lookup_key`'s rule plus
//     the linker's max-wins track claim.
//
// The rule in one paragraph: an import id is matched **exactly** first; if
// that fails, it is matched against whatever provider claimed its
// *compatibility track*, and a track is claimed by the highest-versioned
// registration on it. Prereleases and `0.0.z` have no track and so are
// exact-only. Registering both a track key and full-versioned keys on one
// track is an ambiguity, refused at registration rather than resolved by a
// precedence rule.

/** Fault in how the embedder registered its imports. */
export class ImportRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRegistrationError";
  }
}

/** Fault resolving a component's import against the registered providers. */
export class ImportResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportResolutionError";
  }
}

/**
 * A parsed `name@version` interface id. `version` is null when unversioned.
 * @internal — interface-id parsing internals; embedders write ids, the
 * runtime parses them.
 */
export interface ParsedId {
  /** The id with the version suffix removed (`wasi:clocks/monotonic-clock`). */
  base: string;
  /** The raw version text, or null. */
  version: string | null;
  /** Parsed semver, or null when unversioned / unparseable. */
  semver: Semver | null;
}

/**
 * @internal — version-resolution internals; §"Version canonicalization" of
 * contracts/embedder-api.md is implemented here, not called by hosts.
 */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty when there is none. */
  prerelease: string[];
  build: string | null;
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Split an interface id at its LAST `@`.
 *
 * Last, not first: a package name may not contain `@`, but being explicit
 * costs nothing and matches how wasmtime splits (`name.rfind('@')`).
 * @internal — version-resolution internals.
 */
export function parseInterfaceId(id: string): ParsedId {
  const at = id.lastIndexOf("@");
  if (at < 0) return { base: id, version: null, semver: null };
  const base = id.slice(0, at);
  const version = id.slice(at + 1);
  return { base, version, semver: parseSemver(version) };
}

/** @internal — version-resolution internals. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER.exec(v);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split("."),
    build: m[5] ?? null,
  };
}

/**
 * The compatibility-track key of an interface id, or null when the id belongs
 * to no track (unversioned, unparseable, prerelease, or `0.0.z`).
 *
 * Mirrors wasmtime `alternate_lookup_key`:
 *   - `major > 0`            -> `base@{major}`      (`1.2.3` -> `@1`)
 *   - `major == 0, minor > 0`-> `base@0.{minor}`    (`0.2.6` -> `@0.2`)
 *   - `0.0.z`                -> none (patch-only versions are compatible with
 *                               nothing)
 *   - any prerelease         -> none (wasmtime treats prereleases as
 *                               exact-only; the historic WASI `0.2.0-rc`
 *                               snapshots are exactly the phenomenon this
 *                               exclusion protects — same track on paper,
 *                               divergent function sets in fact)
 *
 * Build metadata is ignored for track purposes (`2.1.2+abc` -> `@2`), as
 * semver requires.
 * @internal — version-resolution internals.
 */
export function trackKey(id: string): string | null {
  const p = parseInterfaceId(id);
  if (p.semver === null) return null;
  return trackKeyOf(p.base, p.semver);
}

function trackKeyOf(base: string, v: Semver): string | null {
  if (v.prerelease.length > 0) return null;
  if (v.major > 0) return `${base}@${v.major}`;
  if (v.minor > 0) return `${base}@0.${v.minor}`;
  return null; // 0.0.z
}

/**
 * Is `id` itself spelled as a *track key* (`ns:pkg/iface@0.2`, `…@1`)?
 *
 * Note `semver::Version::parse("0.2")` fails — which is exactly why the two
 * mechanisms compose: a track key can never be mistaken for a full version,
 * and a full version never generates a track key equal to itself.
 * @internal — version-resolution internals.
 */
export function asTrackKeySpelling(id: string): string | null {
  const p = parseInterfaceId(id);
  if (p.version === null || p.semver !== null) return null;
  // `@0` is refused: no version canonicalizes to it (major 0 tracks the
  // MINOR, `@0.n`), so registering it could only ever be a dead entry.
  if (/^\d+$/.test(p.version)) return p.version === "0" ? null : id;
  if (/^0\.\d+$/.test(p.version)) return id;
  return null;
}

interface TrackClaim {
  /** The registered key that claims this track. */
  key: string;
  /** Its version, or null when the key IS the track key. */
  version: Semver | null;
}

/**
 * Registration table over the embedder's imports record.
 *
 * Only the *interface-id* keys participate: world-level bare imports live at
 * the record's top level under camelCase names and are matched by exact
 * string equality, never by version machinery.
 * @internal — built by `instantiate` from the embedder's plain imports
 * record; hosts never construct one.
 */
export class ImportResolver {
  readonly #exact = new Map<string, unknown>();
  readonly #tracks = new Map<string, TrackClaim>();
  /** base id -> the unversioned key registered for it, if any. */
  readonly #unversioned = new Map<string, string>();

  constructor(record: Record<string, unknown>) {
    for (const key of Object.keys(record)) {
      if (this.#exact.has(key)) {
        throw new ImportRegistrationError(`duplicate import key '${key}'`);
      }
      this.#exact.set(key, record[key]);
      this.#register(key);
    }
  }

  #register(key: string): void {
    const trackSpelling = asTrackKeySpelling(key);
    if (trackSpelling !== null) {
      this.#claim(trackSpelling, { key, version: null });
      return;
    }
    const p = parseInterfaceId(key);
    if (p.version === "0") {
      throw new ImportRegistrationError(
        `import key '${key}': '@0' is not a compatibility track. Major 0 ` +
          `tracks the MINOR version (\`@0.2\`), so no version canonicalizes ` +
          `to '@0' and this registration could never be resolved.`,
      );
    }
    if (p.version === null) {
      // Unversioned: matched exactly and never folded onto a track (the banned
      // defect is version-agnostic keys merging distinct semver tracks).
      // Recorded so resolution can *say so* instead of reporting a
      // bare "not provided".
      if (p.base.includes("/") || p.base.includes(":")) {
        this.#unversioned.set(p.base, key);
      }
      return;
    }
    if (p.semver === null) return; // unparseable version: exact-only
    const track = trackKeyOf(p.base, p.semver);
    if (track !== null) this.#claim(track, { key, version: p.semver });
  }

  #claim(track: string, claim: TrackClaim): void {
    const held = this.#tracks.get(track);
    if (held === undefined) {
      this.#tracks.set(track, claim);
      return;
    }
    // "Registering both a track key and full-versioned keys on the same track
    // is refused at registration (ambiguity is an error, not a precedence
    // rule)" — contracts/embedder-api.md §"Version canonicalization".
    if ((held.version === null) !== (claim.version === null)) {
      const [t, f] = held.version === null
        ? [held.key, claim.key]
        : [claim.key, held.key];
      throw new ImportRegistrationError(
        `import registration is ambiguous on compatibility track '${track}': ` +
          `the track key '${t}' and the full version '${f}' are both ` +
          `registered. Register one or the other, never both.`,
      );
    }
    if (held.version === null) {
      throw new ImportRegistrationError(
        `compatibility track '${track}' is claimed twice ('${held.key}' and ` +
          `'${claim.key}')`,
      );
    }
    // max-wins (wasmtime's linker rule).
    if (compareSemver(claim.version!, held.version) > 0) {
      this.#tracks.set(track, claim);
    }
  }

  /** Every registered key, in registration order. */
  keys(): string[] {
    return [...this.#exact.keys()];
  }

  /**
   * Resolve one component import name. Returns `undefined` when nothing is
   * registered for it; throws when a registration *nearly* matches in a way
   * the contract bans (unversioned folding), because silently reporting
   * "not provided" would hide the real mistake.
   */
  resolve(id: string): { key: string; value: unknown } | undefined {
    if (this.#exact.has(id)) return { key: id, value: this.#exact.get(id) };
    const p = parseInterfaceId(id);
    if (p.semver !== null) {
      const track = trackKeyOf(p.base, p.semver);
      if (track !== null) {
        const claim = this.#tracks.get(track);
        if (claim !== undefined) {
          return { key: claim.key, value: this.#exact.get(claim.key) };
        }
      }
      // CONTRACT: contracts/embedder-api.md §"Version canonicalization" bans
      // "unversioned folding": "unversioned keys -> error". Read
      // conservatively: an unversioned key is still a legal
      // *exact* match for an unversioned import (the ban is about folding
      // distinct semver tracks together, and unversioned WIT interfaces
      // exist), but it may never serve a *versioned* import. That attempt is
      // refused loudly here rather than reported as a plain "not provided".
      const un = this.#unversioned.get(p.base);
      if (un !== undefined) {
        throw new ImportResolutionError(
          `import '${id}' is versioned but the only registration for ` +
            `'${p.base}' is the unversioned key '${un}'. Version-agnostic ` +
            `folding is banned (contracts/embedder-api.md §"Version canonicalization"): ` +
            `register '${p.base}@${p.version}' or the compatibility-track ` +
            `key '${trackKeyOf(p.base, p.semver) ?? p.base + "@" + p.version}'.`,
        );
      }
      return undefined;
    }
    if (p.version === null) {
      // An unversioned import against versioned registrations: the same ban,
      // read in the other direction.
      const near = [...this.#exact.keys()].filter((k) =>
        parseInterfaceId(k).base === p.base
      );
      if (near.length > 0) {
        throw new ImportResolutionError(
          `import '${id}' is unversioned but the registrations for it are ` +
            `versioned (${near.join(", ")}). Version-agnostic folding is ` +
            `banned (contracts/embedder-api.md §"Version canonicalization").`,
        );
      }
    }
    return undefined;
  }
}

/**
 * Semver precedence, prerelease-aware (semver.org §11).
 * @internal — version-resolution internals.
 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.prerelease, bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // a release outranks a prerelease
  if (bp.length === 0) return -1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank lower
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
