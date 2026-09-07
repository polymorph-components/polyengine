;; The long-poll shape: an async-typed export that parks on something only a
;; LATER export call can ready (issue #292).
;;
;; `next` is an async callback-ABI export whose body starts an intra-component
;; `future.read` (BLOCKED), joins the readable end to a waitable set and
;; returns WAIT. Nothing host-side is outstanding at that point, so the export
;; driver runs out of moves — which used to trap as "deadlock detected". It is
;; not one: definitions.py `canon_lift` runs its trapping driving loop only
;; `if not ft.async_` (line 2189), so an async-typed export's Promise is
;; simply left pending for a later driver. `push(v)` writes the future, which
;; completes the read, runs `next-cb` and resolves `next`'s Promise with `v`.
;;
;; `push-bad(v)` is the poisoning variant: it sets a flag and writes, so the
;; callback that `next` is parked in traps. That must REJECT the pending
;; `next()` Promise (with the trap) rather than leave it hanging — the same
;; guarantee #66 gave parked stream/future ends.
;;
;; Regenerate: wasm-tools parse long-poll.wat -o long-poll.wasm
(component
  (core module $Memory (memory (export "mem") 1))
  (core instance $memory (instantiate $Memory))
  (core module $M
    (import "" "mem" (memory 1))
    (import "" "waitable.join" (func $waitable.join (param i32 i32)))
    (import "" "waitable-set.new" (func $waitable-set.new (result i32)))
    (import "" "future.new" (func $future.new (result i64)))
    (import "" "future.read" (func $future.read (param i32 i32) (result i32)))
    (import "" "future.write" (func $future.write (param i32 i32) (result i32)))
    (import "" "task.return-next" (func $task.return-next (param i32)))
    (import "" "task.return-push" (func $task.return-push))
    (global $rx (mut i32) (i32.const 0))
    (global $tx (mut i32) (i32.const 0))
    (global $ws (mut i32) (i32.const 0))
    (global $bad (mut i32) (i32.const 0))

    (func (export "next") (result i32)
      (local $ret64 i64) (local $ret i32)
      (local.set $ret64 (call $future.new))
      (global.set $rx (i32.wrap_i64 (local.get $ret64)))
      (global.set $tx (i32.wrap_i64 (i64.shr_u (local.get $ret64) (i64.const 32))))
      (local.set $ret (call $future.read (global.get $rx) (i32.const 8)))
      (if (i32.ne (local.get $ret) (i32.const -1 (; BLOCKED ;))) (then unreachable))
      (global.set $ws (call $waitable-set.new))
      (call $waitable.join (global.get $rx) (global.get $ws))
      (i32.or (i32.const 2 (; WAIT ;)) (i32.shl (global.get $ws) (i32.const 4)))
    )
    (func (export "next-cb") (param $code i32) (param $index i32) (param $payload i32) (result i32)
      (if (i32.ne (local.get $code) (i32.const 4 (; FUTURE_READ ;))) (then unreachable))
      (if (i32.ne (local.get $payload) (i32.const 0 (; COMPLETED ;))) (then unreachable))
      ;; The poisoning arm: `push-bad` armed this, so the guest faults while
      ;; completing `next`.
      (if (global.get $bad) (then unreachable))
      (call $task.return-next (i32.load8_u (i32.const 8)))
      (i32.const 0 (; EXIT ;))
    )
    (func $do-push (param $v i32)
      (i32.store8 (i32.const 16) (local.get $v))
      (if (i32.ne (call $future.write (global.get $tx) (i32.const 16)) (i32.const 0 (; COMPLETED ;)))
        (then unreachable))
      (call $task.return-push)
    )
    (func (export "push") (param $v i32) (result i32)
      (call $do-push (local.get $v))
      (i32.const 0 (; EXIT ;))
    )
    (func (export "push-bad") (param $v i32) (result i32)
      (global.set $bad (i32.const 1))
      (call $do-push (local.get $v))
      (i32.const 0 (; EXIT ;))
    )
    (func (export "push-cb") (param i32 i32 i32) (result i32) unreachable)
  )
  (type $FT (future u8))
  (canon waitable.join (core func $waitable.join))
  (canon waitable-set.new (core func $waitable-set.new))
  (canon future.new $FT (core func $future.new))
  (canon future.read $FT async (memory (core memory $memory "mem")) (core func $future.read))
  (canon future.write $FT async (memory (core memory $memory "mem")) (core func $future.write))
  (canon task.return (result u32) (memory (core memory $memory "mem")) (core func $task.return-next))
  (canon task.return (memory (core memory $memory "mem")) (core func $task.return-push))
  (core instance $m (instantiate $M (with "" (instance
    (export "mem" (memory $memory "mem"))
    (export "waitable.join" (func $waitable.join))
    (export "waitable-set.new" (func $waitable-set.new))
    (export "future.new" (func $future.new))
    (export "future.read" (func $future.read))
    (export "future.write" (func $future.write))
    (export "task.return-next" (func $task.return-next))
    (export "task.return-push" (func $task.return-push))
  ))))
  (func (export "next") async (result u32)
    (canon lift (core func $m "next") async (memory (core memory $memory "mem")) (callback (core func $m "next-cb"))))
  (func (export "push") async (param "v" u32)
    (canon lift (core func $m "push") async (memory (core memory $memory "mem")) (callback (core func $m "push-cb"))))
  (func (export "push-bad") async (param "v" u32)
    (canon lift (core func $m "push-bad") async (memory (core memory $memory "mem")) (callback (core func $m "push-cb"))))
)
