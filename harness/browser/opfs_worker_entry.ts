/// <reference lib="webworker" />
// Dual-mode OPFS smoke worker (issue #129, realm neutrality): runs the SAME
// battery as `opfs_entry.ts`'s page realm, inside a dedicated OR shared
// worker realm. `navigator.storage.getDirectory()` is available in both
// worker kinds, so no OPFS-specific plumbing differs from the page path —
// only the message protocol getting the run started and the report back out
// does.
//
// Bundled to `harness/browser/dist/opfs_worker_entry.js` by
// `tools/browser/opfs-smoke.ts`, spawned by `opfs_entry.ts`'s
// `runSmokeInWorker` as `new Worker(...)` (dedicated) or
// `new SharedWorker(...)` (shared).
//
// One run per worker lifetime: the caller spawns a fresh worker per
// `__opfsSmoke()` call, so there is no multi-run protocol to design here.

import { runComposed, runDirect } from "./opfs_entry.ts";
import type { OpfsRealm, OpfsSmokeReport } from "./opfs_entry.ts";

interface StartMsg {
  kind: "start";
  realm: OpfsRealm;
}

async function run(realm: OpfsRealm): Promise<OpfsSmokeReport> {
  const report: OpfsSmokeReport = {
    userAgent: navigator.userAgent,
    renamePath: "unknown",
    realm,
    direct: [],
    composed: [],
  };
  try {
    await runDirect(report);
  } catch (e) {
    report.direct.push({
      name: "direct setup",
      ok: false,
      detail: String((e as Error)?.stack ?? e),
    });
  }
  await runComposed(report);
  return report;
}

async function handleStart(
  msg: StartMsg,
  post: (data: unknown) => void,
): Promise<void> {
  try {
    const report = await run(msg.realm);
    post({ kind: "report", report });
  } catch (e) {
    post({ kind: "fatal", detail: String((e as Error)?.stack ?? e) });
  }
}

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

if (typeof g.SharedWorkerGlobalScope !== "undefined" && g instanceof g.SharedWorkerGlobalScope) {
  // Shared-worker realm: one connection per page load in this driver's
  // usage, but the onconnect protocol supports more without change.
  g.onconnect = (ev: MessageEvent) => {
    const port = ev.ports[0];
    port.onmessage = (e: MessageEvent) => {
      const msg = e.data as StartMsg;
      if (msg.kind === "start") {
        void handleStart(msg, (data) => port.postMessage(data));
      }
    };
    port.start();
  };
} else {
  // Dedicated-worker realm.
  g.onmessage = (e: MessageEvent) => {
    const msg = e.data as StartMsg;
    if (msg.kind === "start") {
      void handleStart(msg, (data) => g.postMessage(data));
    }
  };
}
