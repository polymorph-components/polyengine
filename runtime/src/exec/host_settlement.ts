// Private host-JS/canonical-boundary handoff. The JS ingress owns invocation,
// Promise adoption, completion observation, and host-side cleanup. The
// canonical boundary owns whether an observed completion may be delivered.

export type HostSettlement = { value: unknown } | { error: unknown };

export type HostCall =
  | {
    readonly kind: "immediate";
    readonly result?: "raw" | "prepared";
    readonly settlement: HostSettlement;
    readonly hooks?: HostCallHooks<unknown>;
    readonly context?: unknown;
    finish?(settlement: HostSettlement): unknown;
  }
  | {
    readonly kind: "pending";
    readonly result?: "raw" | "prepared";
    /** Attach the one reaction which observes host completion. */
    observe(settle: (settlement: HostSettlement) => void): Promise<void>;
    /** Convert a completion only after the canonical side accepts delivery. */
    readonly hooks?: HostCallHooks<unknown>;
    readonly context?: unknown;
    finish?(settlement: HostSettlement): unknown;
    /** End host-facing call lifetime without cancelling the host operation. */
    discard(): void;
  };

export type HostCallAdapter = (...args: unknown[]) => HostCall;

const promiseThen = Promise.prototype.then;

const adapters = new WeakSet<HostCallAdapter>();

export function markHostCallAdapter<T extends HostCallAdapter>(fn: T): T {
  adapters.add(fn);
  return fn;
}

export function isHostCallAdapter(fn: unknown): fn is HostCallAdapter {
  return typeof fn === "function" && adapters.has(fn as HostCallAdapter);
}

export interface HostCallHooks<C = void> {
  readonly result: "raw" | "prepared";
  invoke(context: C): unknown;
  finish(settlement: HostSettlement, context: C): unknown;
  /** A thenable in this result position is data (not call completion). */
  thenableIsValue?: boolean;
  end?(context: C): void;
  reject?(error: unknown, context: C): void;
}

interface ReusableImmediateHostCall {
  kind: "immediate";
  result?: "raw" | "prepared";
  settlement: HostSettlement;
  hooks?: HostCallHooks<unknown>;
  context: unknown;
  busy: boolean;
}

export function reusableImmediateHostCall<C>(
  hooks: HostCallHooks<C>,
): HostCall {
  return {
    kind: "immediate",
    result: hooks.result,
    settlement: { value: undefined },
    hooks: hooks as HostCallHooks<unknown>,
    context: undefined,
    busy: false,
  } as ReusableImmediateHostCall as HostCall;
}

function immediateHostCall<C>(
  reusable: HostCall | undefined,
  hooks: HostCallHooks<C>,
  context: C,
  settlement: HostSettlement,
): HostCall {
  if (reusable === undefined) {
    return {
      kind: "immediate",
      result: hooks.result,
      settlement,
      hooks: hooks as HostCallHooks<unknown>,
      context,
    };
  }
  const call = reusable as ReusableImmediateHostCall;
  // Host invocation and result preparation can re-enter this same adapter.
  // Never let the nested call overwrite the outer call's reusable carrier.
  if (call.busy) {
    return {
      kind: "immediate",
      result: hooks.result,
      settlement,
      hooks: hooks as HostCallHooks<unknown>,
      context,
    };
  }
  call.busy = true;
  call.settlement = settlement;
  call.context = context;
  return call;
}

function rejectHooks<C>(
  hooks: HostCallHooks<C>,
  context: C,
  error: unknown,
  end: boolean,
): HostSettlement {
  if (end) {
    try {
      hooks.end?.(context);
    } catch {
      // Preserve the host failure.
    }
  }
  try {
    hooks.reject?.(error, context);
  } catch {
    // Preserve the host failure.
  }
  return { error };
}

function pendingHostCall<C>(
  completion: Promise<unknown>,
  hooks: HostCallHooks<C>,
  context: C,
): HostCall {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    hooks.end?.(context);
  };
  const rejected = (error: unknown): HostSettlement => {
    if (!ended) {
      ended = true;
      return rejectHooks(hooks, context, error, true);
    }
    try {
      hooks.reject?.(error, context);
    } catch {
      // Preserve the host failure.
    }
    return { error };
  };
  const fulfilled = (result: unknown): HostSettlement => {
    try {
      end();
      return { value: result };
    } catch (error) {
      return rejected(error);
    }
  };
  return {
    kind: "pending",
    result: hooks.result,
    hooks: hooks as HostCallHooks<unknown>,
    context,
    discard: end,
    observe(settle): Promise<void> {
      try {
        return Reflect.apply(promiseThen, completion, [
          (resolved) => settle(fulfilled(resolved)),
          (error) => settle(rejected(error)),
        ]) as Promise<void>;
      } catch (error) {
        // Promise.prototype.then performs SpeciesConstructor before it
        // installs reactions. If a host corrupts a native Promise's
        // non-configurable constructor/species, there is no portable way to
        // observe its original rejection: retrying repeats the failing step.
        return Promise.resolve().then(() => settle(rejected(error)));
      }
    },
  };
}

