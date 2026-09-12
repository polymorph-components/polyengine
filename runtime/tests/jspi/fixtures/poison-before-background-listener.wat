;; Regression for #294: E's callback traps during a JSPI entry hop. Overlapping
;; export F waits for that hop and services the failing settlement. E's driver
;; then exits idle after poison was recorded but before its background-completion
;; listener is installed.
(component
  (import "gate" (func $gate async))
  (import "hop" (func $hop))
  (import "callback-entered" (func $callback-entered))
  (import "f-entered" (func $f-entered))

  (canon waitable.join (core func $waitable.join))
  (canon waitable-set.new (core func $waitable-set.new))
  (canon lower (func $gate) async (core func $gate.async))
  (canon task.return (result u32) (core func $task.return-f))
  (canon lower (func $hop) (core func $hop.sync))
  (canon lower (func $callback-entered) (core func $callback-entered.sync))
  (canon lower (func $f-entered) (core func $f-entered.sync))

  (core module $M
    (import "" "waitable.join" (func $waitable.join (param i32 i32)))
    (import "" "waitable-set.new" (func $waitable-set.new (result i32)))
    (import "" "gate" (func $gate (result i32)))
    (import "" "task.return-f" (func $task.return-f (param i32)))
    (import "" "hop" (func $hop))
    (import "" "callback-entered" (func $callback-entered))
    (import "" "f-entered" (func $f-entered))

    (global $ws (mut i32) (i32.const 0))

    (func (export "e") (result i32)
      (local $status i32) (local $sub i32)
      (local.set $status (call $gate))
      (if (i32.ne (i32.and (local.get $status) (i32.const 15)) (i32.const 1))
        (then unreachable))
      (local.set $sub (i32.shr_u (local.get $status) (i32.const 4)))
      (global.set $ws (call $waitable-set.new))
      (call $waitable.join (local.get $sub) (global.get $ws))
      (i32.or (i32.const 2) (i32.shl (global.get $ws) (i32.const 4))))

    (func (export "e-cb") (param i32 i32 i32) (result i32)
      (call $callback-entered)
      ;; A suspending()-marked sync import creates a promising-entry hop.
      (call $hop)
      unreachable)

    (func (export "f") (result i32)
      (call $f-entered)
      (call $task.return-f (i32.const 77))
      (i32.const 0))

    (func (export "unused-cb") (param i32 i32 i32) (result i32) unreachable))

  (core instance $m (instantiate $M (with "" (instance
    (export "waitable.join" (func $waitable.join))
    (export "waitable-set.new" (func $waitable-set.new))
    (export "gate" (func $gate.async))
    (export "task.return-f" (func $task.return-f))
    (export "hop" (func $hop.sync))
    (export "callback-entered" (func $callback-entered.sync))
    (export "f-entered" (func $f-entered.sync))))))

  (func (export "e") async (result u32)
    (canon lift (core func $m "e") async
      (callback (core func $m "e-cb"))))
  (func (export "f") async (result u32)
    (canon lift (core func $m "f") async
      (callback (core func $m "unused-cb"))))
)
