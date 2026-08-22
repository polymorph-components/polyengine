// A minimal semver, deliberately dependency-free: the guard runs as the very
// first step of `gha::core` and inside release.yml before `deno publish`, so
// every import it takes is a way for a registry outage to fail a release.
// Only what the guard actually decides is implemented — parse, compare, and
// the minor-level questions the versioning policy asks (AGENTS.md
// §Versioning).

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  pre: string[];
};

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `X.Y.Z[-pre][+build]`. Throws on anything else — a version this
 * guard cannot read is a violation, never a pass. */
export function parseSemver(v: string): Semver {
  const m = RE.exec(v.trim());
  if (!m) throw new Error(`not a semver version: ${JSON.stringify(v)}`);
  const pre = m[4] === undefined ? [] : m[4].split(".");
  if (pre.some((id) => id.length === 0)) {
    throw new Error(`empty prerelease identifier in ${JSON.stringify(v)}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

const NUMERIC = /^\d+$/;

function comparePre(a: string[], b: string[]): number {
  // semver 11: a version WITH a prerelease has lower precedence than the
  // same version without one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    // A longer set of identifiers wins when all preceding ones are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = NUMERIC.test(x), yn = NUMERIC.test(y);
    if (xn && yn) {
      // Numeric identifiers compare numerically (and never have leading
      // zeros — release.yml's `g` prefix exists for exactly this reason).
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric < alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1, semver precedence (build metadata ignored, as the spec says). */
export function compareSemver(a: string | Semver, b: string | Semver): number {
  const x = typeof a === "string" ? parseSemver(a) : a;
  const y = typeof b === "string" ? parseSemver(b) : b;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

/** True when `a` is a strictly later minor line than `b` — the question the
 * breaking-label policy asks ("bumped this cycle"). A major bump counts:
 * 1.0.0 is a later line than 0.9.0. */
export function isMinorBumped(a: string | Semver, b: string | Semver): boolean {
  const x = typeof a === "string" ? parseSemver(a) : a;
  const y = typeof b === "string" ? parseSemver(b) : b;
  if (x.major !== y.major) return x.major > y.major;
  return x.minor > y.minor;
}
