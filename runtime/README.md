# @polyengine/runtime

TypeScript runtime for WebAssembly components. It loads the translator's plan,
instantiates core modules and FACT adapters, and implements the canonical ABI,
resource lifetimes, task scheduling, cancellation, streams, futures, and
error-contexts. Callback-ABI async execution and JSPI-backed suspension are
implemented.

## Embed a component

```ts
import { instantiate } from "@polyengine/runtime/embedder";
import { defaultTranslator } from "@polyengine/translator";

const translator = await defaultTranslator();
const componentBytes = await Deno.readFile("hello.component.wasm");
const component = await instantiate({ componentBytes, translator }, {});
console.log(await component.exports.greet("component model"));
```

This uses the guest from [hello-world](../examples/hello-world/). The
application must resolve the package specifiers through its import map or
package manager. For imports, resources, and stream/future values, start with
[kitchen-sink](../examples/kitchen-sink/). Known components can be
[translated at build time](../tools/translate/) so deployment needs no
translator.

The [embedder contract](../contracts/embedder-api.md) defines the host-facing
names, value shapes, errors, ownership, and calling conventions. Host-provider
packages use `@polyengine/protocol` for shared types and brands; runtime
selection belongs to the application. Internal `cabi` and `exec` modules are not
package entry points.

## Package entry points

| Import                         | Purpose                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@polyengine/runtime/embedder` | Instantiate components and construct the host-facing facade; inspect required imports; create stream pairs; obtain explicit synchronous export views |
| `@polyengine/runtime/shim`     | Load a translator shim and translate component bytes                                                                                                 |
| `@polyengine/runtime/plan`     | Read and validate plans and translation envelopes                                                                                                    |
| `@polyengine/runtime/cache`    | Opt-in translation artifact caching with directory and web backends                                                                                  |
| `@polyengine/runtime/digest`   | World-digest support for generated binding checks                                                                                                    |

The digest entry point is unstable support for generated code, not a
hand-written host API; regenerate bindings when updating the runtime.

The loader accepts only `formatVersion: 5`. Translate with a matching toolchain
rather than reusing an older plan. See the
[plan contract](../contracts/plan-format.md) for the wire format and executor
obligations, and [architecture](../docs/architecture.md) for engine support,
JSPI selection, and semantic scope.

## Source map

| Directory                                | Responsibility                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `src/embedder/`                          | Host conventions, import resolution, resource classes, stream/future handles |
| `src/cabi/`                              | Value layout, flat and memory lift/lower, strings, handle tables             |
| `src/plan/`                              | Wire types, structural validation, descriptor loading                        |
| `src/exec/`                              | Instantiation, canonical call boundaries, host stream endpoints              |
| `src/task/`                              | Tasks, threads, waitables, admission, cancellation, copy protocol            |
| `src/jspi/`                              | Engine suspension and continuation bridging                                  |
| `src/intrinsics/`                        | Canonical builtins and FACT adapter imports                                  |
| `src/shim/`, `src/cache/`, `src/digest/` | Translation client, artifact caching, binding identity                       |

## Development

From the repository root:

```sh
just test-runtime     # builds shim, guest fixtures, and WAST corpus; checks and tests
just test-conventions # focused host-ABI golden transcripts
just sched-seeds      # reruns affected suites with shuffled scheduling
```

From `runtime/`, `deno task check` type-checks source and tests, and
`deno task test` runs against existing artifacts. Missing artifacts can cause
integration tests to skip; use the root recipe for the complete setup.
`deno task gen-fixtures` regenerates the checked-in pure-value fixtures from the
pinned `definitions.py` using Python. Regenerate only when intentionally
updating those expectations.

Tests include reference value ports, scheduler and JSPI regressions, generated
guest integration, and [host-ABI conventions](tests/conventions/). The remaining
reference-port placeholders are in [deferred_test.ts](tests/deferred_test.ts);
they are not an inventory of unimplemented async behavior. Read the
[harness documentation](../harness/) for xfails, skips, and the limits of a
green conformance run.
