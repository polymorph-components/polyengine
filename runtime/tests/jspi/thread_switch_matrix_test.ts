import { instantiate } from "../../src/embedder/mod.ts";
import type { EmbedderInstance } from "../../src/embedder/instantiate.ts";
import { Translator } from "../../src/shim/mod.ts";
import { isTrap, suspending } from "@polyengine/protocol";
import { assert, assertEquals, assertRejects } from "./asserts.ts";

const root = new URL("../../../", import.meta.url);
const shim = await Deno.readFile(
  new URL("target/wasm32-unknown-unknown/release/translator_shim.wasm", root),
);
const fixture = await Deno.readFile(
  new URL("../fixtures/thread-switch-matrix.wasm", import.meta.url),
);
const translator = await Translator.create(shim);

type Component = EmbedderInstance & { order: number[] };
type GateOptions = {
  childGate?: () => Promise<void>;
  holderGate?: () => Promise<void>;
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fresh(
  onMark?: (value: number, component: Component) => void,
  gates: GateOptions = {},
) {
  const order: number[] = [];
  const holder: { current: Component | null } = { current: null };
  const instance = await instantiate(
    { componentBytes: fixture, ...translator.translate(fixture) },
    {
      mark(value: number) {
        order.push(value);
        assert(holder.current !== null, "component must be bound before mark");
        onMark?.(value, holder.current);
      },
      childGate: suspending(gates.childGate ?? (() => Promise.resolve())),
      holderGate: suspending(gates.holderGate ?? (() => Promise.resolve())),
    },
    { jspi: true },
  );
  const component = Object.assign(instance, { order });
  holder.current = component;
  return component;
}

async function run(
  name: string,
  expectedValue: number,
  expectedOrder: number[],
): Promise<void> {
  const component = await fresh();
  const value = await bounded(
    component.exports[name]() as Promise<number>,
    name,
  );
  assertEquals(value, expectedValue);
  assertEquals(JSON.stringify(component.order), JSON.stringify(expectedOrder));
}

Deno.test("real guest: suspend-then-resume target immediately resume-laters caller", async () => {
  await run("resumeLater", 101, [1, 10, 11]);
});

Deno.test("real guest: suspend-then-resume target immediately switches back", async () => {
  const component = await fresh();
  assertEquals(
    await bounded(
      component.exports.switchBack() as Promise<number>,
      "switch-back",
    ),
    102,
  );
  assertEquals(JSON.stringify(component.order), JSON.stringify([2, 20, 21]));
  assert(
    component.handle.componentInstances.some((inst) =>
      inst !== undefined &&
      [...inst.threads].some((thread) => thread.explicitlySuspended())
    ),
    "switch-back must leave the target child suspended",
  );
});

Deno.test("real guest: yield-then-resume promotes the ready caller", async () => {
  await run("yieldBack", 103, [3, 30, 31, 32]);
});

Deno.test("real guest: promote ignores suspended target and runs ready target first", async () => {
  await run("promote", 104, [4, 41, 40, 42]);
});

function requestCurrentTaskCancellation(component: Component): void {
  const tasks = new Set(
    component.handle.componentInstances
      .filter((inst) => inst !== undefined)
      .flatMap((inst) => [...inst.threads].map((thread) => thread.task)),
  );
  assertEquals(tasks.size, 1, "mark must run with exactly one live task");
  [...tasks][0].requestCancellation(null);
}

Deno.test("real guest: valid pending cancellation cancels without transfer", async () => {
  const component = await fresh((value, current) => {
    if (value === 6) requestCurrentTaskCancellation(current);
  });
  assertEquals(
    await bounded(
      component.exports.cancelValid() as Promise<number>,
      "cancel-valid",
    ),
    105,
  );
  assertEquals(JSON.stringify(component.order), JSON.stringify([6, 61]));
});

for (const name of ["cancelInvalidIndex", "cancelSelf", "cancelWrongState"]) {
  Deno.test(`real guest: ${name} validates before pending cancellation`, async () => {
    let requestedTask: { state: string } | null = null;
    const component = await fresh((value, current) => {
      if (value !== 6) return;
      const tasks = current.handle.componentInstances
        .filter((inst) => inst !== undefined)
        .flatMap((inst) => [...inst.threads].map((thread) => thread.task));
      assert(tasks.length > 0);
      requestedTask = tasks[0];
      tasks[0].requestCancellation(null);
    });
    const failure = await assertRejects(() =>
      bounded(component.exports[name]() as Promise<unknown>, name)
    );
    assert(isTrap(failure), `expected validation trap, got ${failure}`);
    assert(requestedTask !== null);
    assertEquals((requestedTask as { state: string }).state, "pending-cancel");
  });
}

Deno.test("real guest: explicit child trap remains the original cause", async () => {
  const component = await fresh();
  const failure = await assertRejects(() =>
    bounded(component.exports.childTrap() as Promise<unknown>, "child-trap")
  );
  assert(
    isTrap(failure) && String(failure).includes("unreachable"),
    `expected original unreachable trap, got ${failure}`,
  );
});

Deno.test("real guest: normal last explicit child reports no async result", async () => {
  const component = await fresh();
  const failure = await assertRejects(() =>
    bounded(component.exports.childNormal() as Promise<unknown>, "child-normal")
  );
  assert(
    isTrap(failure) && String(failure).includes("without resolving"),
    `expected last-thread no-result trap, got ${failure}`,
  );
});

for (const timing of ["pending", "immediate"] as const) {
  Deno.test(`real guest: explicit child receives ${timing} cancellation while sibling owns exclusive slot`, async () => {
    const childGate = Promise.withResolvers<void>();
    const childEntered = Promise.withResolvers<void>();
    const holderGate = Promise.withResolvers<void>();
    const holderEntered = Promise.withResolvers<void>();
    const childAtPark = Promise.withResolvers<void>();
    const component = await fresh(
      (value) => {
        if (value === 70) childAtPark.resolve();
      },
      {
        childGate: () => {
          childEntered.resolve();
          return childGate.promise;
        },
        holderGate: () => {
          holderEntered.resolve();
          return holderGate.promise;
        },
      },
    );

    const originResult = component.exports.childCancellable() as Promise<
      number
    >;
    await bounded(childEntered.promise, "child initial noncancellable park");
    const instance = component.handle.componentInstances.find((inst) =>
      inst !== undefined && [...inst.threads].length > 0
    )!;
    const origin = [...instance.threads][0].task;
    assertEquals(
      origin.implicitThread?.index,
      null,
      "origin implicit thread exited",
    );

    const holderResult = component.exports.lockHolder() as Promise<number>;
    try {
      await bounded(holderEntered.promise, "exclusive holder park");
      const exclusive = instance.exclusiveThread;
      assert(exclusive !== null, "lock-holder must own the exclusive slot");
      assert(
        exclusive.task !== origin,
        "exclusive holder must be a sibling task",
      );

      if (timing === "pending") origin.requestCancellation(null);
      childGate.resolve();
      await bounded(childAtPark.promise, "child cancellable park");
      if (timing === "immediate") {
        await bounded(
          (async () => {
            while (
              !(instance.store as unknown as {
                waiting: { task?: unknown; cancellable: boolean }[];
              }).waiting.some((waiter) =>
                waiter.task === origin && waiter.cancellable
              )
            ) {
              await Promise.resolve();
            }
          })(),
          "registered child cancellable park",
        );
        origin.requestCancellation(null);
      }

      assertEquals(
        await bounded(originResult, `child-cancellable-${timing}`),
        110,
      );
      assertEquals(
        JSON.stringify(component.order),
        JSON.stringify([90, 70, 71]),
      );
      assertEquals(
        instance.exclusiveThread,
        exclusive,
        "holder keeps the slot",
      );
    } finally {
      childGate.resolve();
      holderGate.resolve();
    }
    assertEquals(await bounded(holderResult, "holder cleanup"), 109);
  });
}

Deno.test("real guest: post-result ready child continues and suspended child is retained", async () => {
  const component = await fresh();
  assertEquals(
    await bounded(
      component.exports.postResult() as Promise<number>,
      "post-result",
    ),
    108,
  );
  await bounded(
    (async () => {
      while (!component.order.includes(80)) {
        await new Promise((r) => setTimeout(r, 0));
      }
    })(),
    "post-result child continuation",
  );
  assertEquals(JSON.stringify(component.order), JSON.stringify([80]));
  assert(
    component.handle.componentInstances.some((inst) =>
      inst !== undefined &&
      [...inst.threads].some((thread) => thread.explicitlySuspended())
    ),
    "post-result suspended child must remain registered",
  );
});
