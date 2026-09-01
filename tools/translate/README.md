# tools/translate — build-time translation

Translate a component **once, at build/deploy time**, so production never
ships the translator (~0.5 MB gzip of wasm). The deploy set becomes:

```
component.wasm          # unchanged
component.plan.json     # the translation envelope: plan + FACT adapters
your host + @polyengine/runtime
```

## Translate

```sh
deno run --allow-read --allow-write tools/translate/main.ts \
  app.component.wasm            # writes app.component.plan.json
```

(`-o out.plan.json` to choose the destination, `--shim path` to point at a
translator build other than the repo's.)

## Deploy host

```ts
import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";

const [envelope, componentBytes] = await Promise.all([
  fetch("/app.component.plan.json").then((r) => r.text()),
  fetch("/app.component.wasm").then((r) => r.arrayBuffer()),
]);
const component = await instantiate(
  artifactsFromEnvelope(envelope, new Uint8Array(componentBytes)),
  imports,
);
```

Acquisition is deliberately yours (HTTP above; `Deno.readFile`/`node:fs`
work the same) — `artifactsFromEnvelope` is pure. The envelope embeds the
component's sha-256 and length, which `instantiate` verifies: a mismatched
deploy pair (stale envelope, wrong component) **fails loudly at
instantiation**, pinned by `translate_test.ts`.

## When to prefer runtime translation instead

Components that arrive dynamically (plugin systems) can't pre-translate:
use `instantiate({ componentBytes, translator }, …)` (contracts/embedder-api.md
§"Module wiring and instantiation")
with the translator asset, and let the runtime's artifact cache
(`@polyengine/runtime/cache`) amortize repeat visits. The full delivery
decision tree is in the design note on
[#16](https://github.com/polymorph-components/polyengine/issues/16).
