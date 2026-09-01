// Type-surface consumer: compiled with `tsc --noEmit` against the INSTALLED
// packages (see ../smoke.mjs), so it checks the `.d.ts` the tarballs actually
// ship — including that each `exports` subpath carries types, which is the
// failure a JS-only smoke cannot see.
//
// Nothing here runs. It exists to be type-checked.

import {
  type ComponentArtifacts,
  createStream,
  instantiate,
} from "@polyengine/runtime/embedder";
import { Translator } from "@polyengine/runtime/shim";
import {
  COMPONENT_EXCEPTION,
  ComponentException,
  copyCensus,
  isComponentException,
  PROTOCOL_GENERATION,
  suspending,
} from "@polyengine/protocol";
import { defaultTranslator } from "@polyengine/translator";
import { wasi } from "@polyengine/wasi";
import { runSuite } from "@polyengine/ct-runner";

export async function typeSurface(componentBytes: Uint8Array) {
  const translator: Translator = await defaultTranslator();

  const component = await instantiate({ componentBytes, translator }, {
    ...wasi(),
    "example:pkg/iface": {
      // A suspending sync import — contracts/embedder-api.md §"Functions
      // and async"'s declared-capability form.
      lookup: suspending(async (key: string) => key.length),
    },
  });

  // A byte stream is `Stream<number>`: `Chunk<T>` widens a numeric element
  // type to `Uint8Array | number[]`, so the u8 bulk path is expressible.
  // `createStream` (contracts/embedder-api.md §"The host-ABI surface and
  // its version") is the application-surface spelling of
  // the former `Stream.create()` static — the concrete class is no longer
  // exported.
  const { stream, writer } = createStream<number>();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();

  try {
    await component.exports.anything?.();
  } catch (e) {
    if (isComponentException(e)) {
      const payload: unknown = e.payload;
      void payload;
    }
    if (e instanceof ComponentException) void e.message;
  }

  const brand: symbol = COMPONENT_EXCEPTION;
  const generation: number = PROTOCOL_GENERATION;
  const census: string = copyCensus();

  return { stream, brand, generation, census, runSuite };
}

export type Artifacts = ComponentArtifacts;
