//! Native exercise of the exact C-ABI sequence the Deno driver performs:
//! alloc -> write -> translate -> read JSON envelope -> dealloc(out) ->
//! dealloc(in).
//!
//! Running this in debug (with glibc malloc + all Rust debug assertions)
//! double-checks that the buffer-ownership contract is sound independent of
//! the wasm32/dlmalloc build.
use translator_shim::cabi::{ts_alloc, ts_dealloc, ts_translate};

fn roundtrip_bytes(comp: &[u8]) -> String {
    unsafe {
        let ptr = ts_alloc(comp.len());
        std::ptr::copy_nonoverlapping(comp.as_ptr(), ptr, comp.len());
        let mut out_len: usize = 0;
        let out_ptr = ts_translate(ptr, comp.len(), &mut out_len);
        let json = std::str::from_utf8(std::slice::from_raw_parts(out_ptr, out_len))
            .unwrap()
            .to_string();
        ts_dealloc(out_ptr, out_len);
        ts_dealloc(ptr, comp.len());
        json
    }
}

fn roundtrip(name: &str) -> String {
    let path = format!("{}/testdata/{name}.wat", env!("CARGO_MANIFEST_DIR"));
    roundtrip_bytes(&wat::parse_file(&path).unwrap())
}

/// The envelope contains the plan plus one base64 adapter entry per
/// adapter module in the plan's module table.
#[test]
fn cabi_roundtrip_all_testdata() {
    for name in [
        "trivial",
        "linked",
        "async-lift",
        "async-linked",
        "imports",
        "imported-resource",
        "relend-borrow",
        "transcode",
    ] {
        let json = roundtrip(name);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            v["error"].is_null(),
            "{name}: unexpected error: {}",
            v["error"]
        );
        assert_eq!(
            v["plan"]["formatVersion"].as_u64(),
            Some(u64::from(translator_shim::plan::FORMAT_VERSION)),
            "{name}"
        );
        let adapter_modules = v["plan"]["modules"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["kind"] == "adapter")
            .count();
        assert_eq!(
            v["adapters"].as_array().unwrap().len(),
            adapter_modules,
            "{name}: adapter artifact/module mismatch"
        );
    }
    // Repeat to stress allocator reuse the way the deno --bench loop does.
    for _ in 0..20 {
        roundtrip("linked");
    }
}

/// Errors come back as an `{"error": ...}` envelope, not a panic/trap, and
/// carry the structured verdict in `errorDetail` (contracts v0.2 proposal;
/// `src/error.rs`). The `error` string keeps its v0.1 meaning.
#[test]
fn cabi_error_envelope() {
    let json = roundtrip_bytes(b"not a component");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(v["error"].is_string(), "{json}");
    assert_eq!(v["errorDetail"]["phase"], "validation", "{json}");
    assert_eq!(v["errorDetail"]["message"], v["error"], "{json}");
    assert!(v["errorDetail"]["detail"].is_string(), "{json}");
    assert!(v["plan"].is_null(), "{json}");
}

/// A *valid* component the plan cannot represent must be distinguishable from
/// an invalid one: phase `unsupported`, never `validation`.
#[test]
fn cabi_unsupported_phase_is_distinct() {
    // Re-exporting an *imported* module is rejected (the Export::ModuleImport
    // rejection, contracts/plan-format.md schema notes). The former
    // specimen — exporting an own
    // embedded module (`Export::ModuleStatic`) — translates since plan v4;
    // see `cabi_module_export_translates`.
    let comp = wat::parse_str(
        r#"(component (import "m" (core module $m)) (export "m2" (core module $m)))"#,
    )
    .unwrap();
    let json = roundtrip_bytes(&comp);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["errorDetail"]["phase"], "unsupported", "{json}");
}

/// A component exporting one of its own embedded core modules translates
/// (the `module` export kind, contracts/plan-format.md schema notes;
/// polyengine#13) and the plan carries the
/// `module`-kind export pointing into the static module space.
#[test]
fn cabi_module_export_translates() {
    let comp = wat::parse_str(
        r#"(component (core module $m) (export "m" (core module $m)))"#,
    )
    .unwrap();
    let json = roundtrip_bytes(&comp);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(v["error"].is_null(), "{json}");
    let exports = v["plan"]["exports"].as_array().unwrap();
    assert_eq!(exports.len(), 1, "{json}");
    assert_eq!(exports[0]["kind"], "module", "{json}");
    assert_eq!(exports[0]["name"], "m", "{json}");
    assert_eq!(exports[0]["module"], 0, "{json}");
}
