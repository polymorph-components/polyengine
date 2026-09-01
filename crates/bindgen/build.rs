//! Derives the default import base's runtime version from the single source
//! of truth — `runtime/deno.json` — rather than hand-writing a pin that can
//! silently go stale (issue #201). A stale pin would make generated bindings
//! import a runtime line other than the one they were generated against, so
//! a missing file or a missing `version` field is a hard build failure here.
//!
//! Caveat (AGENTS.md §Versioning): the manifests always carry the NEXT
//! release, so on a development checkout between releases the derived
//! default pins a version that is not published yet.

use std::path::Path;

fn manifest_version(manifest: &Path) -> String {
    let text = std::fs::read_to_string(manifest).unwrap_or_else(|e| {
        panic!(
            "bindgen build.rs: cannot read {} (needed to derive a default \
             import base's version): {e}",
            manifest.display()
        )
    });
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| {
        panic!("bindgen build.rs: {} is not valid JSON: {e}", manifest.display())
    });
    json.get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            panic!(
                "bindgen build.rs: {} has no string `version` field — refusing to \
                 emit a guessed default import base",
                manifest.display()
            )
        })
        .to_string()
}

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let runtime_manifest = Path::new(&manifest_dir).join("../../runtime/deno.json");
    // Protocol's version is independent of the lockstep runtime version
    // (contracts/embedder-api.md §"The host-ABI surface and its version":
    // "protocol's version is the host-ABI version") — the
    // generated bindings' `@polyengine/protocol` import pins protocol's own
    // manifest, never the runtime's.
    let protocol_manifest = Path::new(&manifest_dir).join("../../protocol/deno.json");

    println!("cargo:rerun-if-changed=../../runtime/deno.json");
    println!("cargo:rerun-if-changed=../../protocol/deno.json");
    println!("cargo:rerun-if-changed=build.rs");

    println!(
        "cargo:rustc-env=POLYENGINE_RUNTIME_VERSION={}",
        manifest_version(&runtime_manifest)
    );
    println!(
        "cargo:rustc-env=POLYENGINE_PROTOCOL_VERSION={}",
        manifest_version(&protocol_manifest)
    );
}
