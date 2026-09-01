;; (f) An *imported resource type*: the component imports `R` from a host
;; instance together with functions producing and borrowing it, then owns,
;; borrows and drops handles of a type it did not define.
;;
;; This is the shape the `importedResources` field
;; (contracts/plan-format.md schema) records:
;; `ResourceIndex = importedResources.len() + DefinedResourceIndex`, so the
;; plan must carry `importedResources` for the runtime to resolve resource
;; tables at all.
(component
  (import "host:api/res" (instance $api
    (export "R" (type $R (sub resource)))
    (export "make" (func (param "v" u32) (result (own $R))))
    (export "value" (func (param "r" (borrow $R)) (result u32)))))

  (alias export $api "R" (type $R))
  (alias export $api "make" (func $make))
  (alias export $api "value" (func $value))

  (canon lower (func $make) (core func $make'))
  (canon lower (func $value) (core func $value'))
  (canon resource.drop $R (core func $drop))

  (core module $M
    (import "" "make" (func $make (param i32) (result i32)))
    (import "" "value" (func $value (param i32) (result i32)))
    (import "" "drop" (func $drop (param i32)))

    ;; make -> borrow -> drop, returning the borrowed value.
    (func (export "roundtrip") (param $v i32) (result i32)
      (local $h i32) (local $out i32)
      (local.set $h (call $make (local.get $v)))
      (local.set $out (call $value (local.get $h)))
      (call $drop (local.get $h))
      (local.get $out))

    ;; Leaves the handle in the table (host-visible: no dtor call).
    (func (export "make-and-keep") (param $v i32) (result i32)
      (call $make (local.get $v)))

    (func (export "drop-handle") (param $h i32)
      (call $drop (local.get $h))))

  (core instance $i (instantiate $M (with "" (instance
    (export "make" (func $make'))
    (export "value" (func $value'))
    (export "drop" (func $drop))))))

  (func (export "roundtrip") (param "v" u32) (result u32)
    (canon lift (core func $i "roundtrip")))
  (func (export "make-and-keep") (param "v" u32) (result u32)
    (canon lift (core func $i "make-and-keep")))
  (func (export "drop-handle") (param "h" u32)
    (canon lift (core func $i "drop-handle"))))
