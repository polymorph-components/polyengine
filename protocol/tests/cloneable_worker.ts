// The other side of the A20 realm boundary (contracts/embedder-api.md
// §"Realm boundaries and structured-clone-safe forms"; issue #131).
//
// A module worker is a genuinely separate realm with its own module graph:
// this file's `@polyengine/protocol` is a different copy of the package, its
// classes different classes. Everything below therefore rests on brands and
// on `fromCloneable` minting LOCAL values — which is exactly the property
// under test.

import {
  type ComponentException,
  fromCloneable,
  isComponentException,
  isPeerTrappedError,
  isTrap,
  type PeerTrappedError,
} from "../src/mod.ts";

// `deno check` types this file in the main (window) lib, so the worker scope
// is reached through an explicit cast rather than a `deno.worker` lib
// reference — the alternative pulls a whole conflicting lib into a directory
// checked as one graph.
const scope = self as unknown as {
  onmessage: (ev: MessageEvent) => void;
  postMessage: (data: unknown) => void;
};

scope.onmessage = (ev: MessageEvent) => {
  const checks: Record<string, boolean> = {};
  try {
    const exception = fromCloneable(ev.data.exception) as ComponentException<
      { kind: string; value: number }
    >;
    checks["exception is branded"] = isComponentException(exception);
    checks["exception message"] = exception.message === "nope";
    checks["exception is a local Error"] = exception instanceof Error;
    checks["payload kind"] = exception.payload.kind === "denied";
    checks["payload value"] = exception.payload.value === 7;

    const peer = fromCloneable(ev.data.peer) as PeerTrappedError;
    checks["peer is branded"] = isPeerTrappedError(peer);
    checks["peer progress"] = peer.progress === 3;
    checks["peer message"] = peer.message.includes("stream write");
    const middle = peer.cause as Error;
    checks["peer cause is an unbranded Error"] = middle instanceof Error &&
      !isTrap(middle);
    checks["peer cause message"] =
      middle.message === "instance trapped while holding an end";
    const trap = middle.cause as Error;
    checks["trap survives at depth 2"] = isTrap(trap);
    checks["trap message"] = trap.message === "guest trapped";
  } catch (e) {
    checks[`worker threw: ${e instanceof Error ? e.message : String(e)}`] =
      false;
  }
  scope.postMessage(checks);
};
