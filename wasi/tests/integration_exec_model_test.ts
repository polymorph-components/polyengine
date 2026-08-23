// Integration gate 2: `iroh_exec_model_guest.wasm` runs its full probe
// sequence end-to-end via `instantiate(artifacts, { ...wasi(), ...
// webcryptoFixture })` — ZERO hand-written wasi stubs. This is the mission's
// named integration gate; the driving order is ported from
// tools/smoke-c0/leg2_exec_model.ts (the lann/jco#11 kill shot).
//
// Skip-if-absent: the artifact is a real polymorph build product, not
// checked in here.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@polyengine/runtime/shim";
import { instantiate } from "@polyengine/runtime/embedder";
import { Stream } from "@polyengine/protocol";
import { wasi } from "../src/mod.ts";

const ARTIFACT =
  "/home/lmartin/p/polymorph/polymorph-iroh/target/wasm32-wasip2/release/iroh_exec_model_guest.wasm";
const SHIM_WASM = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function readIfPresent(path: string | URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------
// Test-local glue for `polymorph:webcrypto` — NOT wasi, NOT shim-package
// content (mission dispatch: "provide them as a small test-local fixture
// import object, clearly marked as test glue"). Minimal logic ported from
// tools/smoke-c0/leg2_exec_model.ts, adapted from raw reps to the embedder
// conventions' resource-class-per-interface shape (contracts/embedder-api.md
// §"Resources": host-implemented resources are plain classes; the runtime
// owns identity, not the embedder).
// -----------------------------------------------------------------------

class AgreementKeyOptions {
  deriveBits = false;
  deriveKey = false;
  extractableFlag = false;
  canDeriveBits(allowed: boolean): void {
    this.deriveBits = allowed;
  }
  canDeriveKey(allowed: boolean): void {
    this.deriveKey = allowed;
  }
  extractable(allowed: boolean): void {
    this.extractableFlag = allowed;
  }
}

class SecretKey {
  constructor(readonly cryptoKey: CryptoKey) {}
}

class PublicKey {
  constructor(readonly cryptoKey: CryptoKey) {}
  async exportKeyRaw(): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.exportKey("raw", this.cryptoKey));
  }
}

function webcryptoFixture(): Record<string, unknown> {
  return {
    "polymorph:webcrypto/key-agreement@0.1.0": {
      AgreementKeyOptions,
      PublicKey,
      SecretKey,
    },
    "polymorph:webcrypto/x25519@0.1.0": {
      generateKey: async (
        _options: AgreementKeyOptions,
      ): Promise<[SecretKey, PublicKey]> => {
        const pair = await crypto.subtle.generateKey(
          { name: "X25519" },
          true,
          ["deriveBits"],
        ) as CryptoKeyPair;
        return [new SecretKey(pair.privateKey), new PublicKey(pair.publicKey)];
      },
    },
  };
}

// -----------------------------------------------------------------------

Deno.test({
  name: "integration: iroh_exec_model_guest.wasm probe sequence via wasi()",
  ignore: (await readIfPresent(ARTIFACT)) === null ||
    (await readIfPresent(SHIM_WASM)) === null,
  fn: async () => {
    const bytes = (await readIfPresent(ARTIFACT))!;
    const shimBytes = (await readIfPresent(SHIM_WASM))!;
    const translator = await Translator.create(shimBytes);
    const { plan, adapters } = translator.translate(bytes);

    const shims = wasi();
    const instance = await instantiate(
      { plan, componentBytes: bytes, adapters },
      { ...shims, ...webcryptoFixture() },
    );

    const probeName = plan.exports[0].name;
    // deno-lint-ignore no-explicit-any
    const probe = instance.exports[probeName] as any;
    assertTrue(typeof probe.blockonInSpawn === "function", "probe surfaced");

    // Probe 1 — block_on inside a spawned task, export still live.
    const desc1 = await probe.blockonInSpawn();
    assertTrue(typeof desc1 === "string", "blockon-in-spawn resolved a string");

    // Probes 2+3 — the jco#11 shape: start-pump MUST return while its
    // detached pump task still holds an in-flight wait-for, and poll-pump
    // MUST then run to completion.
    const t0 = performance.now();
    await probe.startPump();
    const startElapsed = performance.now() - t0;
    assertTrue(
      startElapsed < 50,
      `start-pump returned before its 50ms wait-for completed (${startElapsed}ms) ` +
        `— the detached task is still in flight`,
    );
    const desc3 = await probe.pollPump();
    assertTrue(
      typeof desc3 === "string",
      "poll-pump ran to completion after a detached task was left parked " +
        "(lann/jco#11 / polymorph-iroh#10)",
    );

    // Probe 4a — exported stream, read to completion.
    const s1 = await probe.openStream(5000, 1000) as Stream<number>;
    let count = 0;
    for (let i = 0; i < 200; i++) {
      const chunk = await s1.read(4096);
      if ((chunk as { length: number }).length === 0) break;
      count += (chunk as Uint8Array).length;
    }
    assertEq(count, 5000, "host read the full 5000-byte exported stream");

    // Probe 4b — reader dropped mid-stream: the writer must observe
    // resolution ("reader stopped after N bytes"), not trap.
    const s2 = await probe.openStream(100000, 1000) as Stream<number>;
    let count2 = 0;
    while (count2 < 2500) {
      const chunk = await s2.read(1024);
      if ((chunk as { length: number }).length === 0) break;
      count2 += (chunk as Uint8Array).length;
    }
    assertTrue(count2 >= 2500, "read at least 2500 bytes before dropping");
    s2.drop();
    const outcome = await probe.streamOutcome();
    assertTrue(
      typeof outcome === "string" && outcome.includes("reader stopped"),
      `writer observed resolution, not a trap: ${outcome}`,
    );

    // Probe 5 — host-provided stream into the guest. `StreamSource<T>`
    // accepts a plain finite array directly (contracts/embedder-api.md
    // §"Streams and futures": "an array (finite)").
    const payload = new Array(500).fill(0x33);
    const n = await probe.sinkStream(payload);
    assertEq(n, 500, "guest counted every byte of the host-provided stream");
  },
});
