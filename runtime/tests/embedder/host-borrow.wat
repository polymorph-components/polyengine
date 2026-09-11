;; Host-passes-borrow fixture for the embedder conventions layer
;; (contracts/embedder-api.md §"Resources", 2x4 table, bottom-right cell:
;; every host-originated borrow gets a fresh rep for the call's duration).
;;
;; No corpus component takes a `borrow<R>` of an *imported* (host-implemented)
;; resource as an export parameter, which is the only position from which the
;; host passes a borrow. This is the smallest one that does: `peek` receives a
;; borrow and hands it straight back to the imported `value`.
;;
;; Regenerate: wasm-tools parse host-borrow.wat -o host-borrow.wasm
(component
  (import "host:api/res" (instance $api
    (export "R" (type $R (sub resource)))
    (export "value" (func (param "r" (borrow $R)) (result u32)))))

  (alias export $api "R" (type $R))
  (alias export $api "value" (func $value))
  (canon lower (func $value) (core func $value'))
  ;; A borrow handle must be dropped before the task returns
  ;; (definitions.py `Task.return_`: trap on `num_borrows != 0`).
  (canon resource.drop $R (core func $drop))

  (core module $M
    (import "" "value" (func $value (param i32) (result i32)))
    (import "" "drop" (func $drop (param i32)))
    (func (export "peek") (param $h i32) (result i32)
      (local $out i32)
      (local.set $out (call $value (local.get $h)))
      (call $drop (local.get $h))
      (local.get $out)))

  (core instance $i (instantiate $M (with "" (instance
    (export "value" (func $value'))
    (export "drop" (func $drop))))))

  (func (export "peek") (param "r" (borrow $R)) (result u32)
    (canon lift (core func $i "peek"))))
