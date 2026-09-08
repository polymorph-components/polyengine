// The consumer-facing embedder bundle: one platform-neutral ES module
// carrying the embedder API surface plus component-test runner glue, for consumers
// that cannot import polyengine's TS sources directly — browser pages/workers
// and plain Node (the callback ABI needs no JSPI flag, so stock `node` can
// import this). Built by ./build.ts with `deno bundle --platform browser`
// (the same emission the browser lanes use, tools/browser/bundle.ts) and
// shipped as the `polyengine-embedder.mjs` release asset.
//
// Surface discipline: everything here is already public — the embedder API
// (contracts/embedder-api.md), the shim's `Translator`, `@polyengine/ct-runner`
// (runSuite + Context + import analysis + the tags inventory), and
// `@polyengine/wasi`. The bundle adds no API of its own and generates no runtime JS
// (nothing needs CSP beyond `wasm-unsafe-eval`).

export * from "@polyengine/runtime/embedder";
export { Translator } from "@polyengine/runtime/shim";
export * from "@polyengine/ct-runner";
export { wasi } from "@polyengine/wasi";
export type { WasiImports, WasiOptions } from "@polyengine/wasi";
