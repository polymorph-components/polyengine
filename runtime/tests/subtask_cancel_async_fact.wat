;; A real JSPI callee for #345. Cancellation resumes $block; only after that
;; engine hop does guest code call task.cancel and return to the FACT driver.
(module
  (import "host" "block" (func $block (result i32)))
  (import "host" "task-cancel" (func $task-cancel))
  (func (export "run") (result i32)
    call $block
    drop
    call $task-cancel
    i32.const 0))
