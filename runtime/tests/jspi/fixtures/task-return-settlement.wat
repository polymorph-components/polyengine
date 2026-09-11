;; An async export publishes its result, then remains in the same activation
;; while waitable-set.wait JSPI-suspends on a pending async host import.
(component
  (import "before-gate" (func $before-gate async))
  (import "gate" (func $gate async))
  (import "hop" (func $hop))
  (import "continued" (func $continued))
  (import "probe-entered" (func $probe-entered))

  (core module $Mem (memory (export "mem") 1))
  (core instance $mem (instantiate $Mem))

  (canon task.return (result u32) (core func $task.return))
  (canon lower (func $before-gate) async (core func $before-gate.async))
  (canon lower (func $gate) async (core func $gate.async))
  (canon lower (func $hop) (core func $hop.sync))
  (canon lower (func $continued) (core func $continued.sync))
  (canon lower (func $probe-entered) (core func $probe-entered.sync))
  (canon waitable-set.new (core func $ws.new))
  (canon waitable.join (core func $w.join))
  (canon waitable-set.wait (memory (core memory $mem "mem"))
    (core func $ws.wait))
  (canon subtask.drop (core func $subtask.drop))

  (core module $Core
    (import "" "mem" (memory 1))
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "before-gate" (func $before-gate (result i32)))
    (import "" "gate" (func $gate (result i32)))
    (import "" "hop" (func $hop))
    (import "" "continued" (func $continued))
    (import "" "probe-entered" (func $probe-entered))
    (import "" "waitable-set.new" (func $ws.new (result i32)))
    (import "" "waitable.join" (func $w.join (param i32 i32)))
    (import "" "waitable-set.wait"
      (func $ws.wait (param i32 i32) (result i32)))
    (import "" "subtask.drop" (func $subtask.drop (param i32)))

    (func (export "run") (result i32)
      (local $started i32) (local $sub i32) (local $ws i32)
      ;; First suspend before the result exists. Reaching task.return after
      ;; this resumption exercises settlement beyond the initial activation.
      (local.set $started (call $before-gate))
      (if (i32.ne
            (i32.and (local.get $started) (i32.const 15))
            (i32.const 1))
        (then unreachable))
      (local.set $sub (i32.shr_u (local.get $started) (i32.const 4)))
      (local.set $ws (call $ws.new))
      (call $w.join (local.get $sub) (local.get $ws))
      (drop (call $ws.wait (local.get $ws) (i32.const 0)))
      (call $subtask.drop (local.get $sub))

      (call $task.return (i32.const 42))
      ;; A nonblocking Suspending import adds an engine entry hop between
      ;; task.return and the genuine second suspension.
      (call $hop)
      (local.set $started (call $gate))
      (if (i32.ne
            (i32.and (local.get $started) (i32.const 15))
            (i32.const 1))
        (then unreachable))
      (local.set $sub (i32.shr_u (local.get $started) (i32.const 4)))
      (local.set $ws (call $ws.new))
      (call $w.join (local.get $sub) (local.get $ws))
      (if (i32.ne
            (call $ws.wait (local.get $ws) (i32.const 0))
            (i32.const 1))
        (then unreachable))
      (if (i32.ne (i32.load (i32.const 0)) (local.get $sub))
        (then unreachable))
      (if (i32.ne (i32.load (i32.const 4)) (i32.const 2))
        (then unreachable))
      (call $subtask.drop (local.get $sub))
      (call $continued)
      ;; The result is already delivered. This later producer failure must be
      ;; recorded for subsequent entry, not turn into an unhandled rejection.
      unreachable)

    (func (export "run-cb") (param i32 i32 i32) (result i32)
      unreachable)

    (func (export "probe") (result i32)
      (call $probe-entered)
      (i32.const 7)))

  (core instance $core (instantiate $Core (with "" (instance
    (export "mem" (memory $mem "mem"))
    (export "task.return" (func $task.return))
    (export "before-gate" (func $before-gate.async))
    (export "gate" (func $gate.async))
    (export "hop" (func $hop.sync))
    (export "continued" (func $continued.sync))
    (export "probe-entered" (func $probe-entered.sync))
    (export "waitable-set.new" (func $ws.new))
    (export "waitable.join" (func $w.join))
    (export "waitable-set.wait" (func $ws.wait))
    (export "subtask.drop" (func $subtask.drop))))))

  (func (export "run") async (result u32)
    (canon lift (core func $core "run") async
      (callback (core func $core "run-cb"))))
  (func (export "probe") (result u32)
    (canon lift (core func $core "probe")))
)
