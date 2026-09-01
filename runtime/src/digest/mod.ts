/**
 * The world-digest handshake (CEWD, docs/architecture.md §9): computing a
 * canonical digest over a component's world types, and verifying generated
 * bindings against the component they are used with.
 *
 * **This is not embedder API.** The entry point exists as a support surface
 * for bindgen-generated bindings — whose typed `instantiate` wrapper
 * verifies the digest before instantiating (contracts/embedder-api.md
 * §"Module wiring and instantiation") — and for the runtime's own internals. No host program
 * should hand-write an import of this module.
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

// Runtime digest handshake — package entry point (docs/architecture.md §9).
export * from "./digest.ts";
export * from "./verify.ts";
