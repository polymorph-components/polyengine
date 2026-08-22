/// <reference lib="webworker" />
// Worker-realm conformance runner (issue #129, realm neutrality).
//
// One module, both worker kinds: bundled to
// `harness/browser/dist/worker_entry.js` and loaded by `entry.ts`'s
// `__ceRunAll("worker" | "shared-worker")` as a module worker.
//
// The whole run happens HERE: this realm fetches the shim + corpus, runs
// `runAll()` from `./entry.ts`, and POSTs each file to `/ingest` itself, so a
// worker that dies mid-corpus still leaves the driver everything that ran.
// The page gets only progress/terminal messages (it owns every `document`
// touch). The header this realm produces — `userAgent`, `jspi.roundTrip`,
// `realm` — describes THIS realm, which is the point: a JSPI or ambient
// capability that only exists on Window shows up as a delta on the worker row
// rather than silently passing.
//
// Importing `./entry.ts` is safe from a worker: its only top-level effects are
// two `globalThis.__ce*` function assignments; `document` is touched solely
// inside the page-realm branch of `__ceRunAll`, which a worker never calls.

import { type BrowserHeader, type Realm, runAll } from "./entry.ts";

type Outbound =
  | { kind: "file-progress"; path: string; ms: number; done: number }
  | { kind: "done"; header: BrowserHeader; fileCount: number }
  | { kind: "fatal"; detail: string };

type Inbound = { cmd: "run"; realm: Realm };

/** Ingest POSTs, so the terminal `done` can wait for all of them. */
const pending: Promise<void>[] = [];
function post(body: unknown): void {
  const p = fetch("/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(() => {});
  pending.push(p);
}

/**
 * Exactly one corpus run per worker lifetime. A dedicated worker gets one
 * `run` message; a shared worker is spawned fresh per lane invocation and the
 * driver connects exactly once — a second connect/run would interleave two
 * corpora over one `/ingest` stream and corrupt both, so it is refused loudly
 * rather than ignored.
 */
let started = false;

/** Set once a run is requested, so late/uncaught failures can be reported. */
let reply: ((m: Outbound) => void) | null = null;

/**
 * Last-resort error paths. An uncaught throw or a rejected promise inside a
 * worker does NOT reach the page as an `error` event in every case (a
 * discarded async rejection never does, and a shared worker's errors never
 * do), and the driver has no timeout of its own — so forward them explicitly
 * rather than letting the page's silence watchdog turn a crisp failure into
 * an opaque hang.
 */
function reportUncaught(what: string, detail: unknown): void {
  reply?.({
    kind: "fatal",
    detail: `${what}: ${
      detail instanceof Error ? detail.stack ?? detail.message : String(detail)
    }`,
  });
}

async function run(realm: Realm, reply: (m: Outbound) => void): Promise<void> {
  if (started) {
    reply({
      kind: "fatal",
      detail: "second run requested on a worker that already ran a corpus",
    });
    return;
  }
  started = true;
  try {
    let done = 0;
    const out = await runAll({
      realm,
      onHeader: (h) => post({ kind: "header", header: h }),
      onFile: (f) => {
        done++;
        post({ kind: "file", file: f });
        reply({ kind: "file-progress", path: f.path, ms: f.ms, done });
      },
    });
    // Drain the ingest stream BEFORE the page resolves: the driver tears the
    // server down as soon as `__ceRunAll` returns, and an in-flight POST at
    // that moment would read as a shrunken corpus.
    await Promise.allSettled(pending);
    post({ kind: "done" });
    await Promise.allSettled(pending);
    reply({
      kind: "done",
      header: out.header,
      fileCount: out.header.fileCount,
    });
  } catch (e) {
    reply({
      kind: "fatal",
      detail: `run threw: ${
        e instanceof Error ? e.stack ?? e.message : String(e)
      }`,
    });
  }
}

// deno-lint-ignore no-explicit-any
const scope = self as any;

const isShared = typeof SharedWorkerGlobalScope !== "undefined" &&
  scope instanceof SharedWorkerGlobalScope;

if (isShared) {
  scope.onconnect = (ev: MessageEvent) => {
    const port = (ev as unknown as { ports: MessagePort[] }).ports[0];
    port.onmessage = (m: MessageEvent) => {
      const msg = m.data as Inbound;
      if (msg?.cmd === "run") {
        reply = (o) => port.postMessage(o);
        void run(msg.realm, reply);
      }
    };
    port.start();
    scope.onerror = (e: ErrorEvent | Event) => {
      // A shared worker's uncaught errors do NOT reach the connecting page, so
      // forward them explicitly or the driver would only see silence.
      port.postMessage(
        {
          kind: "fatal",
          detail: `uncaught in shared worker: ${
            (e as ErrorEvent).message ?? String(e)
          }`,
        } satisfies Outbound,
      );
    };
  };
} else {
  scope.onmessage = (m: MessageEvent) => {
    const msg = m.data as Inbound;
    if (msg?.cmd === "run") {
      reply = (o) => scope.postMessage(o);
      void run(msg.realm, reply);
    }
  };
}

scope.addEventListener("error", (e: ErrorEvent) => {
  reportUncaught("uncaught error in worker realm", e.error ?? e.message);
});
scope.addEventListener(
  "unhandledrejection",
  (e: PromiseRejectionEvent) => {
    reportUncaught("unhandled rejection in worker realm", e.reason);
  },
);
