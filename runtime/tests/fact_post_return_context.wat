(component
  (component $callee
    (canon task.return (core func $task-return))
    (canon context.get i32 0 (core func $context-get))
    (canon context.set i32 0 (core func $context-set))
    (core module $m
      (import "" "task-return" (func $task-return))
      (import "" "context-get" (func $context-get (result i32)))
      (import "" "context-set" (func $context-set (param i32)))
      (global $seen (mut i32) (i32.const -1))
      (func (export "f") (result i32)
        (i32.const 0))
      (func (export "g") (result i32)
        (call $context-set (i32.const 42))
        (i32.const 1))
      ;; The zero result passed by post-return takes the invalid path. The same
      ;; core function remains callable normally with a nonzero argument.
      (func (export "post") (param i32)
        (if (i32.eqz (local.get 0))
          (then (call $task-return))
          (else
            (global.set $seen (call $context-get))
            (call $context-set (i32.const 99)))))
      (func (export "seen") (result i32) (global.get $seen)))
    (core instance $m (instantiate $m (with "" (instance
      (export "task-return" (func $task-return))
      (export "context-get" (func $context-get))
      (export "context-set" (func $context-set))))))
    (func (export "f") (result u32) (canon lift
      (core func $m "f")
      (post-return (core func $m "post"))))
    (func (export "g") (result u32) (canon lift
      (core func $m "g")
      (post-return (core func $m "post"))))
    (func (export "post") (param "value" u32) (canon lift
      (core func $m "post")))
    (func (export "seen") (result u32) (canon lift (core func $m "seen"))))

  (component $caller
    (import "f" (func $f (result u32)))
    (import "g" (func $g (result u32)))
    (canon context.get i32 0 (core func $context-get))
    (canon context.set i32 0 (core func $context-set))
    (canon lower (func $f) (core func $f-core))
    (canon lower (func $g) (core func $g-core))
    (core module $m
      (import "" "f" (func $f (result i32)))
      (import "" "g" (func $g (result i32)))
      (import "" "context-get" (func $context-get (result i32)))
      (import "" "context-set" (func $context-set (param i32)))
      (func (export "run") (result i32)
        (drop (call $f))
        (i32.const 0))
      (func (export "context") (result i32)
        (call $context-set (i32.const 7))
        (drop (call $g))
        (call $context-get))
      (func (export "callback") (param i32 i32 i32) (result i32)
        (i32.const 0)))
    (core instance $m (instantiate $m (with "" (instance
      (export "f" (func $f-core))
      (export "g" (func $g-core))
      (export "context-get" (func $context-get))
      (export "context-set" (func $context-set))))))
    ;; An async caller makes the erroneous task.return target a valid live task
    ;; after FACT's exit-sync-call has retired the callee task. Callback ABI
    ;; keeps the fixture executable in both plain and JSPI modes.
    (func (export "run") async (canon lift (core func $m "run") async
      (callback (core func $m "callback"))))
    (func (export "context") (result u32) (canon lift (core func $m "context"))))

  (instance $callee (instantiate $callee))
  (instance $caller (instantiate $caller
    (with "f" (func $callee "f"))
    (with "g" (func $callee "g"))))
  (func (export "run") (alias export $caller "run"))
  (func (export "context") (alias export $caller "context"))
  (func (export "post") (alias export $callee "post"))
  (func (export "seen") (alias export $callee "seen")))
