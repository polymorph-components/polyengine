;; (c2) Async probe, cross-component: component $A exports an ASYNC-lifted
;; function (callback ABI, async function type). Component $B consumes it
;; twice:
;;   - `add3`: via a plain SYNC lower        => FACT sync-lower/async-lift fusion
;;   - `add2-async`: via an ASYNC lower      => FACT async-lower/async-lift fusion
;; Both cross a component-instance boundary, so FACT must generate fused
;; adapters covering the async ABI (prepare-call / sync-start-call /
;; async-start-call intrinsics).
(component
  (component $A
    (core module $MA
      (import "" "task.return" (func $task-return (param i32)))
      (func (export "add-impl") (param i32 i32) (result i32)
        (call $task-return (i32.add (local.get 0) (local.get 1)))
        (i32.const 0))
      (func (export "cb") (param i32 i32 i32) (result i32)
        (i32.const 0)))
    (core func $task-return (canon task.return (result u32)))
    (core instance $ia (instantiate $MA
      (with "" (instance (export "task.return" (func $task-return))))))
    (func (export "add") async (param "a" u32) (param "b" u32) (result u32)
      (canon lift (core func $ia "add-impl") async (callback (core func $ia "cb")))))

  (component $B
    (import "adder" (instance $adder
      (export "add" (func async (param "a" u32) (param "b" u32) (result u32)))))

    ;; sync lower of the async-lifted import
    (core func $add_sync (canon lower (func $adder "add")))

    ;; async lower needs a memory for the result buffer; use a helper module
    ;; instantiated first to avoid a circular dependency.
    (core module $MEM (memory (export "mem") 1))
    (core instance $imem (instantiate $MEM))
    (core func $add_async (canon lower (func $adder "add") async (memory (core memory $imem "mem"))))

    (core module $MB
      (import "adder" "add" (func $add (param i32 i32) (result i32)))
      (import "adder" "add-async" (func $add-async (param i32 i32 i32) (result i32)))
      (import "mem" "mem" (memory 1))
      (func (export "add3") (param i32 i32 i32) (result i32)
        (call $add (call $add (local.get 0) (local.get 1)) (local.get 2)))
      (func (export "add2-async") (param i32 i32) (result i32)
        ;; call async-lowered import with a retptr; ignore the status code and
        ;; read the result back (fine for translation purposes)
        (drop (call $add-async (local.get 0) (local.get 1) (i32.const 16)))
        (i32.load (i32.const 16))))
    (core instance $ib (instantiate $MB
      (with "adder" (instance
        (export "add" (func $add_sync))
        (export "add-async" (func $add_async))))
      (with "mem" (instance $imem))))
    (func (export "add3") (param "a" u32) (param "b" u32) (param "c" u32) (result u32)
      (canon lift (core func $ib "add3")))
    (func (export "add2-async") (param "a" u32) (param "b" u32) (result u32)
      (canon lift (core func $ib "add2-async"))))

  (instance $a (instantiate $A))
  (instance $b (instantiate $B (with "adder" (instance $a))))
  (export "add3" (func $b "add3"))
  (export "add2-async" (func $b "add2-async")))
