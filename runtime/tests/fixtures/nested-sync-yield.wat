;; A real translated cross-component call where an async-typed function has a
;; synchronous core implementation. Its thread.yield parks the physical caller
;; while the canonical callee task remains the logical context owner.
(component
  (component $A
    (core func $yield (canon thread.yield))
    (core module $M
      (import "" "yield" (func $yield (result i32)))
      (func (export "run") (param $fail i32) (result i32)
        (drop (call $yield))
        (if (local.get $fail) (then unreachable))
        (i32.const 42)))
    (core instance $m (instantiate $M (with "" (instance
      (export "yield" (func $yield))))))
    (func (export "run") async (param "fail" u32) (result u32)
      (canon lift (core func $m "run"))))

  (component $B
    (import "run" (func $run async (param "fail" u32) (result u32)))
    ;; A synchronous lower is the FACT async-typed/sync-ABI path under test.
    (core func $run' (canon lower (func $run)))
    (core module $M
      (import "" "run" (func $run (param i32) (result i32)))
      (func (export "run") (param i32) (result i32)
        (call $run (local.get 0))))
    (core instance $m (instantiate $M (with "" (instance
      (export "run" (func $run'))))))
    (func (export "run") async (param "fail" u32) (result u32)
      (canon lift (core func $m "run"))))

  (instance $a (instantiate $A))
  (instance $b (instantiate $B (with "run" (func $a "run"))))
  (export "run" (func $b "run")))
