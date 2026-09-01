;; error-context tables: a component whose canonical built-ins allocate a
;; `TypeComponentLocalErrorContextTableIndex` — the index space the plan's
;; `errorContextTables` section describes (contracts/plan-format.md
;; schema). The memory lives in its own core module so
;; `error-context.new` can name it without a cycle.
(component
  (core module $Mem (memory (export "mem") 1))
  (core instance $mem (instantiate $Mem))
  (core func $ec-new (canon error-context.new (memory $mem "mem")))
  (core func $ec-drop (canon error-context.drop))
  (core module $M
    (import "" "ec-new" (func $ec-new (param i32 i32) (result i32)))
    (import "" "ec-drop" (func $ec-drop (param i32)))
    (func (export "f") (param i32) (result i32)
      (call $ec-drop (call $ec-new (i32.const 0) (i32.const 0)))
      (i32.const 0)))
  (core instance $i (instantiate $M
    (with "" (instance (export "ec-new" (func $ec-new)) (export "ec-drop" (func $ec-drop))))))
  (func (export "f") (param "x" u32) (result u32)
    (canon lift (core func $i "f"))))
