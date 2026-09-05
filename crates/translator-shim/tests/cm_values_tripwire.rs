//! ISSUE #95 tripwire: pins that a component using a `start` section, or a
//! component-level `value` import, is rejected in the VALIDATION phase
//! today — never reaching the `unimplemented!()` panics trusted
//! wasmtime-environ's `translate.rs` has for both shapes (pinned rev, see
//! root Cargo.toml). See the `CM_VALUES` comment
//! on `features()` in `src/lib.rs`.
//!
//! Both shapes are gated by wasmparser's `cm_values` feature
//! (`wasmparser::WasmFeatures::CM_VALUES`, see
//! `validator/component.rs::ComponentState::add_start`'s
//! `require_feature::cm_values` call), which `features()` never enables —
//! `wasmparser::Validator` rejects them before `Translator::translate` ever
//! sees them. If a future change to `features()` turns `CM_VALUES` on,
//! these tests start failing (the panic aborts the *test process*, which
//! `cargo test` reports as a hard crash rather than a clean assertion
//! failure) — that failure mode is itself the tripwire.

use translator_shim::{translate, Phase};

/// A component with a top-level `start` function. Not decodable to a
/// meaningful plan under `CM_VALUES` off; must be a validation-phase
/// rejection ("component model `value`s" feature-gate error), not a panic.
#[test]
fn start_section_is_a_validation_rejection() {
    let wat = r#"
        (component
          (core module $m
            (func (export "f"))
          )
          (core instance $i (instantiate $m))
          (func $f (canon lift (core func $i "f")))
          (start $f)
        )
    "#;
    let bytes = wat::parse_str(wat).expect("start-section component should parse as WAT");
    let err = translate(&bytes).expect_err("start section must be rejected, not accepted");
    assert_eq!(
        err.phase,
        Phase::Validation,
        "start section must be a VALIDATION verdict (assert_invalid-equivalent), \
         not Unsupported/Internal — got {err:?}",
    );
}

/// A component-level `value` import. Same feature gate, same expected
/// verdict.
#[test]
fn value_import_is_a_validation_rejection() {
    let wat = r#"
        (component
          (import "v" (value string))
        )
    "#;
    let bytes = wat::parse_str(wat).expect("value-import component should parse as WAT");
    let err = translate(&bytes).expect_err("value import must be rejected, not accepted");
    assert_eq!(
        err.phase,
        Phase::Validation,
        "value import must be a VALIDATION verdict (assert_invalid-equivalent), \
         not Unsupported/Internal — got {err:?}",
    );
}
