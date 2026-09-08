;; Host stream ownership and future round trips through real canonical edges.
;; Regenerate: wasm-tools parse stream-host.wat -o stream-host.wasm
(component
  (import "host:streams/api" (instance $api
    (export "ticket" (type $ticket (sub resource)))))
  (alias export $api "ticket" (type $ticket))
  (type $tickets (stream (own $ticket)))
  (type $future (future u32))

  (core module $memory (memory (export "memory") 1))
  (core instance $mem (instantiate $memory))
  (canon stream.read $tickets (memory $mem "memory") async (core func $read))
  (canon stream.drop-readable $tickets (core func $drop-stream))
  (canon resource.drop $ticket (core func $drop-ticket))
  (core module $M
    (import "" "memory" (memory 1))
    (import "" "read" (func $read (param i32 i32 i32) (result i32)))
    (import "" "drop-stream" (func $drop-stream (param i32)))
    (import "" "drop-ticket" (func $drop-ticket (param i32)))
    (func (export "pass") (param i32) (result i32) local.get 0)
    (func (export "take") (param $s i32) (param $trap i32)
      (if (i32.ne (call $read (local.get $s) (i32.const 0) (i32.const 1)) (i32.const 16))
        (then unreachable))
      (call $drop-ticket (i32.load (i32.const 0)))
      (if (local.get $trap) (then unreachable))
      (call $drop-stream (local.get $s))))
  (core instance $i (instantiate $M (with "" (instance
    (export "memory" (memory $mem "memory"))
    (export "read" (func $read))
    (export "drop-stream" (func $drop-stream))
    (export "drop-ticket" (func $drop-ticket))))))
  (func (export "pass-future") (param "f" $future) (result $future)
    (canon lift (core func $i "pass")))
  (func (export "pass-tickets") (param "s" $tickets) (result $tickets)
    (canon lift (core func $i "pass")))
  (func (export "take-ticket") (param "s" $tickets) (param "trap" bool)
    (canon lift (core func $i "take"))))
