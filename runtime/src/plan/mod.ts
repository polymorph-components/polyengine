/**
 * The translation plan: the wire descriptor IR emitted by the translator
 * (`Wire*` types, contracts/plan-format.md) plus the loader that validates
 * it and converts it into the runtime's in-memory type model.
 *
 * **This is not embedder API.** The entry point exists as a support surface
 * for bindgen-generated bindings and for the runtime's own internals, which
 * import from it directly. No host program should hand-write an import of
 * this module.
 *
 * **Its contents are completely unstable: there is no compatibility promise
 * of any kind, including within a minor line.** This is an explicit
 * carve-out from the caret-honest versioning policy in README.md
 * §"Consuming", which otherwise promises backward compatibility within a
 * minor line — every symbol here may be renamed, reshaped, or removed in
 * any release, including a patch. Regenerate your bindings when you bump
 * the runtime.
 *
 * The supported host-facing surface is `@polyengine/runtime/embedder`
 * (contracts/embedder-api.md).
 *
 * @module
 */

// Plan format + loader (contracts/plan-format.md).

export * from "./format.ts";
export * from "./loader.ts";
