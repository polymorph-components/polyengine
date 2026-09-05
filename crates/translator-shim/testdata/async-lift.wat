;; (c1) Async probe, single component: an async-lifted export using the
;; callback ABI (CM 0.3 concurrency). The core function returns a status code
;; and delivers its real result via the `task.return` canonical builtin.
;; Exercises: async function types, `canon lift ... async (callback ...)`,
;; `canon task.return`.
;;
;; NOTE: wasmparser 0.258 (used by the pinned wasmtime-environ git rev)
;; requires the lifted
;; function's component-level type to be an ASYNC function type
;; (`(func async ...)`); wasm-tools CLI 1.247's validator predates that rule
;; but its text format already supports the syntax.
(component
  (core module $M
    (import "" "task.return" (func $task-return (param i32)))
    (func (export "f") (param i32) (result i32)
      ;; deliver result via task.return, then report status "returned"
      (call $task-return (i32.add (local.get 0) (i32.const 1)))
      (i32.const 0))
    (func (export "cb") (param i32 i32 i32) (result i32)
      (i32.const 0)))
  (core func $task-return (canon task.return (result u32)))
  (core instance $i (instantiate $M
    (with "" (instance (export "task.return" (func $task-return))))))
  (func (export "f") async (param "x" u32) (result u32)
    (canon lift (core func $i "f") async (callback (func $i "cb")))))
