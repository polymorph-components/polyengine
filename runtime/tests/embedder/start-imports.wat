;; Host imports called from a core module's `start` function — i.e. DURING
;; instantiation, before `instantiateComponent`'s promise resolves.
;;
;; This is not a corner case: componentize-go's output calls
;; `wasi:clocks/monotonic-clock.now()` from the Go runtime's `schedinit`, which
;; runs in `start`. The conventions layer must therefore have working import
;; wrappers from the moment instantiation begins — it cannot wait to learn its
;; own function types from the returned handle.
;;
;; Two imports, deliberately different:
;;   * `tick: func() -> u64`     — flat, needs no memory;
;;   * `note: func(msg: string)` — needs the guest's memory AND realloc, so it
;;     exercises real value adaptation (string lowering) on the start path.
;; A third, `report: func() -> u64`, is exported so the test can read back what
;; `start` observed.
;;
;; Regenerate: wasm-tools parse start-imports.wat -o start-imports.wasm
(component
  (import "host:api/boot" (instance $api
    (export "tick" (func (result u64)))
    (export "note" (func (param "msg" string)))))

  (alias export $api "tick" (func $tick))
  (alias export $api "note" (func $note))

  (core module $Mem
    (memory (export "mem") 1)
    (global $next (mut i32) (i32.const 512))
    (func (export "realloc")
      (param $old i32) (param $oldSize i32) (param $align i32) (param $new i32)
      (result i32)
      (local $p i32)
      (local.set $p (global.get $next))
      (global.set $next (i32.add (global.get $next) (local.get $new)))
      (local.get $p))
    ;; "booted" at offset 0, 6 bytes — the string `note` receives.
    (data (i32.const 0) "booted"))

  (core instance $mem (instantiate $Mem))

  (canon lower (func $tick) (core func $tick'))
  (canon lower (func $note)
    (memory $mem "mem") (realloc (func $mem "realloc"))
    (core func $note'))

  (core module $M
    (import "mem" "mem" (memory 1))
    (import "" "tick" (func $tick (result i64)))
    (import "" "note" (func $note (param i32 i32)))
    (global $seen (mut i64) (i64.const 0))

    ;; Runs during instantiation.
    (func $start
      (global.set $seen (call $tick))
      (call $note (i32.const 0) (i32.const 6)))
    (start $start)

    (func (export "report") (result i64) (global.get $seen)))

  (core instance $i (instantiate $M
    (with "mem" (instance $mem))
    (with "" (instance
      (export "tick" (func $tick'))
      (export "note" (func $note'))))))

  (func (export "report") (result u64)
    (canon lift (core func $i "report"))))
