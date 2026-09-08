// Defensive identity checks: parent substitution must not erase child abstraction.
import { assertEq, assertTrap } from "./support/asserts.ts";
import { Translator } from "../src/shim/mod.ts";
import { instantiateComponent } from "../src/exec/mod.ts";
import {
  canonResourceNew,
  canonResourceRep,
  LiftLowerContext,
  ResourceHandle,
  ResourceTableInfo,
  ResourceTypeInfo,
  Trap,
  type ValType,
  valTypeEqual,
} from "../src/cabi/mod.ts";
import {
  liftFuture,
  liftStream,
  lowerFuture,
  lowerStream,
} from "../src/cabi/async_values.ts";
import * as builtin from "../src/intrinsics/stream_builtins.ts";
import { createTaskReturn } from "../src/intrinsics/async_builtins.ts";
import {
  createTrampoline,
  SyncCallScope,
  type TrampolineContext,
} from "../src/intrinsics/mod.ts";
import {
  cabiOptions,
  LiveMemory,
  type ResolvedOptions,
} from "../src/exec/boundary.ts";
import {
  ComponentInstanceState,
  CopyEnd,
  CopyState,
  popCurrentThread,
  pushCurrentThread,
  Store,
  Task,
  Thread,
} from "../src/task/mod.ts";

function identityTrap(fn: () => unknown, message: string): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assertEq(
    error instanceof Trap && error.message.includes(message),
    true,
    String(error),
  );
}

function fixture() {
  const store = new Store();
  const src = new ComponentInstanceState(0, store);
  const dst = new ComponentInstanceState(1, store);
  const origin = new ResourceTypeInfo(null);
  const tables = [
    new ResourceTableInfo(origin),
    new ResourceTableInfo(origin),
    new ResourceTableInfo(origin),
    new ResourceTableInfo(new ResourceTypeInfo(null)),
  ];
  const elems: ValType[] = tables.map((rt) => ({
    kind: "record",
    fields: [
      { label: "value", type: { kind: "own", rt } },
    ],
  }));
  const wasmMemory = new WebAssembly.Memory({ initial: 1 });
  const memory = new LiveMemory(() => wasmMemory, "identity fixture");
  const opts: ResolvedOptions = {
    instance: src,
    memory,
    stringEncoding: "utf8",
    realloc: null,
    postReturn: null,
    callback: null,
    async: true,
    cancellable: false,
    coreType: { params: ["i32"], results: [] },
  };
  const ctx = {
    componentInstance: () => src,
    options: () => opts,
    streamElem: (i: number) => elems[i],
    futureElem: (i: number) => elems[i],
    streamTableInstance: (i: number) => i === 0 ? src : dst,
    futureTableInstance: (i: number) => i === 0 ? src : dst,
  };
  return { src, dst, tables, elems, memory, opts, ctx };
}

