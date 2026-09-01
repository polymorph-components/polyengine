// TEST-ONLY bundle entry — never shipped as the `polyengine-embedder.mjs`
// release asset (see ./entry.ts for that surface, and build.ts's
// `buildBundle(out, entry)` for the override this file relies on).
//
// dual_copy_test.ts needs to reach copy B's OWN `@polyengine/protocol`
// instance — the class-per-copy premise the test pins — but
// contracts/embedder-api.md §"The host-ABI surface and its version" makes
// the *shipped* entry stop re-exporting protocol vocabulary, on purpose: a
// real host module never gets it from the runtime. This second entry point
// exists solely so the in-repo cross-copy test can still observe copy B's
// protocol symbols after the bundle's own dependency graph resolves them —
// it changes nothing about what a consumer's bundle exports.
export * from "./entry.ts";
export {
  ComponentException,
  isStream,
  isSuspending,
  runtimeCopies,
  suspending,
} from "@polyengine/protocol";
