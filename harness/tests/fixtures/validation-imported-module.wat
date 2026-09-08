;; Valid component; instantiating an imported core module is unsupported.
;; Generate: wasm-tools parse validation-imported-module.wat -o validation-imported-module.wasm
(component
  (import "m" (core module $m))
  (core instance (instantiate $m))
)
