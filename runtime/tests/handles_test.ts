// Resource-handle table logic: the pure parts of run_tests.py test_handles
// (slab reuse, own transfer, rep, drop + dtor, borrow lend counting),
// exercised directly against the table/handle functions. The parts that
// need canon_lift/canon_lower and Task-scoped borrow lifetimes stay deferred
// (see deferred_test.ts).

import {
  canonResourceDrop,
  canonResourceNew,
  canonResourceRep,
  type ComponentInstanceLike,
  liftBorrow,
  LiftLowerContext,
  liftOwn,
  lowerBorrow,
  lowerOwn,
  type ResourceHandle,
  ResourceTableInfo,
  ResourceTypeInfo,
  type SubtaskBorrowScope,
  Table,
  type TaskBorrowScope,
} from "../src/cabi/mod.ts";
import { mkOpts } from "./support/driver.ts";
import { assertEq, assertTrap } from "./support/asserts.ts";

function mkInst(): ComponentInstanceLike {
  return { handles: new Table<unknown>(), mayLeave: true };
}

class MockSubtask implements SubtaskBorrowScope {
  lenders: ResourceHandle[] = [];
  addLender(h: ResourceHandle) {
    h.numLends += 1;
    this.lenders.push(h);
  }
  deliverResolve() {
    for (const h of this.lenders) h.numLends -= 1;
    this.lenders = [];
  }
}

Deno.test("Table: index 0 reserved, dense add, free-list reuse (LIFO)", () => {
  const t = new Table<string>();
  assertEq(t.add("a"), 1);
  assertEq(t.add("b"), 2);
  assertEq(t.add("c"), 3);
  assertEq(t.get(2), "b");
  assertEq(t.remove(1), "a");
  assertEq(t.remove(2), "b");
  // free list is LIFO: last removed index is reused first
  assertEq(t.add("d"), 2);
  assertEq(t.add("e"), 1);
  assertEq(t.add("f"), 4);
  assertEq(t.array.length, 5);
});

Deno.test("Table: traps on empty/out-of-range indices", () => {
  const t = new Table<string>();
  t.add("a");
  assertTrap(() => t.get(0), "index 0 is the null sentinel");
  assertTrap(() => t.get(99), "out of range");
  assertTrap(() => t.remove(2), "never allocated");
  t.remove(1);
  assertTrap(() => t.get(1), "already removed");
  assertTrap(() => t.remove(1), "double remove");
});

Deno.test("resource.new / resource.rep / resource.drop with dtor", () => {
  const inst = mkInst();
  let dtorValue: number | null = null;
  const rt = new ResourceTableInfo(
    new ResourceTypeInfo(inst, (rep) => {
      dtorValue = rep;
    }),
  );

  const h1 = canonResourceNew(inst, rt, 42);
  const h2 = canonResourceNew(inst, rt, 43);
  assertEq([h1, h2], [1, 2]);
  assertEq(canonResourceRep(inst, rt, h1), 42);
  assertEq(canonResourceRep(inst, rt, h2), 43);

  canonResourceDrop(inst, rt, h1);
  assertEq(dtorValue, 42 as number | null, "dtor received the rep");
  assertTrap(() => canonResourceRep(inst, rt, h1), "handle gone after drop");

  // freed slot is reused by the next new (mirrors test_handles h == h1)
  const h3 = canonResourceNew(inst, rt, 46);
  assertEq(h3, h1);
});

Deno.test("resource type identity is enforced", () => {
  const inst = mkInst();
  const rtA = new ResourceTableInfo(new ResourceTypeInfo(inst));
  const rtB = new ResourceTableInfo(rtA.resource);
  const h = canonResourceNew(inst, rtA, 1);
  assertTrap(() => canonResourceRep(inst, rtB, h), "rep with wrong rt");
  assertTrap(() => canonResourceDrop(inst, rtB, h), "drop with wrong rt");
});

Deno.test("may_leave gates resource.new and resource.drop", () => {
  const inst = mkInst();
  const rt = new ResourceTableInfo(new ResourceTypeInfo(inst));
  const h = canonResourceNew(inst, rt, 5);
  inst.mayLeave = false;
  assertTrap(() => canonResourceNew(inst, rt, 6));
  assertTrap(() => canonResourceDrop(inst, rt, h));
  inst.mayLeave = true;
  canonResourceDrop(inst, rt, h);
});