for (const kind of ["stream", "future"] as const) {
  const api = kind === "stream"
    ? {
      new: builtin.createStreamNew,
      read: builtin.createStreamRead,
      write: builtin.createStreamWrite,
      cancelRead: builtin.createStreamCancelRead,
      cancelWrite: builtin.createStreamCancelWrite,
      dropRead: builtin.createStreamDropReadable,
      dropWrite: builtin.createStreamDropWritable,
      transfer: builtin.createStreamTransfer,
    }
    : {
      new: builtin.createFutureNew,
      read: builtin.createFutureRead,
      write: builtin.createFutureWrite,
      cancelRead: builtin.createFutureCancelRead,
      cancelWrite: builtin.createFutureCancelWrite,
      dropRead: builtin.createFutureDropReadable,
      dropWrite: builtin.createFutureDropWritable,
      transfer: builtin.createFutureTransfer,
    };
  const decl = (i: number) => ({
    streamTable: i,
    futureTable: i,
    options: 0,
    async: true,
  });
  for (
    const op of [
      "read",
      "write",
      "cancelRead",
      "cancelWrite",
      "dropRead",
      "dropWrite",
      "lift",
      "transfer",
    ] as const
  ) {
    Deno.test(`${kind} identity: ${op} rejects a different local payload with the same origin`, () => {
      const f = fixture();
      const packed = api.new(decl(0), f.ctx, f.src)() as bigint;
      const readable = Number(packed & 0xffff_ffffn);
      const writable = Number(packed >> 32n);
      const writing = op === "write" || op === "cancelWrite" ||
        op === "dropWrite";
      const index = writing ? writable : readable;
      const end = f.src.handles.get(index) as CopyEnd;
      assertEq(end.elem === f.elems[0], true);
      if (op === "cancelRead" || op === "cancelWrite") {
        end.state = CopyState.COPYING;
      }
      if (op === "dropWrite" && kind === "future") end.state = CopyState.DONE;
      const cx = new LiftLowerContext(cabiOptions(f.opts), f.src);
      let error: unknown;
      try {
        if (op === "lift") {
          if (kind === "stream") {
            liftStream(cx, index, { kind, element: f.elems[1] });
          } else liftFuture(cx, index, { kind, element: f.elems[1] });
        } else if (op === "transfer") {
          // Wrong source descriptor, but the actual source instance is unchanged.
          api.transfer({
            ...f.ctx,
            streamTableInstance: () => f.src,
            futureTableInstance: () => f.src,
          })(index, 1, 2);
        } else api[op](decl(1), f.ctx, f.src)(index, 0, 1);
      } catch (e) {
        error = e;
      }
      assertEq(
        error instanceof Error && error.message.includes("element"),
        true,
        String(error),
      );
      assertTrap(() => {
        throw error;
      });
    });
  }

  for (const boundary of ["lower", "transfer"] as const) {
    Deno.test(`${kind} identity: ${boundary} stamps destination and preserves source during resource copy`, () => {
      const f = fixture();
      const packed = api.new(decl(0), f.ctx, f.src)() as bigint;
      const ri = Number(packed & 0xffff_ffffn);
      const wi = Number(packed >> 32n);
      const original = f.src.handles.get(ri) as CopyEnd;
      const writer = f.src.handles.get(wi) as CopyEnd;
      const srcCx = new LiftLowerContext(cabiOptions(f.opts), f.src);
      const dstCx = new LiftLowerContext(cabiOptions(f.opts), f.dst);
      let received: number;
      if (boundary === "transfer") {
        received = api.transfer(f.ctx)(ri, 0, 1) as number;
      } else if (kind === "stream") {
        received = lowerStream(
          dstCx,
          liftStream(srcCx, ri, { kind, element: f.elems[0] }),
          { kind, element: f.elems[1] },
        );
      } else {received = lowerFuture(
          dstCx,
          liftFuture(srcCx, ri, { kind, element: f.elems[0] }),
          { kind, element: f.elems[1] },
        );}
      const reader = f.dst.handles.get(received) as CopyEnd;
      assertEq(reader.shared === original.shared, true);
      assertEq(reader.elem === f.elems[1], true);
      assertEq(writer.elem === f.elems[0], true);
      assertEq(original.shared.t === f.elems[0], true);
      assertTrap(() => f.src.handles.get(ri));
      identityTrap(
        () => api.read(decl(2), f.ctx, f.dst)(received, 4, 1),
        "element type mismatch",
      );
      const handle = canonResourceNew(f.src, f.tables[0], 73);
      f.memory.view.setUint32(0, handle, true);
      api.write(decl(0), f.ctx, f.src)(wi, 0, 1);
      api.read(decl(1), f.ctx, f.dst)(received, 4, 1);
      const output = f.memory.view.getUint32(4, true);
      assertEq(canonResourceRep(f.dst, f.tables[1], output), 73);
      assertTrap(() => canonResourceRep(f.dst, f.tables[2], output));
      assertTrap(() => f.src.handles.get(handle));
      assertEq(reader.shared.t === f.elems[0], true);
    });
  }

  Deno.test(`${kind} identity: transfer rejects a different underlying origin`, () => {
    const f = fixture();
    const packed = api.new(decl(0), f.ctx, f.src)() as bigint;
    identityTrap(
      () => api.transfer(f.ctx)(Number(packed & 0xffff_ffffn), 0, 3),
      "destination element mismatch",
    );
  });
}

