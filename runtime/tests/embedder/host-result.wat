;; Host-import error-model fixture for the embedder conventions layer
;; (contracts/embedder-api.md §"Error model").
;;
;; The corpus has no component that imports a *fallible* host function, so the
;; branded-throw round trip — `throw new ComponentException(payload)` becoming the guest's
;; `err` case, and an unbranded throw becoming a trap — has nothing to run
;; against. This is the smallest component that does.
;;
;; `result` with both sides empty is deliberate: its flat lowering is a single
;; i32 discriminant, so the fixture needs neither memory nor realloc and the
;; guest can simply hand the discriminant back. `run() == 0` means the guest
;; observed `ok`, `1` means it observed `err`.
;;
;; Regenerate: wasm-tools parse host-result.wat -o host-result.wasm
(component
  (import "host:api/fallible" (instance $api
    (export "check" (func (result (result))))))

  (alias export $api "check" (func $check))
  (canon lower (func $check) (core func $check'))

  (core module $M
    (import "" "check" (func $check (result i32)))
    (func (export "run") (result i32) (call $check)))

  (core instance $i (instantiate $M (with "" (instance
    (export "check" (func $check'))))))

  (func (export "run") (result u32)
    (canon lift (core func $i "run"))))
