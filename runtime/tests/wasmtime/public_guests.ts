// This deliberately lacks a `_test.ts` suffix: the focused gate names it
// explicitly, while ordinary runtime test discovery remains build-independent.
// Public-embedder adaptations of Wasmtime's async round-trip and short-read
// scenarios from crates/test-programs/src/bin and
// crates/misc/component-async-tests/wit in the Cargo.lock-selected checkout.
// The host assertions intentionally cover portable API behavior, not Wasmtime's
// native Accessor styles or internal counters.

import { assertEq } from "../support/asserts.ts";
import { instantiate } from "../../src/embedder/mod.ts";
import { Translator } from "../../src/shim/mod.ts";
import type { Stream } from "@polyengine/protocol";
import { wasi } from "../../../wasi/src/mod.ts";

const root = new URL("../../../", import.meta.url);
const build = "tools/wasmtime-guests/build/";

async function required(rel: string, command: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch (cause) {
    throw new Error(`missing required artifact ${rel}; run: ${command}`, {
      cause,
    });
  }
}

async function requiredText(rel: string, command: string): Promise<string> {
  try {
    return await Deno.readTextFile(new URL(rel, root));
  } catch (cause) {
    throw new Error(`missing required artifact ${rel}; run: ${command}`, {
      cause,
    });
  }
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  milliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const buildGuests = "deno run -A tools/wasmtime-guests/build.ts";
const shim = await required(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  "cargo build -p translator-shim --release --target wasm32-unknown-unknown",
);
const translator = await Translator.create(shim);

const sourcePaths = [
  "crates/test-programs/src/bin/async_round_trip_stackless.rs",
  "crates/test-programs/src/bin/async_short_reads.rs",
  "crates/misc/component-async-tests/wit/test.wit",
  "crates/wasi-preview1-component-adapter",
];
const provenance = JSON.parse(
  await requiredText(`${build}provenance.json`, buildGuests),
) as {
  revision?: string;
  sources?: string[];
  artifacts?: Record<string, string>;
};
const cargoLock = await Deno.readTextFile(new URL("Cargo.lock", root));
const environBlock = cargoLock.split("[[package]]").find((block) =>
  block.includes('name = "wasmtime-environ"')
);
const lockedRevision = environBlock?.match(
  /source = "git\+[^"#]+(?:\?[^"#]+)?#([0-9a-f]{40})"/,
)?.[1];
if (
  provenance.revision === undefined ||
  provenance.revision !== lockedRevision ||
  JSON.stringify(provenance.sources) !== JSON.stringify(sourcePaths)
) {
  throw new Error(
    `stale Wasmtime guest artifacts for revision ${provenance.revision}; run: ${buildGuests}`,
  );
}

async function guest(name: string, imports: Record<string, unknown> = {}) {
  const componentBytes = await required(
    `${build}${name}.component.wasm`,
    buildGuests,
  );
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(componentBytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (provenance.artifacts?.[name] !== digest) {
    throw new Error(
      `stale or modified guest artifact ${name}; run: ${buildGuests}`,
    );
  }
  return await instantiate({ componentBytes, translator }, {
    ...wasi(),
    ...imports,
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

function observed<T>(promise: Promise<T>) {
  const settled = deferred<void>();
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  const value = promise.then(
    (result) => {
      state = "fulfilled";
      settled.resolve();
      return result;
    },
    (error) => {
      state = "rejected";
      settled.resolve();
      throw error;
    },
  );
  return { value, settled: settled.promise, state: () => state };
}

function timedTest(name: string, fn: () => Promise<void>): void {
  Deno.test(name, () => withTimeout(name, fn(), 20_000));
}

async function assertRemainsPending(
  label: string,
  settled: Promise<void>,
): Promise<void> {
  const won = await Promise.race([
    settled.then(() => "settled" as const),
    new Promise<"turn">((resolve) => setTimeout(() => resolve("turn"), 0)),
  ]);
  assertEq(won, "turn", `${label} settled before its release`);
}

timedTest(
  "wasmtime guest: three stackless calls remain independently outstanding",
  async () => {
    // Upstream scenario: crates/misc/component-async-tests/tests/scenario/
    // round_trip.rs:513-525 starts three calls before joining their results.
    const pending = new Map<string, Deferred<string>>();
    const allArrived = deferred<void>();
    const c = await guest("async_round_trip_stackless", {
      "local:local/baz": {
        foo(input: string): Promise<string> {
          const result = deferred<string>();
          pending.set(input, result);
          if (pending.size === 3) allArrived.resolve();
          return result.promise;
        },
      },
    });
    const foo = c.exports["local:local/baz"].foo as (
      value: string,
    ) => Promise<string>;

    const calls = ["alpha", "beta", "gamma"].map((input) =>
      observed(foo(input))
    );
    await withTimeout("three host imports to arrive", allArrived.promise);
    assertEq([...pending.keys()], [
      "alpha - entered guest",
      "beta - entered guest",
      "gamma - entered guest",
    ]);

    const settle = async (call: number, input: string) => {
      const hostInput = `${input} - entered guest`;
      pending.get(hostInput)!.resolve(
        `${hostInput} - entered host - exited host`,
      );
      return await withTimeout(`${input} call to publish`, calls[call].value);
    };
    assertEq(
      await settle(2, "gamma"),
      "gamma - entered guest - entered host - exited host - exited guest",
    );
    assertEq(calls[0].state(), "pending");
    assertEq(calls[1].state(), "pending");
    assertEq(
      await settle(0, "alpha"),
      "alpha - entered guest - entered host - exited host - exited guest",
    );
    assertEq(calls[1].state(), "pending");
    assertEq(
      await settle(1, "beta"),
      "beta - entered guest - entered host - exited host - exited guest",
    );
    assertEq(await Promise.all(calls.map((call) => call.value)), [
      "alpha - entered guest - entered host - exited host - exited guest",
      "beta - entered guest - entered host - exited host - exited guest",
      "gamma - entered guest - entered host - exited host - exited guest",
    ]);
  },
);

for (const delayed of [false, true]) {
  timedTest(
    `wasmtime guest: resource short reads preserve ownership (${
      delayed ? "delayed" : "immediate"
    })`,
    async () => {
      const c = await guest("async_short_reads");
      const api = c.exports["local:local/short-reads"];
      // Upstream scenario: crates/misc/component-async-tests/tests/scenario/
      // streams.rs:492-528 transfers five owns in, consumes one at a time,
      // then calls each returned resource. We add public-wrapper drop checks.
      const labels = ["a", "b", "c", "d", "e"];
      const things = labels.map((label) => new api.Thing(label));
      let returned = false;
      const production = deferred<void>();
      const producerEntered = deferred<void>();
      async function* source() {
        producerEntered.resolve();
        if (delayed) await production.promise;
        try {
          yield things;
        } finally {
          returned = true;
        }
      }

      const outputPromise = api.shortReads(source()) as Promise<
        Stream<
          InstanceType<
            typeof api.Thing
          >
        >
      >;
      const output = await withTimeout("short-reads export", outputPromise);
      const received: InstanceType<typeof api.Thing>[] = [];
      if (delayed) {
        await withTimeout("stream producer to park", producerEntered.promise);
        const firstRead = observed(output.read(1));
        await assertRemainsPending("first read", firstRead.settled);
        production.resolve();
        const first = await withTimeout(
          "first delayed short read",
          firstRead.value,
        );
        assertEq(first.length, 1);
        received.push(first[0]);
      }
      for (let i = delayed ? 1 : 0; i < labels.length; i++) {
        const consumerReady = deferred<void>();
        const consume = observed((async () => {
          await consumerReady.promise;
          return await output.read(1);
        })());
        if (delayed) {
          await assertRemainsPending(`short read ${i + 1}`, consume.settled);
        }
        consumerReady.resolve();
        const chunk = await withTimeout(`short read ${i + 1}`, consume.value);
        assertEq(chunk.length, 1, "consumer forces one-element short reads");
        received.push(chunk[0]);
      }
      assertEq(await withTimeout("short-read EOF", output.read(1)), []);
      assertEq(returned, true, "producer was consumed and finalized");
      assertEq(
        await withTimeout(
          "returned resource reads",
          Promise.all(received.map((thing) => thing.get())),
        ),
        labels,
      );

      // own<thing> moved through host -> guest -> host. Source wrappers were
      // invalidated by transfer; returned wrappers exclusively own each value.
      for (const sourceThing of things) {
        let failed = false;
        try {
          await sourceThing.get();
        } catch {
          failed = true;
        }
        assertEq(failed, true, "source own wrapper was consumed");
      }
      for (const thing of received) {
        thing.drop();
        thing.drop();
        let failed = false;
        try {
          await thing.get();
        } catch {
          failed = true;
        }
        assertEq(failed, true, "returned own is invalid after idempotent drop");
      }
      output.drop();
    },
  );
}
