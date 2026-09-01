// Shared failure type for trampolines/intrinsics gated on a not-yet-built
// runtime capability. Split out of ./mod.ts so sibling intrinsic modules can
// raise it without importing the (much larger) trampoline dispatcher.

/** Instantiate-time failure for functionality gated on a missing capability. */
export class UnsupportedFeatureError extends Error {
  constructor(
    public capability: "resources" | "task-core" | "streams" | "jspi",
    what: string,
  ) {
    super(
      `${what} — needs the "${capability}" capability, not yet implemented ` +
        `in the current executor (contracts/intrinsics.md §B)`,
    );
    this.name = "UnsupportedFeatureError";
  }
}
