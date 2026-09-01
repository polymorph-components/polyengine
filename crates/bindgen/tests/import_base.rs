//! Import-base resolution tests (issue #201).
//!
//! Generated bindings used to hardcode `../../../src/...` specifiers,
//! calibrated to exactly one output directory in exactly one checkout — so
//! a binding written anywhere else had unresolvable imports, and the
//! world-digest handshake that `contracts/embedder-api.md` §"Module wiring
//! and instantiation" scopes to the generated typed entry point was
//! unreachable for consumers.
//!
//! Three properties are pinned here:
//! a. depth independence, proven end-to-end with `deno check`;
//! b. the default base's version stays in sync with `runtime/deno.json`;
//! c. both arms of the resolution rule.

use std::path::{Path, PathBuf};

use bindgen::codegen::{generate_with_digest, module_specifier, DEFAULT_IMPORT_BASE};
use bindgen::digest::resolve_world;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../")
}

fn manifest_version() -> String {
    let text = std::fs::read_to_string(repo_root().join("runtime/deno.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    json["version"].as_str().unwrap().to_string()
}

/// (b) A release bump must never leave bindgen pinning a stale runtime line
/// silently — same spirit as the `RUNTIME_VERSION` sync pin in
/// `runtime/src/embedder/copy.ts`.
#[test]
fn default_import_base_matches_runtime_manifest_version() {
    let expected = format!("jsr:@polyengine/runtime@^{}", manifest_version());
    assert_eq!(
        DEFAULT_IMPORT_BASE, expected,
        "the default import base must track runtime/deno.json's version \
         (derived by crates/bindgen/build.rs)"
    );
}

/// (c) Export-addressed arm: bare/`jsr:`/`npm:` bases address an *export* in
/// a package's `exports` map (`runtime/deno.json` declares `./plan`,
/// `./digest`, `./embedder`), so no `/mod.ts` is appended.
#[test]
fn export_addressed_bases_omit_mod_ts() {
    for module in ["plan", "digest", "embedder"] {
        assert_eq!(
            module_specifier(DEFAULT_IMPORT_BASE, module),
            format!("jsr:@polyengine/runtime@^{}/{module}", manifest_version())
        );
        assert_eq!(
            module_specifier("@polyengine/runtime", module),
            format!("@polyengine/runtime/{module}")
        );
        assert_eq!(
            module_specifier("npm:@polyengine/runtime@0.2.0", module),
            format!("npm:@polyengine/runtime@0.2.0/{module}")
        );
        // Documented fallback: an unrecognized scheme is export-addressed,
        // so a hypothetical future registry scheme works by default.
        assert_eq!(
            module_specifier("myregistry:@polyengine/runtime", module),
            format!("myregistry:@polyengine/runtime/{module}")
        );
    }
}

/// (c) File-addressed arm: path *and URL* specifiers address a file on disk
/// or at a URL and need the real filename. `http(s)` bases are included
/// because Deno resolves remote modules by URL — omitting them would
/// reproduce issue #201's failure class (a base that looks like it should
/// work, silently yielding unresolvable imports). No network is touched:
/// these are pure string assertions, and `example.test` is a reserved TLD.
#[test]
fn url_bases_are_file_addressed() {
    for module in ["plan", "digest", "embedder"] {
        assert_eq!(
            module_specifier("file:///abs/runtime/src", module),
            format!("file:///abs/runtime/src/{module}/mod.ts")
        );
        assert_eq!(
            module_specifier("http://example.test/runtime/src", module),
            format!("http://example.test/runtime/src/{module}/mod.ts")
        );
        assert_eq!(
            module_specifier("https://example.test/runtime/src", module),
            format!("https://example.test/runtime/src/{module}/mod.ts")
        );
    }
}

/// (c) File-addressed arm: relative (`.`) and absolute (`/`) bases address a
/// *file* on disk and need the real filename.
#[test]
fn file_addressed_bases_append_mod_ts() {
    for module in ["plan", "digest", "embedder"] {
        assert_eq!(
            module_specifier("../../../src", module),
            format!("../../../src/{module}/mod.ts")
        );
        assert_eq!(
            module_specifier("./src", module),
            format!("./src/{module}/mod.ts")
        );
        assert_eq!(
            module_specifier("/abs/runtime/src", module),
            format!("/abs/runtime/src/{module}/mod.ts")
        );
    }
}

/// The generated header must reproduce the file byte for byte, so the
/// import base is echoed into it.
#[test]
fn header_records_the_import_base() {
    let wit = repo_root().join("examples/guests/hello/wit");
    let (resolve, world_id) = resolve_world(&wit, Some("hello")).unwrap();
    let (_json, _digest, ts) = generate_with_digest(&resolve, world_id, "../../../src").unwrap();
    assert!(
        ts.contains("--import-base ../../../src"),
        "regen header must carry the import base"
    );
}

/// (a) The regression test this issue asks for: generate into a scratch
/// directory at a *different depth* from `runtime/tests/bindgen/generated/`
/// and prove the result typechecks. Under the old hardcoded `../../../src`
/// prefix this fails for any `--out` at another depth.
#[test]
fn generated_bindings_typecheck_at_an_unrelated_depth() {
    let root = repo_root().canonicalize().unwrap();
    let runtime_src = root.join("runtime/src");

    let scratch = std::env::temp_dir().join(format!(
        "polyengine-bindgen-201-{}-{}/a/b/c/d",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&scratch).unwrap();

    let wit = root.join("examples/guests/hello/wit");
    let (resolve, world_id) = resolve_world(&wit, Some("hello")).unwrap();
    // Absolute base -> file-addressed arm; resolves from any output depth,
    // and (unlike the JSR default) needs no network access.
    let (_json, _digest, ts) =
        generate_with_digest(&resolve, world_id, runtime_src.to_str().unwrap()).unwrap();
    let out = scratch.join("hello.ts");
    std::fs::write(&out, ts).unwrap();

    let output = std::process::Command::new("deno")
        .arg("check")
        .arg(&out)
        .current_dir(&root)
        .output()
        .expect("`deno` must be on PATH (it is in the `just test-rust` environment)");

    let ok = output.status.success();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // Best-effort cleanup of the whole unique scratch root.
    let _ = std::fs::remove_dir_all(scratch.ancestors().nth(4).unwrap());

    assert!(ok, "deno check failed for {}:\n{stderr}", out.display());
}
