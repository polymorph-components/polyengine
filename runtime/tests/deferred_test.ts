// Deferred run_tests.py areas: explicitly-ignored placeholders so `deno test`
// output shows what is not yet ported and why.
//
// The task core + callback ABI landed the task/thread/waitable
// machinery, so the entries that were blocked purely on "the scheduler does
// not exist" are gone — their content now lives in real tests:
//
//   test_async_callback, test_callback_interleaving, test_async_backpressure,
//   test_sync_ignores_backpressure   -> tests/task_test.ts
//   test_async_to_async, test_async_to_sync, test_async_flat_params
//                                    -> tests/async_lower_test.ts
//                                       + tests/integration/e2e_async_test.ts
//   test_cancel_subtask (host side)  -> tests/task_test.ts (cancellation)
//   test_roundtrips (driving loop)   -> tests/task_test.ts (sync driving loop,
//                                       deadlock trap) + the e2e suites
//   stream/future + error-context    -> the value types are implemented
//   lift/lower                          (cabi/async_values.ts), the copy
//                                       protocol lives in task/streams.ts, and
//                                       the host-side ends the reference tests
//                                       needed are exec/host_streams.ts —
//                                       exercised by
//                                       tests/integration/e2e_streams_test.ts
//   test_handles (full port)         -> host-side ends give the missing piece
//                                       (a host that drives a component and
//                                       holds handles across the call)
//
// What remains ignored is blocked on a *capability*, not on the scheduler:
// a host-API addition, the component instance tree, and 🧵 threads. The two
// JSPI-blocked entries retired once auto-detection landed:
//
//   test_sync_using_wait            -> a sync task's blocking waitable-set.wait
//                                      is lit (jspi site 2) and exercised green
//                                      under auto-detection by
//                                      test/async/sync-streams.wast (sync copies
//                                      blocking mid-frame) and
//                                      big-interleaving-test.wast's stackful
//                                      `await` exports
//   test_thread_cancel_callback     -> cancellation delivered to a thread
//                                      parked inside a blocking built-in is
//                                      exercised green by
//                                      test/async/cancellable.wast (cancellable
//                                      wait/yield + pending-cancel delivery;
//                                      requestCancellation finds
//                                      SuspensionPoints since the flip)

const deferred: [name: string, reason: string][] = [
  [
    "test_cancel_copy (host-driven)",
    "the host stream API has read/write/drop but no cancel operation " +
    "(HostReadableEnd/HostWritableEnd lack a shared.cancel counterpart); " +
    "run_tests.py's host-driven cancellation permutations and " +
    "test_host_partial_reads_writes' buffer-size permutations have no TS " +
    "port yet — e2e guests cover the shapes, not the permutations " +
    "(review advisory, host-streams round; bindgen-era API addition)",
  ],
  [
    "test_cross_component_realloc",
    "needs the component instance *tree* (ComponentInstance.parent) so a " +
    "callee can reach a caller's realloc across a nested lift; the plan has " +
    "no wire form for instance nesting — v0.3 contract friction, not a " +
    "scheduler gap",
  ],
  [
    "threads: test_threads, test_sync_threads (thread.* built-ins)",
    "🧵 shared-everything threads (thread.new-indirect, " +
    "thread.{suspend,resume-later,switch-to,...}) are deferred with memory64 " +
    "per https://github.com/polymorph-components/polyengine/issues/12; context.get/set — the part of this group that async " +
    "guests actually use — IS implemented (intrinsics/context.ts)",
  ],
];

for (const [name, reason] of deferred) {
  Deno.test({
    name: `DEFERRED: ${name}`,
    ignore: true,
    fn() {
      throw new Error(`deferred: ${reason}`);
    },
  });
}
