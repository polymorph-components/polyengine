# tools/translate — build-time translation

Translate a known component at build time so its deployment does not need the
translator. The deploy set is:

```
component.wasm          # unchanged
component.plan.json     # the translation envelope: plan + FACT adapters
your host + @polyengine/runtime
```

## Translate

From the repository root:

```sh
just shim
deno run --allow-read --allow-write tools/translate/main.ts \
  app.component.wasm            # writes app.component.plan.json
```

Use `-o out.plan.json` to choose the destination, or `--shim path` for another
translator build. The default shim is
`target/wasm32-unknown-unknown/release/translator_shim.wasm`. Translation errors
are checked before writing the output.

The `.plan.json` file is an **envelope**, not a bare plan: it includes the plan
and base64-encoded FACT adapters. Plans currently use `formatVersion: 5`; deploy
with a matching runtime, which rejects other format versions. See the
[plan contract](../../contracts/plan-format.md).

## Deploy host

```ts
import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";

const imports = {}; // Supply the component's host imports here.
const [envelope, componentBytes] = await Promise.all([
  fetch("/app.component.plan.json").then((r) => r.text()),
  fetch("/app.component.wasm").then((r) => r.arrayBuffer()),
]);
const component = await instantiate(
  artifactsFromEnvelope(envelope, new Uint8Array(componentBytes)),
  imports,
);
```

Configure package resolution in the deploying application. Acquisition belongs
to the host (HTTP above, or filesystem/bundler assets); `artifactsFromEnvelope`
does no I/O. Check HTTP status before decoding in a production fetch path.
The plan records the component's SHA-256 and length. `instantiate` checks length
and, by default, the hash, rejecting a mismatched deploy pair; this is covered
by [`translate_test.ts`](translate_test.ts).

Treat the envelope and adapters as trusted build artifacts. The component hash
binds the referenced component bytes; it does not authenticate the plan or
adapter code. See [security](../../docs/security.md).

## When to prefer runtime translation instead

For components unknown at build time, pass `{ componentBytes, translator }` to
`instantiate`. Reuse a translator from `@polyengine/translator` across calls.
Artifact caching is opt-in through `translateCached` in
`@polyengine/runtime/cache`; `instantiate` does not automatically persist
translation results. Persistent caching requires a translator with a `buildHash`
(created from shim bytes); a translator wrapped from wasm exports alone has no
binary identity for the cache key. See the
[embedder contract](../../contracts/embedder-api.md) for instantiation and
[architecture](../../docs/architecture.md) for caching.

`just test-translate` exercises the CLI, envelope deployment, and translator
package from the repository root.
