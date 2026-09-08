// Deno filesystem backend for the artifact cache (docs/architecture.md §10).
//
// Layout, under `<path>/<keyhex>/`:
//   meta.json         CacheMeta (layoutVersion, componentSha256,
//                      translatorBuildHash, features)
//   plan.json          the wire WirePlan, JSON-serialized
//   adapters/<file>    one file per adapter, using modules[].file verbatim
//
// Original component bytes remain caller-supplied (see core.ts).

import type {
  ArtifactCache,
  CachedArtifacts,
  CacheKey,
  CacheMeta,
} from "./core.ts";
import { CACHE_LAYOUT_VERSION, keyHex } from "./core.ts";
import type { WirePlan } from "../plan/format.ts";
import { loadPlan, PlanError } from "../plan/loader.ts";

/** Reject any adapter file name that isn't a plain, non-traversing
 * relative path — defense in depth even though the shim is trusted (a
 * poisoned/tampered cache directory must not escape it). */
function safeRelName(name: string): string {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new PlanError(`artifact cache: unsafe adapter file name '${name}'`);
  }
  return name;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function rmIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

class DirCache implements ArtifactCache {
  constructor(private readonly root: string) {}

  private async entryDir(key: CacheKey): Promise<string> {
    return `${this.root}/${await keyHex(key)}`;
  }

  /** Best-effort stale-entry eviction; unlike public evict, failure is a miss. */
  async #tryEvict(key: CacheKey): Promise<void> {
    try {
      await this.evict(key);
    } catch {
      // Swallowed: see docs above.
    }
  }

  async get(key: CacheKey): Promise<CachedArtifacts | null> {
    try {
      const dir = await this.entryDir(key);
      if (!(await exists(dir))) return null;

      const metaRaw = await Deno.readTextFile(`${dir}/meta.json`);
      const meta = JSON.parse(metaRaw) as CacheMeta;

      if (meta.layoutVersion !== CACHE_LAYOUT_VERSION) {
        await this.#tryEvict(key);
        return null;
      }
      // Integrity: the entry must agree with the *requested* key on every
      // field, not just live at the expected directory name (belt-and-
      // suspenders against a hand-edited or corrupted cache).
      if (
        meta.componentSha256 !== key.componentSha256 ||
        meta.translatorBuildHash !== key.translatorBuildHash ||
        JSON.stringify([...meta.features].sort()) !==
          JSON.stringify([...key.features].sort())
      ) {
        await this.#tryEvict(key);
        return null;
      }

      const planRaw = await Deno.readTextFile(`${dir}/plan.json`);
      const plan = JSON.parse(planRaw) as WirePlan;
      if (plan.component.sha256 !== key.componentSha256) {
        await this.#tryEvict(key);
        return null;
      }
      loadPlan(plan); // structural validation; throws on a corrupted plan

      const adapters = new Map<string, Uint8Array>();
      for (const m of plan.modules) {
        if (m.kind !== "adapter") continue;
        const name = safeRelName(m.file);
        adapters.set(m.file, await Deno.readFile(`${dir}/adapters/${name}`));
      }

      return { plan, adapters };
    } catch {
      // Parse, validation and I/O failures become misses, even if eviction fails.
      await this.#tryEvict(key);
      return null;
    }
  }

  async put(key: CacheKey, artifacts: CachedArtifacts): Promise<void> {
    const dir = await this.entryDir(key);
    // Write to a temp sibling then rename, so a crash mid-write never
    // leaves a partially-written entry that `get` would (try to) read.
    const tmp = `${dir}.tmp-${crypto.randomUUID()}`;
    await rmIfExists(tmp);
    try {
      await Deno.mkdir(`${tmp}/adapters`, { recursive: true });

      const meta: CacheMeta = {
        layoutVersion: CACHE_LAYOUT_VERSION,
        componentSha256: key.componentSha256,
        translatorBuildHash: key.translatorBuildHash,
        features: key.features,
      };
      await Deno.writeTextFile(`${tmp}/meta.json`, JSON.stringify(meta));
      await Deno.writeTextFile(
        `${tmp}/plan.json`,
        JSON.stringify(artifacts.plan),
      );
      for (const [file, bytes] of artifacts.adapters) {
        const name = safeRelName(file);
        await Deno.writeFile(`${tmp}/adapters/${name}`, bytes);
      }

      await rmIfExists(dir);
      await Deno.rename(tmp, dir);
    } catch (e) {
      // Remove partial output best-effort, preserving the original put error.
      try {
        await rmIfExists(tmp);
      } catch {
        // Swallowed: best-effort cleanup only.
      }
      throw e;
    }
  }

  async evict(key: CacheKey): Promise<void> {
    await rmIfExists(await this.entryDir(key));
  }
}

/** A filesystem-backed `ArtifactCache` rooted at `path` (created on first
 * `put` if missing). Deno only: every method calls `Deno.*` directly. On other
 * platforms use `webCache()` (./web.ts), or supply your own `ArtifactCache` —
 * the interface is three methods (./core.ts). */
export function dirCache(path: string): ArtifactCache {
  if (typeof Deno === "undefined") {
    throw new Error(
      "dirCache() is the Deno filesystem backend and this is not Deno — " +
        "use webCache() (Cache API), or implement ArtifactCache over your " +
        "platform's storage (see @polyengine/runtime/cache core.ts)",
    );
  }
  return new DirCache(path);
}