/**
 * Invoke one host function and classify its completion exactly once. Immediate
 * values allocate no Promise. A native Promise receives the delivery reaction
 * directly; generic thenable adoption remains the platform's Promise job.
 *
 * All effectful then lookup/adoption/observer setup stays in this host-side
 * lifecycle so failures run the same cleanup and normalization as rejection.
 */
export function invokeHostCall(
  invoke: () => unknown,
  hooks: Omit<HostCallHooks<void>, "invoke" | "result"> & {
    result?: "raw" | "prepared";
  },
): HostCall {
  return invokeHostCallWith(undefined, {
    ...hooks,
    result: hooks.result ?? "raw",
    invoke,
  });
}

/** Allocation-conscious form for adapters with static per-function hooks. */
export function invokeHostCallWith<C>(
  context: C,
  hooks: HostCallHooks<C>,
  reusableImmediate?: HostCall,
): HostCall {
  let value: unknown;
  try {
    value = hooks.invoke(context);
  } catch (error) {
    return immediateHostCall(
      reusableImmediate,
      hooks,
      context,
      rejectHooks(hooks, context, error, true),
    );
  }

  if (!hooks.thenableIsValue) {
    // Native promises are observed through the captured intrinsic without
    // touching an overridden instance `then` property.
    let nativePromise = false;
    try {
      nativePromise = value instanceof Promise;
    } catch (error) {
      return immediateHostCall(
        reusableImmediate,
        hooks,
        context,
        rejectHooks(hooks, context, error, true),
      );
    }
    if (nativePromise) {
      return pendingHostCall(value as Promise<unknown>, hooks, context);
    }
    let then: unknown;
    try {
      then = value !== null &&
          (typeof value === "object" || typeof value === "function")
        ? (value as { then?: unknown }).then
        : undefined;
    } catch (error) {
      return immediateHostCall(
        reusableImmediate,
        hooks,
        context,
        rejectHooks(hooks, context, error, true),
      );
    }
    if (typeof then === "function") {
      // PromiseResolve returns a same-constructor native Promise unchanged and
      // delegates generic thenable assimilation to NewPromiseResolveThenableJob.
      let completion: Promise<unknown>;
      try {
        completion = Promise.resolve(value);
      } catch (error) {
        return immediateHostCall(
          reusableImmediate,
          hooks,
          context,
          rejectHooks(hooks, context, error, true),
        );
      }
      return pendingHostCall(completion, hooks, context);
    }
  }

  let settlement: HostSettlement;
  try {
    hooks.end?.(context);
    settlement = { value };
  } catch (error) {
    // end was attempted already. In particular, do not invoke it twice when
    // cleanup itself throws; only rejection cleanup remains (#343 adjacent).
    settlement = rejectHooks(hooks, context, error, false);
  }
  return immediateHostCall(reusableImmediate, hooks, context, settlement);
}

export function finishHostCall(
  call: HostCall,
  settlement: HostSettlement,
): unknown {
  if (call.hooks === undefined) return call.finish!(settlement);
  const hooks = call.hooks;
  const context = call.context;
  // Release and scrub a reusable carrier before result preparation, which can
  // re-enter the same adapter. The locals keep this call's finish arguments.
  releaseHostCall(call);
  return hooks.finish(settlement, context);
}

/** Release an immediate carrier whose result will not be inspected. */
export function releaseHostCall(call: HostCall): void {
  if (call.kind === "immediate" && "busy" in call) {
    const reusable = call as ReusableImmediateHostCall;
    reusable.busy = false;
    reusable.context = undefined;
    reusable.settlement = { value: undefined };
  }
}

/** Adapt the raw HostImports dialect without imposing facade value/error rules. */
export function adaptHostFunction(
  fn: (...args: unknown[]) => unknown,
): HostCallAdapter {
  if (isHostCallAdapter(fn)) return fn;
  const hooks: HostCallHooks<unknown[]> = {
    result: "raw",
    invoke: (args) => fn(...args),
    finish(settlement) {
      if ("error" in settlement) throw settlement.error;
      return settlement.value;
    },
  };
  const immediate = reusableImmediateHostCall(hooks);
  return markHostCallAdapter((...args: unknown[]) =>
    invokeHostCallWith(args, hooks, immediate)
  );
}