Deno.test("own lift/lower: transfer moves the handle out of the table", () => {
  const inst = mkInst();
  const rt = new ResourceTableInfo(new ResourceTypeInfo(inst));
  const cx = new LiftLowerContext(mkOpts(), inst);
  const ownT = { kind: "own", rt } as const;

  const i = lowerOwn(cx, 42, ownT);
  assertEq(i, 1);
  const rep = liftOwn(cx, i, ownT);
  assertEq(rep, 42);
  assertTrap(() => liftOwn(cx, i, ownT), "own handle consumed by lift");
});

Deno.test("own lift traps: wrong type, borrowed handle, lent-out handle", () => {
  const inst = mkInst();
  const rt = new ResourceTableInfo(new ResourceTypeInfo(inst));
  const rt2 = new ResourceTableInfo(rt.resource);
  const cx = new LiftLowerContext(mkOpts(), inst);

  // NB: like the reference, lift_own removes the handle *before* the type
  // check traps (a trap is fatal to the instance), so each trap consumes it.
  let i = lowerOwn(cx, 42, { kind: "own", rt });
  assertTrap(() => liftOwn(cx, i, { kind: "own", rt: rt2 }), "rt mismatch");

  // a lent-out own handle cannot be transferred
  i = lowerOwn(cx, 42, { kind: "own", rt });
  const subtask = new MockSubtask();
  const cxBorrow = new LiftLowerContext(mkOpts(), inst, subtask);
  assertTrap(
    () => liftBorrow(cxBorrow, i, { kind: "borrow", rt: rt2 }),
    "local borrow identity",
  );
  assertEq((inst.handles.get(i) as ResourceHandle).numLends, 0);
  liftBorrow(cxBorrow, i, { kind: "borrow", rt });
  assertTrap(() => liftOwn(cx, i, { kind: "own", rt }), "num_lends != 0");
  subtask.deliverResolve();
  // the failed lift consumed the table entry; lower a fresh own handle
  i = lowerOwn(cx, 42, { kind: "own", rt });
  assertEq(liftOwn(cx, i, { kind: "own", rt }), 42, "liftable when not lent");

  // a borrow handle cannot be lifted as own
  const task: TaskBorrowScope = { numBorrows: 0 };
  const otherImpl = mkInst();
  const rtOther = new ResourceTableInfo(new ResourceTypeInfo(otherImpl));
  const cxLowerBorrow = new LiftLowerContext(mkOpts(), inst, task);
  const bi = lowerBorrow(cxLowerBorrow, 7, { kind: "borrow", rt: rtOther });
  assertTrap(
    () => liftOwn(cx, bi, { kind: "own", rt: rtOther }),
    "own lift of borrow handle",
  );
});

Deno.test("borrow lift counts lends; drop of lent handle traps", () => {
  const inst = mkInst();
  const rt = new ResourceTableInfo(new ResourceTypeInfo(inst));
  const subtask = new MockSubtask();
  const cx = new LiftLowerContext(mkOpts(), inst, subtask);

  const i = canonResourceNew(inst, rt, 42);
  const rep = liftBorrow(cx, i, { kind: "borrow", rt });
  assertEq(rep, 42);
  const h = inst.handles.get(i) as ResourceHandle;
  assertEq(h.numLends, 1);

  // reference semantics: drop removes the entry, then traps on num_lends
  assertTrap(() => canonResourceDrop(inst, rt, i), "drop while lent");
  subtask.deliverResolve();
  assertEq(h.numLends, 0);
  // the trapped drop consumed the entry; a fresh handle drops cleanly
  const i2 = canonResourceNew(inst, rt, 43);
  canonResourceDrop(inst, rt, i2);
});

Deno.test("borrow lower: self-instance passthrough vs cross-instance handle", () => {
  const implInst = mkInst();
  const rt = new ResourceTableInfo(new ResourceTypeInfo(implInst));
  const task: TaskBorrowScope = { numBorrows: 0 };

  // lowering into the implementing instance passes the rep through
  const cxSelf = new LiftLowerContext(mkOpts(), implInst, task);
  assertEq(lowerBorrow(cxSelf, 42, { kind: "borrow", rt }), 42);
  assertEq(task.numBorrows, 0);

  // lowering into another instance creates a borrow handle + counts it
  const otherInst = mkInst();
  const cxOther = new LiftLowerContext(mkOpts(), otherInst, task);
  const i = lowerBorrow(cxOther, 43, { kind: "borrow", rt });
  assertEq(i, 1);
  assertEq(task.numBorrows, 1);
  const h = otherInst.handles.get(i) as ResourceHandle;
  assertEq(h.own, false);
  assertEq(h.rep, 43);

  // dropping the borrow gives the count back
  canonResourceDrop(otherInst, rt, i);
  assertEq(task.numBorrows, 0);
});
