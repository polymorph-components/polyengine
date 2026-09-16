;; Real Component Model explicit-thread exercises. Host marks make every
;; transfer observable without driving Store.tick from the test.
(component
  (import "mark" (func $mark (param "value" u32)))
  (import "child-gate" (func $child-gate async))
  (import "holder-gate" (func $holder-gate async))
  (core module $Table
    (table (export "table") 12 funcref))
  (core instance $table (instantiate $Table))
  (alias core export $table "table" (core table $table-export))

  (core type $start-type (func (param i32)))
  (canon lower (func $mark) (core func $mark-lower))
  ;; Synchronous lowers of async host imports create real, controlled JSPI
  ;; parks. The callback task retains its exclusive slot across holder-gate;
  ;; the explicit child remains independent while parked on child-gate.
  (canon lower (func $child-gate) (core func $child-gate-lower))
  (canon lower (func $holder-gate) (core func $holder-gate-lower))
  (canon thread.index (core func $thread-index))
  (core func $thread-new
    (canon thread.new-indirect $start-type (core table $table-export)))
  (canon thread.resume-later (core func $resume-later))
  (canon thread.suspend (core func $suspend-cancellable))
  (canon thread.suspend-then-resume
    (core func $suspend-then-resume))
  (canon thread.suspend-then-resume
    (core func $suspend-then-resume-cancellable))
  (canon thread.yield-then-resume
    (core func $yield-then-resume))
  (canon thread.yield-then-promote
    (core func $yield-then-promote))
  (canon task.return (result u32) (core func $task-return))

  (core module $Core
    (import "" "table" (table $table 12 funcref))
    (import "" "mark" (func $mark (param i32)))
    (import "" "child-gate" (func $child-gate))
    (import "" "holder-gate" (func $holder-gate))
    (import "" "thread-index" (func $thread-index (result i32)))
    (import "" "thread-new" (func $thread-new (param i32 i32) (result i32)))
    (import "" "resume-later" (func $resume-later (param i32)))
    (import "" "suspend-cancellable" (func $suspend-cancellable (result i32)))
    (import "" "suspend-then-resume" (func $suspend-then-resume (param i32) (result i32)))
    (import "" "suspend-then-resume-cancellable" (func $suspend-then-resume-cancellable (param i32) (result i32)))
    (import "" "yield-then-resume" (func $yield-then-resume (param i32) (result i32)))
    (import "" "yield-then-promote" (func $yield-then-promote (param i32) (result i32)))
    (import "" "task-return" (func $task-return (param i32)))

    (func $child-resume-later (param $parent i32)
      (call $mark (i32.const 10))
      (call $resume-later (local.get $parent)))
    (func $child-switch-back (param $parent i32)
      (call $mark (i32.const 20))
      (drop (call $suspend-then-resume (local.get $parent)))
      (call $mark (i32.const 22)))
    (func $child-yield-back (param $parent i32)
      (call $mark (i32.const 30))
      (drop (call $yield-then-resume (local.get $parent)))
      (call $mark (i32.const 32)))
    (func $child-mark (param i32) (call $mark (i32.const 40)))
    (func $child-cancel-noexec (param i32) (call $mark (i32.const 60)))
    (func $child-suspend-cancellable (param i32)
      (call $child-gate)
      (call $mark (i32.const 70))
      (drop (call $suspend-cancellable))
      (call $mark (i32.const 71))
      (call $task-return (i32.const 110)))
    (func $child-trap (param i32) unreachable)
    (func $child-normal (param i32))
    (func $child-continue (param i32) (call $mark (i32.const 80)))
    (func $child-suspended-noexec (param i32) (call $mark (i32.const 81)))
    (elem (table $table) (i32.const 0) func
      $child-resume-later $child-switch-back $child-yield-back $child-mark
      $child-cancel-noexec $child-suspend-cancellable $child-trap $child-normal
      $child-continue $child-suspended-noexec)

    (func (export "resume-later") (result i32)
      (local $parent i32) (local $child i32)
      (call $mark (i32.const 1))
      (local.set $parent (call $thread-index))
      (local.set $child (call $thread-new (i32.const 0) (local.get $parent)))
      (drop (call $suspend-then-resume (local.get $child)))
      (call $mark (i32.const 11))
      (i32.const 101))

    (func (export "switch-back") (result i32)
      (local $parent i32) (local $child i32)
      (call $mark (i32.const 2))
      (local.set $parent (call $thread-index))
      (local.set $child (call $thread-new (i32.const 1) (local.get $parent)))
      (drop (call $suspend-then-resume (local.get $child)))
      (call $mark (i32.const 21))
      (i32.const 102))

    (func (export "yield-back") (result i32)
      (local $parent i32) (local $child i32)
      (call $mark (i32.const 3))
      (local.set $parent (call $thread-index))
      (local.set $child (call $thread-new (i32.const 2) (local.get $parent)))
      (drop (call $suspend-then-resume (local.get $child)))
      (call $mark (i32.const 31))
      (i32.const 103))

    (func (export "promote") (result i32)
      (local $child i32)
      (call $mark (i32.const 4))
      (local.set $child (call $thread-new (i32.const 3) (i32.const 0)))
      ;; A newly-created (explicitly suspended) target is not ready.
      (drop (call $yield-then-promote (local.get $child)))
      (call $mark (i32.const 41))
      (call $resume-later (local.get $child))
      ;; Once ready, promotion runs the target before this caller continues.
      (drop (call $yield-then-promote (local.get $child)))
      (call $mark (i32.const 42))
      (i32.const 104))

    (func (export "cancel-valid") (result i32)
      (local $child i32) (local $cancelled i32)
      (local.set $child (call $thread-new (i32.const 4) (i32.const 0)))
      ;; The host requests this task's cancellation at this exact point.
      (call $mark (i32.const 6))
      (local.set $cancelled
        (call $suspend-then-resume-cancellable (local.get $child)))
      (if (i32.ne (local.get $cancelled) (i32.const 1)) (then unreachable))
      (call $mark (i32.const 61))
      (i32.const 105))

    (func (export "cancel-invalid-index")
      (call $mark (i32.const 6))
      (drop (call $suspend-then-resume-cancellable (i32.const -1))))
    (func (export "cancel-self")
      (call $mark (i32.const 6))
      (drop (call $suspend-then-resume-cancellable (call $thread-index))))
    (func (export "cancel-wrong-state")
      (local $child i32)
      (local.set $child (call $thread-new (i32.const 4) (i32.const 0)))
      (call $resume-later (local.get $child))
      (call $mark (i32.const 6))
      (drop (call $suspend-then-resume-cancellable (local.get $child))))

    ;; Callback EXIT lets the explicit child become the final thread. A trap
    ;; must remain the failure; a normal return must report no async result.
    (func (export "child-trap") (result i32)
      (call $resume-later (call $thread-new (i32.const 6) (i32.const 0)))
      (i32.const 0))
    (func (export "child-normal") (result i32)
      (call $resume-later (call $thread-new (i32.const 7) (i32.const 0)))
      (i32.const 0))
    (func (export "child-cancellable") (result i32)
      (call $resume-later (call $thread-new (i32.const 5) (i32.const 0)))
      (i32.const 0))
    (func (export "lock-holder") (result i32)
      (call $mark (i32.const 90))
      (call $holder-gate)
      (call $task-return (i32.const 109))
      (i32.const 0))

    (func (export "post-result") (result i32)
      (local $continues i32)
      (drop (call $thread-new (i32.const 9) (i32.const 0)))
      (local.set $continues (call $thread-new (i32.const 8) (i32.const 0)))
      (call $task-return (i32.const 108))
      (call $resume-later (local.get $continues))
      (i32.const 0))
    (func (export "unreachable-cb") (param i32 i32 i32) (result i32)
      unreachable))

  (core instance $core (instantiate $Core (with "" (instance
    (export "table" (table $table-export))
    (export "mark" (func $mark-lower))
    (export "child-gate" (func $child-gate-lower))
    (export "holder-gate" (func $holder-gate-lower))
    (export "thread-index" (func $thread-index))
    (export "thread-new" (func $thread-new))
    (export "resume-later" (func $resume-later))
    (export "suspend-cancellable" (func $suspend-cancellable))
    (export "suspend-then-resume" (func $suspend-then-resume))
    (export "suspend-then-resume-cancellable" (func $suspend-then-resume-cancellable))
    (export "yield-then-resume" (func $yield-then-resume))
    (export "yield-then-promote" (func $yield-then-promote))
    (export "task-return" (func $task-return))))))

  (func (export "resume-later") async (result u32)
    (canon lift (core func $core "resume-later")))
  (func (export "switch-back") async (result u32)
    (canon lift (core func $core "switch-back")))
  (func (export "yield-back") async (result u32)
    (canon lift (core func $core "yield-back")))
  (func (export "promote") async (result u32)
    (canon lift (core func $core "promote")))
  (func (export "cancel-valid") async (result u32)
    (canon lift (core func $core "cancel-valid")))
  (func (export "cancel-invalid-index") async
    (canon lift (core func $core "cancel-invalid-index")))
  (func (export "cancel-self") async
    (canon lift (core func $core "cancel-self")))
  (func (export "cancel-wrong-state") async
    (canon lift (core func $core "cancel-wrong-state")))
  (func (export "child-trap") async (result u32)
    (canon lift (core func $core "child-trap") async
      (callback (core func $core "unreachable-cb"))))
  (func (export "child-normal") async (result u32)
    (canon lift (core func $core "child-normal") async
      (callback (core func $core "unreachable-cb"))))
  (func (export "child-cancellable") async (result u32)
    (canon lift (core func $core "child-cancellable") async
      (callback (core func $core "unreachable-cb"))))
  (func (export "lock-holder") async (result u32)
    (canon lift (core func $core "lock-holder") async
      (callback (core func $core "unreachable-cb"))))
  (func (export "post-result") async (result u32)
    (canon lift (core func $core "post-result") async
      (callback (core func $core "unreachable-cb"))))
)
