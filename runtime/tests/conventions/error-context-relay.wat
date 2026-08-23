;; ROW (g) fixture — an `error-context` crossing the host boundary in BOTH
;; directions (contracts/embedder-api.md §"Realm boundaries and
;; structured-clone-safe forms", amendment A20: "Error-context is
;; message-valued").
;;
;; Nothing in the corpus puts an `error-context` in a function signature: the
;; existing `error-context.wasm` testdata component only mints and drops one
;; internally, which exercises the plan's table sections but never the lift or
;; the lower. This is the smallest component that does both.
;;
;;   host:api/ec.relay: func(c: error-context) -> error-context
;;
;; `probe` mints a context whose debug message is "guest-ctx", passes it to the
;; host (the LIFT: the host must receive something `isErrorContext` recognizes,
;; carrying that message), and reads the debug message of whatever comes back
;; (the LOWER: A20 accepts any branded string-`message` carrier by minting a
;; FRESH local context). It returns that message's byte length, so one u32
;; reports that the host's message survived the crossing.
;;
;; Regenerate:
;;   wasm-tools parse runtime/tests/conventions/error-context-relay.wat \
;;     -o runtime/tests/conventions/error-context-relay.wasm
(component
  (core module $Mem
    (memory (export "mem") 1)
    ;; The guest's own debug message, at offset 0, 9 bytes.
    (data (i32.const 0) "guest-ctx")
    (global $next (mut i32) (i32.const 512))
    ;; Bump allocator: `error-context.debug-message` lifts a string through it.
    (func (export "realloc")
      (param $old i32) (param $oldSize i32) (param $align i32) (param $new i32)
      (result i32)
      (local $p i32)
      (local.set $p (global.get $next))
      (global.set $next (i32.add (global.get $next) (local.get $new)))
      (local.get $p)))
  (core instance $mem (instantiate $Mem))

  (import "host:api/ec" (instance $api
    (export "relay" (func (param "c" error-context) (result error-context)))))
  (alias export $api "relay" (func $relay))
  (canon lower (func $relay) (core func $relay'))

  (core func $ec-new (canon error-context.new (memory $mem "mem")))
  (core func $ec-msg (canon error-context.debug-message
    (memory $mem "mem") (realloc (func $mem "realloc"))))
  (core func $ec-drop (canon error-context.drop))

  (core module $M
    (import "mem" "mem" (memory 1))
    (import "" "relay" (func $relay (param i32) (result i32)))
    (import "" "ec-new" (func $ec-new (param i32 i32) (result i32)))
    (import "" "ec-msg" (func $ec-msg (param i32 i32)))
    (import "" "ec-drop" (func $ec-drop (param i32)))
    (func (export "probe") (result i32)
      (local $out i32)
      ;; mint "guest-ctx" -> hand it to the host -> take the host's context
      (local.set $out
        (call $relay (call $ec-new (i32.const 0) (i32.const 9))))
      ;; `debug-message` writes (ptr, len) at the retptr.
      (call $ec-msg (local.get $out) (i32.const 256))
      (call $ec-drop (local.get $out))
      (i32.load (i32.const 260))))

  (core instance $i (instantiate $M
    (with "mem" (instance $mem))
    (with "" (instance
      (export "relay" (func $relay'))
      (export "ec-new" (func $ec-new))
      (export "ec-msg" (func $ec-msg))
      (export "ec-drop" (func $ec-drop))))))

  (func (export "probe") (result u32)
    (canon lift (core func $i "probe"))))
