;; A pending caller cancellation must not cancel the synchronous wait used to
;; admit an async-typed/sync-ABI callee under backpressure.
(component
  (component $A
    (core func $inc (canon backpressure.inc))
    (core func $dec (canon backpressure.dec))
    (core func $yield (canon thread.yield))
    (core module $M
      (import "" "inc" (func $inc))
      (import "" "dec" (func $dec))
      (import "" "yield" (func $yield (result i32)))
      (func (export "inc") (call $inc))
      (func (export "dec") (call $dec))
      (func (export "run") (param $fail i32) (result i32)
        (drop (call $yield))
        (if (local.get $fail) (then unreachable))
        (i32.const 7)))
    (core instance $m (instantiate $M (with "" (instance
      (export "inc" (func $inc))
      (export "dec" (func $dec))
      (export "yield" (func $yield))))))
    (func (export "inc") (canon lift (core func $m "inc")))
    (func (export "dec") (canon lift (core func $m "dec")))
    (func (export "run") async (param "fail" u32) (result u32)
      (canon lift (core func $m "run"))))

  (component $B
    (import "run" (func $run async (param "fail" u32) (result u32)))
    (core func $run' (canon lower (func $run)))
    (core module $Mem (memory (export "mem") 1))
    (core instance $mem (instantiate $Mem))
    (core func $return (canon task.return (result u32)
      (memory (core memory $mem "mem"))))
    (core module $M
      (import "" "run" (func $run (param i32) (result i32)))
      (import "" "return" (func $return (param i32)))
      (func (export "run") (param $fail i32) (result i32)
        (call $return (call $run (local.get $fail)))
        (i32.const 0))
      (func (export "callback") (param i32 i32 i32) (result i32)
        unreachable))
    (core instance $m (instantiate $M (with "" (instance
      (export "run" (func $run'))
      (export "return" (func $return))))))
    (func (export "run") async (param "fail" u32) (result u32)
      (canon lift (core func $m "run") async
        (memory (core memory $mem "mem"))
        (callback (core func $m "callback")))))

  (component $C
    (import "run" (func $run async (param "fail" u32) (result u32)))
    (core module $Mem (memory (export "mem") 1))
    (core instance $mem (instantiate $Mem))
    (core func $run' (canon lower (func $run) async
      (memory (core memory $mem "mem"))))
    (core func $cancel (canon subtask.cancel))
    (core func $return (canon task.return (result u32)
      (memory (core memory $mem "mem"))))
    (core module $M
      (import "" "mem" (memory 1))
      (import "" "run" (func $run (param i32 i32) (result i32)))
      (import "" "cancel" (func $cancel (param i32) (result i32)))
      (import "" "return" (func $return (param i32)))
      (func (export "run") (result i32)
        (local $packed i32)
        (i32.store (i32.const 0) (i32.const 0))
        (local.set $packed (call $run (i32.const 0) (i32.const 0)))
        (drop (call $cancel (i32.shr_u (local.get $packed) (i32.const 4))))
        (call $return (i32.load (i32.const 0)))
        (i32.const 0))
      (func (export "callback") (param i32 i32 i32) (result i32)
        unreachable))
    (core instance $m (instantiate $M (with "" (instance
      (export "mem" (memory $mem "mem"))
      (export "run" (func $run'))
      (export "cancel" (func $cancel))
      (export "return" (func $return))))))
    (func (export "run") async (result u32)
      (canon lift (core func $m "run") async
        (memory (core memory $mem "mem"))
        (callback (core func $m "callback")))))

  (instance $a (instantiate $A))
  (instance $b (instantiate $B (with "run" (func $a "run"))))
  (instance $c (instantiate $C (with "run" (func $b "run"))))
  (export "set-pressure" (func $a "inc"))
  (export "clear-pressure" (func $a "dec"))
  (export "run" (func $b "run"))
  (export "run-cancel" (func $c "run")))
