;; (e) Component *imports*, live: a direct function import plus an imported
;; instance whose members are reached through `plan.imports[].path`
;; (`imports[].path`, contracts/plan-format.md schema). Also exercises a lowered
;; import with a non-trivial descriptor-IR signature (string -> string), which
;; drives realloc on the guest side.
(component
  (import "log" (func $log (param "x" u32)))
  (import "host:api/math" (instance $math
    (export "add" (func (param "a" u32) (param "b" u32) (result u32)))
    (export "greet" (func (param "who" string) (result string)))))

  (alias export $math "add" (func $add))
  (alias export $math "greet" (func $greet))

  (core module $Mem
    (memory (export "mem") 1)
    (global $next (mut i32) (i32.const 8))
    ;; Bump allocator with the canonical realloc signature.
    (func (export "realloc") (param $old i32) (param $oldsz i32)
                             (param $align i32) (param $newsz i32) (result i32)
      (local $ret i32)
      ;; align up
      (global.set $next
        (i32.and (i32.add (global.get $next) (i32.sub (local.get $align) (i32.const 1)))
                 (i32.xor (i32.sub (local.get $align) (i32.const 1)) (i32.const -1))))
      (local.set $ret (global.get $next))
      (global.set $next (i32.add (global.get $next) (local.get $newsz)))
      (local.get $ret)))
  (core instance $mem (instantiate $Mem))

  (canon lower (func $log) (core func $log'))
  (canon lower (func $add) (core func $add'))
  (canon lower (func $greet)
    (memory $mem "mem") (realloc (func $mem "realloc"))
    (core func $greet'))

  (core module $M
    (import "" "log" (func $log (param i32)))
    (import "" "add" (func $add (param i32 i32) (result i32)))
    ;; string -> string lowers to (ptr, len, retptr) -> ()
    (import "" "greet" (func $greet (param i32 i32 i32)))
    (import "" "mem" (memory 1))

    (func (export "run") (param i32 i32) (result i32)
      (local $s i32)
      (local.set $s (call $add (local.get 0) (local.get 1)))
      (call $log (local.get $s))
      (local.get $s))

    ;; Calls the imported `greet` with a fixed name and returns the length of
    ;; the string the host produced (proving the result was lowered into our
    ;; memory through realloc).
    (func (export "greet-len") (result i32)
      (i32.store8 (i32.const 0) (i32.const 97))  ;; 'a'
      (i32.store8 (i32.const 1) (i32.const 98))  ;; 'b'
      (call $greet (i32.const 0) (i32.const 2) (i32.const 4))
      (i32.load (i32.const 8))))

  (core instance $i (instantiate $M (with "" (instance
    (export "log" (func $log'))
    (export "add" (func $add'))
    (export "greet" (func $greet'))
    (export "mem" (memory $mem "mem"))))))

  (func (export "run") (param "a" u32) (param "b" u32) (result u32)
    (canon lift (core func $i "run")))
  (func (export "greet-len") (result u32)
    (canon lift (core func $i "greet-len"))))
