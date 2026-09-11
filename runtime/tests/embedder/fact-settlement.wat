;; A FACT sync callee can be poisoned while its caller's Task stays healthy.
;; Regenerate: wasm-tools parse fact-settlement.wat -o fact-settlement.wasm
(component
  (import "r" (type $R (sub resource)))
  (type $Result0 (result (own $R) (error (own $R))))
  (export $Result "make-result" (type $Result0))
  (import "make-sync" (func $sync (param "r" (borrow $R)) (result $Result)))
  (component $Use
    (import "r" (type $R (sub resource)))
    (import "make-sync" (func $sync (param "r" (borrow $R)) (result (result (own $R) (error (own $R))))))
    (core module $Mem (memory (export "mem") 1))
    (core instance $mem (instantiate $Mem))
    (canon lower (func $sync) (memory $mem "mem") (core func $sync-lower))
    (canon resource.drop $R (core func $drop-r))
    (core module $M
      (import "" "sync" (func $sync (param i32 i32)))
      (import "" "drop-r" (func $drop-r (param i32)))
      (func (export "sync") (param i32)
        (call $sync (local.get 0) (i32.const 0))
        (call $drop-r (local.get 0)))
      (func (export "trap") unreachable))
    (core instance $m (instantiate $M (with "" (instance
      (export "sync" (func $sync-lower))
      (export "drop-r" (func $drop-r))))))
    (func (export "run-sync") (param "r" (borrow $R)) (canon lift (core func $m "sync")))
    (func (export "trap") (canon lift (core func $m "trap"))))
  (instance $use (instantiate $Use (with "r" (type $R)) (with "make-sync" (func $sync))))
  ;; A real FACT sync caller keeps its own Task while parked in $Use.
  (component $Caller
    (import "r" (type $R (sub resource)))
    (import "run" (func $run (param "r" (borrow $R))))
    (canon lower (func $run) (core func $run-lower))
    (canon resource.drop $R (core func $drop))
    (core module $M
      (import "" "run" (func $run (param i32)))
      (import "" "drop" (func $drop (param i32)))
      (func (export "run") (param i32) (call $run (local.get 0)) (call $drop (local.get 0))))
    (core instance $m (instantiate $M (with "" (instance (export "run" (func $run-lower)) (export "drop" (func $drop))))))
    (func (export "run") (param "r" (borrow $R)) (canon lift (core func $m "run"))))
  (alias export $use "run-sync" (func $run-sync))
  (instance $caller (instantiate $Caller (with "r" (type $R)) (with "run" (func $run-sync))))
  (export "r" (type $R))
  (export "run-sync" (func $run-sync))
  (export "run-fact" (func $caller "run"))
  (export "trap" (func $use "trap")))
