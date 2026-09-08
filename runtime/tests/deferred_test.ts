// Deferred run_tests.py areas: explicitly-ignored placeholders so `deno test`
// output shows what is not yet ported and why.

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
