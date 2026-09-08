;; Regenerate: wasm-tools parse runtime/tests/resource_identity.wat -o runtime/tests/resource_identity.wasm
;; The parent supplies one origin; the child's subtype-bound imports remain distinct.
(component
  (component $child
    (import "a" (type $a (sub resource)))
    (import "alias-a" (type $alias-a (eq $a)))
    (import "b" (type $b (sub resource)))
    (core func $drop-a (canon resource.drop $alias-a))
    (core func $drop-b (canon resource.drop $b))
    (core module $m
      (import "h" "drop-a" (func $drop-a (param i32)))
      (import "h" "drop-b" (func $drop-b (param i32)))
      (func (export "same") (param i32) (call $drop-a (local.get 0)))
      (func (export "different") (param i32) (call $drop-b (local.get 0))))
    (core instance $m (instantiate $m (with "h" (instance
      (export "drop-a" (func $drop-a)) (export "drop-b" (func $drop-b))))))
    (func (export "same") (param "value" (own $a))
      (canon lift (core func $m "same")))
    (func (export "different") (param "value" (own $a))
      (canon lift (core func $m "different"))))
  (core module $state
    (global $drops (mut i32) (i32.const 0))
    (func (export "dtor") (param i32)
      (global.set $drops (i32.add (global.get $drops) (i32.const 1))))
    (func (export "count") (result i32) (global.get $drops)))
  (core instance $state (instantiate $state))
  (type $r (resource (rep i32) (dtor (func $state "dtor"))))
  (instance $child (instantiate $child (with "a" (type $r)) (with "alias-a" (type $r)) (with "b" (type $r))))
  (core func $same (canon lower (func $child "same")))
  (core func $different (canon lower (func $child "different")))
  (core func $new (canon resource.new $r))
  (core module $main
    (import "h" "new" (func $new (param i32) (result i32)))
    (import "h" "same" (func $same (param i32)))
    (import "h" "different" (func $different (param i32)))
    (func (export "same") (call $same (call $new (i32.const 7))))
    (func (export "different") (call $different (call $new (i32.const 7)))))
  (core instance $main (instantiate $main (with "h" (instance
    (export "new" (func $new)) (export "same" (func $same))
    (export "different" (func $different))))))
  (func (export "same") (canon lift (core func $main "same")))
  (func (export "different") (canon lift (core func $main "different")))
  (func (export "count") (result u32) (canon lift (core func $state "count")))
)
