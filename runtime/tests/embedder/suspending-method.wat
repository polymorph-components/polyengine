;; Host-implemented resource with a true `[method]`/`[static]` surface, for
;; the suspending mark scope extension (contracts/embedder-api.md §"Functions and async"):
;; a `suspending()`-marked resource METHOD is the shape the tier-(c) WASI
;; blocking profile hangs off (`[method]pollable.block`), and no corpus or
;; testdata component imports one — host-borrow/imported-resource use plain
;; functions taking borrows.
;;
;; `gauge` is the smallest host resource with all three member forms:
;;   [constructor]gauge        (always synchronous — never marked)
;;   [method]gauge.read        (self borrow -> u32; the parking candidate)
;;   [static]gauge.calibrate   (() -> u32; the static parking candidate)
;;
;; `probe(v)` constructs, reads, drops, and returns the reading; `calib()`
;; calls the static. Flat u32s throughout: no memory, no realloc.
;;
;; Regenerate: wasm-tools parse suspending-method.wat -o suspending-method.wasm
(component
  (import "host:api/dev" (instance $api
    (export "gauge" (type $G (sub resource)))
    (export "[constructor]gauge" (func (param "v" u32) (result (own $G))))
    (export "[method]gauge.read" (func (param "self" (borrow $G)) (result u32)))
    (export "[static]gauge.calibrate" (func (result u32)))))

  (alias export $api "gauge" (type $G))
  (alias export $api "[constructor]gauge" (func $ctor))
  (alias export $api "[method]gauge.read" (func $read))
  (alias export $api "[static]gauge.calibrate" (func $calibrate))

  (canon lower (func $ctor) (core func $ctor'))
  (canon lower (func $read) (core func $read'))
  (canon lower (func $calibrate) (core func $calibrate'))
  (canon resource.drop $G (core func $drop))

  (core module $M
    (import "" "ctor" (func $ctor (param i32) (result i32)))
    (import "" "read" (func $read (param i32) (result i32)))
    (import "" "calibrate" (func $calibrate (result i32)))
    (import "" "drop" (func $drop (param i32)))
    (func (export "probe") (param $v i32) (result i32)
      (local $h i32)
      (local $out i32)
      (local.set $h (call $ctor (local.get $v)))
      (local.set $out (call $read (local.get $h)))
      (call $drop (local.get $h))
      (local.get $out))
    (func (export "calib") (result i32)
      (call $calibrate)))

  (core instance $i (instantiate $M (with "" (instance
    (export "ctor" (func $ctor'))
    (export "read" (func $read'))
    (export "calibrate" (func $calibrate'))
    (export "drop" (func $drop))))))

  (func (export "probe") (param "v" u32) (result u32)
    (canon lift (core func $i "probe")))
  (func (export "calib") (result u32)
    (canon lift (core func $i "calib"))))
