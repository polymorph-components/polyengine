;; Cross-store refusal during a core start import, before component
;; instantiation returns to the host.
;; Regenerate: wasm-tools parse start-future-import.wat -o start-future-import.wasm
(component
  (import "host:api/boot" (instance $api
    (type $F (future u32))
    (export "future" (func (result $F)))))
  (alias export $api "future" (func $future))
  (core module $Mem (memory (export "mem") 1))
  (core instance $mem (instantiate $Mem))
  (canon lower (func $future) (memory $mem "mem") (core func $future-lower))
  (core module $M
    (import "" "future" (func $future (result i32)))
    (func $start (drop (call $future)))
    (start $start))
  (core instance $m (instantiate $M
    (with "" (instance (export "future" (func $future-lower)))))))
