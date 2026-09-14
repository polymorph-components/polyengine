import { suspending } from "@polyengine/protocol";
import {
  type HostImports,
  hostResourceType,
} from "../../runtime/src/exec/mod.ts";

export interface SpectestProbe {
  readonly imports: HostImports;
  readonly counters: { readonly drops: number; readonly lastDrop: number };
}

/** Port of locked wasmtime crates/wast/src/spectest.rs:90-224.
 * Raw HostImports expose reps but not Wasmtime's `Resource::owned()` bit, so
 * those upstream ownership assertions are not duplicated here. */
export function wasmtimeSpectest(sourceFile = ""): SpectestProbe {
  const state = { drops: 0, lastDrop: 0 };
  const resource1 = hostResourceType({
    name: "host.resource1",
    dtor: (rep) => {
      state.drops++;
      state.lastDrop = rep;
    },
  });
  return {
    counters: state,
    imports: {
      "host-echo-u32": async (v: unknown) => v,
      "host-return-two": () => 2,
      host: {
        "return-three": () => 3,
        nested: { "return-four": () => 4 },
        resource1,
        resource2: hostResourceType({ name: "host.resource2" }),
        "resource1-again": resource1,
        "[constructor]resource1": (rep: unknown) => rep,
        "[static]resource1.assert": (rep: unknown, expected: unknown) => {
          if (rep !== expected) {
            throw new Error(`resource rep ${rep} != ${expected}`);
          }
        },
        "[static]resource1.last-drop": () => state.lastDrop,
        "[static]resource1.drops": () => state.drops,
        "[method]resource1.simple": (rep: unknown, expected: unknown) => {
          if (rep !== expected) {
            throw new Error(`resource rep ${rep} != ${expected}`);
          }
        },
        "[method]resource1.take-borrow": () => undefined,
        "[method]resource1.take-own": () => undefined,
        "never-return": () => new Promise(() => {}),
        "return-two-slowly": maybeSuspending(
          sourceFile === "async/cancel-host.json",
          async () => {
            await Promise.resolve();
            return 2;
          },
        ),
        "echo-slowly": maybeSuspending(
          sourceFile === "async/cancel-host.json",
          async (v: unknown) => {
            await Promise.resolve();
            return v;
          },
        ),
        "[method]resource1.never-return": maybeSuspending(
          sourceFile === "async/cancel-host.json",
          () => new Promise(() => {}),
        ),
        "return-hi": () => "hi",
      },
    },
  };
}

function maybeSuspending<F extends CallableFunction>(
  enabled: boolean,
  fn: F,
): F {
  return enabled ? suspending(fn) : fn;
}