Deno.test("FACT resource transfer validates local source and tags destination", () => {
  const f = fixture();
  const scopes = [new SyncCallScope()];
  const ctx = {
    resourceToken: (i: number) => f.tables[i],
    resourceTableInstance: (i: number) => i < 2 ? f.src : f.dst,
    syncCallStack: scopes,
    factStartScopes: [],
    trapState: { pending: null },
  } as unknown as TrampolineContext;
  for (
    const kind of ["resource-transfer-own", "resource-transfer-borrow"] as const
  ) {
    const transfer = createTrampoline({ kind } as never, ctx);
    const wrong = canonResourceNew(f.src, f.tables[0], 51);
    identityTrap(() => transfer(wrong, 1, 2), "resource type mismatch");
    const good = canonResourceNew(f.src, f.tables[0], 52);
    const out = transfer(good, 0, 2) as number;
    const handle = f.dst.handles.get(out) as ResourceHandle;
    assertEq(handle.rt === f.tables[2], true);
    assertEq(handle.rep, 52);
  }
  scopes[0].releaseLenders();
});

for (const fact of [false, true]) {
  Deno.test(`task.return identity: nested local result equality (FACT=${fact})`, () => {
    for (const matching of [false, true]) {
      const f = fixture();
      const result: ValType = { kind: "future", element: f.elems[0] };
      const declared: ValType = {
        kind: "future",
        element: f.elems[matching ? 0 : 1],
      };
      assertEq(valTypeEqual(result, declared), matching);
      const packed = builtin.createFutureNew(
        { futureTable: 0 },
        f.ctx,
        f.src,
      )() as bigint;
      const ri = Number(packed & 0xffff_ffffn);
      const task = new Task(
        { params: [], results: [result], async: true },
        {
          async_: true,
          callback: false,
          stringEncoding: "utf8",
          memory: f.memory,
        },
        f.src,
        () => [],
        () => {},
      );
      task.factPassthrough = fact;
      task.factResultTypesKnown = true;
      task.state = "started";
      const call = createTaskReturn({ results: 0, resultType: 0, options: 0 }, {
        ...f.ctx,
        resultTypes: () => [declared],
      });
      const thread = new Thread(task, (function* () {})());
      pushCurrentThread(thread);
      try {
        if (matching) {
          call(ri);
          assertEq(task.state, "resolved");
        } else {identityTrap(() =>
            call(ri), "result type that is not the task's result type");}
      } finally {
        popCurrentThread(thread);
      }
    }
  });
}

Deno.test("linked resource identity: same local type succeeds, distinct child import rejects", async () => {
  const translator = await Translator.create(
    await Deno.readFile(
      new URL(
        "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
        import.meta.url,
      ),
    ),
  );
  const componentBytes = await Deno.readFile(
    new URL("resource_identity.wasm", import.meta.url),
  );
  const { plan, adapters } = translator.translate(componentBytes);
  const tables = plan.resourceTables.filter((t) => t.kind === "concrete");
  assertEq(
    tables.some((a, i) =>
      tables.some((b, j) =>
        i !== j && a.resource === b.resource && a.instance === b.instance
      )
    ),
    true,
    "fixture must retain distinct local tables with equal origin and instance",
  );
  const c = await instantiateComponent({
    plan,
    adapters,
    componentBytes,
    jspi: false,
  });
  const exports = c.exports as Record<string, () => unknown>;
  exports.same();
  assertEq(exports.count(), 1);
  identityTrap(() => exports.different(), "resource type mismatch");
});
