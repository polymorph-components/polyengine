;; (h) Cross-encoding string transfer: `$Utf16` calls `$Utf8`'s export with a
;; string, so FACT must synthesize a `Transcoder` trampoline
;; (`wasmtime_environ::component::Trampoline::Transcoder`) to move the bytes
;; between the two memories, converting utf16 -> utf8 on the way.
(component
  (component $Utf8
    (core module $M
      (memory (export "mem") 1)
      (func (export "realloc") (param i32 i32 i32 i32) (result i32)
        (i32.const 16))
      ;; Returns the byte length the string occupied in *this* component's
      ;; utf8 memory, which differs from the caller's utf16 code-unit count.
      (func (export "take") (param $ptr i32) (param $len i32) (result i32)
        (local.get $len)))
    (core instance $m (instantiate $M))
    (func (export "take") (param "s" string) (result u32)
      (canon lift (core func $m "take")
        (memory (core memory $m "mem"))
        (realloc (core func $m "realloc"))
        string-encoding=utf8)))

  (component $Utf16
    (import "take" (func $take (param "s" string) (result u32)))
    (core module $M
      (memory (export "mem") 1)
      (func (export "realloc") (param i32 i32 i32 i32) (result i32)
        (i32.const 16)))
    (core instance $m (instantiate $M))
    (core func $take' (canon lower (func $take)
      (memory (core memory $m "mem"))
      (realloc (core func $m "realloc"))
      string-encoding=utf16))
    (core module $D
      (import "" "take" (func $take (param i32 i32) (result i32)))
      (import "" "mem" (memory 1))
      ;; "h\u00e9" as utf16: two code units, but *three* bytes once encoded
      ;; as utf8 — so the returned length proves a conversion happened
      ;; rather than a straight copy.
      (func (export "run") (result i32)
        (i32.store8 (i32.const 0) (i32.const 104))   ;; 'h'
        (i32.store8 (i32.const 1) (i32.const 0))
        (i32.store8 (i32.const 2) (i32.const 0xe9))  ;; U+00E9
        (i32.store8 (i32.const 3) (i32.const 0))
        (call $take (i32.const 0) (i32.const 2))))
    (core instance $d (instantiate $D (with "" (instance
      (export "take" (func $take'))
      (export "mem" (memory $m "mem"))))))
    (func (export "run") (result u32) (canon lift (core func $d "run"))))

  (instance $u8 (instantiate $Utf8))
  (instance $u16 (instantiate $Utf16 (with "take" (func $u8 "take"))))
  (func (export "run") (alias export $u16 "run")))
