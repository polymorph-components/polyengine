;; A genuine deadlock across a sync-lowered call, for the jspi driver.
;;
;; Component $A exports an ASYNC-lifted function whose implementation parks on
;; a freshly created, EMPTY waitable set. Nothing holds a handle to that set,
;; so no event can ever be delivered to it: the callee can never resolve.
;; Component $B calls it through a plain SYNC lower, which is FACT's
;; `sync-start-call` -- the site that (in jspi mode) parks the CALLER's wasm
;; activation waiting for that callee.
;;
;; Both sides are therefore stuck, and stuck in the one way the scheduler is
;; required to notice: no thread is ready, nothing is awaiting a promise, and
;; no host call is outstanding. The Component Model's answer is the deadlock
;; TRAP (definitions.py `canon_lift`'s driving loop: an empty candidate set is
;; `trap_if`, not a hang), and the driver must produce it as a Trap rather than
;; stall forever on a promise nothing will settle.
;;
;; Regenerate with:
;;   cargo run -p translator-shim --example emit-testdata -- deadlock-sync-call
(component
  (component $A
    ;; Memory lives in its own module instantiated first, so the
    ;; `waitable-set.wait` canon (which needs a memory) can be declared before
    ;; the module that imports it -- same dependency-breaking shape as
    ;; async-linked.wat.
    (core module $MEM (memory (export "mem") 1))
    (core instance $imem (instantiate $MEM))
    (core func $task-return (canon task.return (result u32)))
    (core func $waitable-set.new (canon waitable-set.new))
    (core func $waitable-set.wait
      (canon waitable-set.wait (memory (core memory $imem "mem"))))
    (core module $MA
      (import "" "task.return" (func $task-return (param i32)))
      (import "" "waitable-set.new" (func $waitable-set.new (result i32)))
      (import "" "waitable-set.wait" (func $waitable-set.wait (param i32 i32) (result i32)))
      ;; Park on a set nothing will ever signal. Control never reaches the
      ;; task.return below, which is the point.
      (func (export "block-impl") (param i32 i32) (result i32)
        (drop (call $waitable-set.wait (call $waitable-set.new) (i32.const 0)))
        (call $task-return (i32.const 42))
        (i32.const 0))
      (func (export "cb") (param i32 i32 i32) (result i32)
        (i32.const 0)))
    (core instance $ia (instantiate $MA
      (with "" (instance
        (export "task.return" (func $task-return))
        (export "waitable-set.new" (func $waitable-set.new))
        (export "waitable-set.wait" (func $waitable-set.wait))))))
    (func (export "block") async (param "a" u32) (param "b" u32) (result u32)
      (canon lift (core func $ia "block-impl") async (callback (func $ia "cb")))))

  (component $B
    (import "blocker" (instance $blocker
      (export "block" (func async (param "a" u32) (param "b" u32) (result u32)))))
    ;; SYNC lower of the async-lifted import => FACT sync-start-call.
    (core func $block_sync (canon lower (func $blocker "block")))
    (core module $MB
      (import "blocker" "block" (func $block (param i32 i32) (result i32)))
      (func (export "run") (result i32)
        (call $block (i32.const 1) (i32.const 2))))
    (core instance $ib (instantiate $MB
      (with "blocker" (instance (export "block" (func $block_sync))))))
    (func (export "run") (result u32)
      (canon lift (core func $ib "run"))))

  (instance $a (instantiate $A))
  (instance $b (instantiate $B (with "blocker" (instance $a))))
  (export "run" (func $b "run")))
