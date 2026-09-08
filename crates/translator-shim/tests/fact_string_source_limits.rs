use translator_shim::{plan::ModuleEntry, translate};
use wasmtime_environ::wasmparser::{Operator, Parser, Payload};

#[test]
fn fact_string_encoding_matrix() {
    let bytes = wat::parse_str(include_str!(
        "../../../runtime/tests/fixtures/fact-string-source-limits.wat"
    ))
    .unwrap();
    let translated = translate(&bytes).unwrap();
    assert_eq!(
        translated.plan.producer.wasmtime_environ,
        "49.0.0-dev+4675ee1"
    );
    let mut limits = [0, 0];
    for adapter in &translated.adapters {
        for payload in Parser::new(0).parse_all(&adapter.wasm) {
            if let Payload::CodeSectionEntry(body) = payload.unwrap() {
                for op in body.get_operators_reader().unwrap() {
                    if let Operator::I32Const { value } = op.unwrap() {
                        match value {
                            268435455 => limits[0] += 1,
                            134217727 => limits[1] += 1,
                            2147483647 | 1073741823 | 715827882 => panic!("old FACT limit remains"),
                            _ => {}
                        }
                    }
                }
            }
        }
        assert!(translated.plan.modules.iter().any(|m| matches!(m, ModuleEntry::Adapter { file, len, .. } if file == &adapter.file && *len == adapter.wasm.len())));
    }
    // Nine encoding pairs, compact's two branches, plus four retry checks.
    assert_eq!(limits, [8, 8]);
}

#[test]
fn embedded_guest_string_guard_is_not_rewritten() {
    let core = format!(
        r#"(module
        (import "runtime" "trap{}" (func $trap))
        (import "transcode" "utf8-to-utf8 (mem0 => mem1)" (func $copy (param i32 i32 i32)))
        (func (param i32)
            local.get 0 i32.const 2147483647 i32.gt_u if call $trap unreachable end
            i32.const 0 local.get 0 i32.const 0 call $copy))"#,
        wasmtime_environ::Trap::StringOutOfBounds as u8
    );
    let expected = wat::parse_str(&core).unwrap();
    let component = format!(
        "(component {})",
        core.replacen("(module", "(core module", 1)
    );
    let bytes = wat::parse_str(component).unwrap();
    let original = bytes.clone();
    let translated = translate(&bytes).unwrap();
    assert!(translated.adapters.is_empty());
    assert_eq!(bytes, original);
    let ModuleEntry::Embedded { offset, len } = &translated.plan.modules[0] else {
        panic!("guest module became adapter")
    };
    assert_eq!(&bytes[*offset as usize..*offset as usize + len], expected);
}
