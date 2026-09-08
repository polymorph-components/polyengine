// Cache API backend for the artifact cache (docs/architecture.md §10), for browsers
// (and other environments implementing the standard `CacheStorage`/`Cache`
// interfaces). Feature-detects `globalThis.caches`; throws a named error
// where unavailable (e.g. plain Deno without `--unstable-*` polyfills, or a
// non-secure-context page) rather than silently no-op'ing.
//
// Layout: one synthetic same-origin-ish URL per cache key, stored as a
// single JSON `Response` body containing `{meta, plan, adapters}` (adapters
// base64-encoded — `Cache` stores `Response` bodies, not arbitrary trees,
// so we can't mirror dirCache's file-per-adapter layout; one blob per entry
// is the natural shape here).

import type {
  ArtifactCache,
  CachedArtifacts,
  CacheKey,
  CacheMeta,
} from "./core.ts";
import { CACHE_LAYOUT_VERSION, keyHex } from "./core.ts";
import type { WirePlan } from "../plan/format.ts";
import { loadPlan } from "../plan/loader.ts";

/** Thrown when the Cache API isn't available in this environment. */
export class WebCacheUnavailableError extends Error {
  constructor() {
    super(
      "artifact cache: the Cache API (globalThis.caches) is not available " +
        "in this environment",
    );
    this.name = "WebCacheUnavailableError";
  }
}

interface StoredEntry {
  meta: CacheMeta;
  plan: WirePlan;
  /** file -> base64 */
  adapters: Record<string, string>;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Synthetic request URL an entry is stored under. Same-origin-relative so
 * it works under any page origin; the path has no filesystem meaning. */
function entryUrl(hex: string): string {
  return `https://artifact-cache.invalid/${hex}`;
}

class WebCache implements ArtifactCache {
  constructor(private readonly cacheName: string) {}

  private async open(): Promise<Cache> {
    if (typeof globalThis.caches === "undefined") {
      throw new WebCacheUnavailableError();
    }
    return await globalThis.caches.open(this.cacheName);
  }

  /** Internal self-heal eviction (issue #196): the caller is `get`'s own
   * recovery path for a poisoned/stale entry, not an explicit caller of
   * `evict()` — so a failure here must not escape and fail what would
   * otherwise be a clean miss. The public `evict()` below keeps throwing;
   * only this internal path swallows. */
  async #tryEvict(key: CacheKey): Promise<void> {
    try {
      await this.evict(key);
    } catch {
      // Swallowed: see docs above.
    }
  }

  async get(key: CacheKey): Promise<CachedArtifacts | null> {
    // `open()` failing (no `globalThis.caches` in this environment) is a
    // capability/configuration error, not a per-entry I/O failure — it
    // propagates uncaught (existing behavior, `WebCacheUnavailableError`)
    // so a caller who tries to use this backend somewhere it can't work
    // finds out immediately rather than silently always-missing. Once open
    // succeeds, every failure below (issue #196: poisoned entry, self-heal
    // eviction, ...) is swallowed to a `null` miss.
    const cache = await this.open();
    try {
      const hex = await keyHex(key);
      const resp = await cache.match(entryUrl(hex));
      if (resp === undefined) return null;

      const entry = await resp.json() as StoredEntry;
      const { meta, plan, adapters: adaptersB64 } = entry;

      if (meta.layoutVersion !== CACHE_LAYOUT_VERSION) {
        await this.#tryEvict(key);
        return null;
      }
      if (
        meta.componentSha256 !== key.componentSha256 ||
        meta.translatorBuildHash !== key.translatorBuildHash ||
        JSON.stringify([...meta.features].sort()) !==
          JSON.stringify([...key.features].sort()) ||
        plan.component.sha256 !== key.componentSha256
      ) {
        await this.#tryEvict(key);
        return null;
      }
      loadPlan(plan); // structural validation; throws on a corrupted plan

      const adapters = new Map<string, Uint8Array>();
      for (const [file, b64] of Object.entries(adaptersB64)) {
        adapters.set(file, fromBase64(b64));
      }
      return { plan, adapters };
    } catch {
      // Poisoned/corrupted entry, or any other I/O failure (issue #196):
      // miss + best-effort evict, never trust and never throw out of
      // `get`.
      await this.#tryEvict(key);
      return null;
    }
  }

  async put(key: CacheKey, artifacts: CachedArtifacts): Promise<void> {
    const cache = await this.open();
    const hex = await keyHex(key);
    const meta: CacheMeta = {
      layoutVersion: CACHE_LAYOUT_VERSION,
      componentSha256: key.componentSha256,
      translatorBuildHash: key.translatorBuildHash,
      features: key.features,
    };
    const adaptersB64: Record<string, string> = {};
    for (const [file, bytes] of artifacts.adapters) {
      adaptersB64[file] = toBase64(bytes);
    }
    const entry: StoredEntry = {
      meta,
      plan: artifacts.plan,
      adapters: adaptersB64,
    };
    const body = JSON.stringify(entry);
    await cache.put(
      entryUrl(hex),
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
  }

  async evict(key: CacheKey): Promise<void> {
    const cache = await this.open();
    const hex = await keyHex(key);
    await cache.delete(entryUrl(hex));
  }
}

/** A `Cache`-API-backed `ArtifactCache` under the given cache name. Throws
 * `WebCacheUnavailableError` (at call time, not construction time, so
 * feature-detection failures surface where they're actually hit) when
 * `globalThis.caches` doesn't exist. */
export function webCache(name: string): ArtifactCache {
  return new WebCache(name);
}
