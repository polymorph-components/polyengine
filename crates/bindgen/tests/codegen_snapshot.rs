//! Generation snapshot tests: the generated TS text for each fixture world
//! is checked in under `runtime/tests/bindgen/generated/*.ts` (also used by
//! the Deno `deno check` gate). This test asserts the crate's current
//! output matches those checked-in files byte-for-byte, so a drift in
//! codegen is caught here rather than only downstream in `deno check`.
//!
//! Regenerate after an intentional codegen change:
//! ```text
//! for w in hello values resources async-probe stream-echo future-user; do
//!   cargo run -p bindgen -- examples/guests/$w/wit --world $w \
//!     --out runtime/tests/bindgen/generated/$w.ts --import-base ../../../src
//! done
//! ```

use std::path::Path;

use bindgen::codegen::generate_with_digest;
use bindgen::digest::resolve_world;

fn repo_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../")
}

fn check_snapshot(world_dir: &str, world: &str) {
    let root = repo_root();
    let wit = root.join("examples/guests").join(world_dir).join("wit");
    let (resolve, world_id) = resolve_world(&wit, Some(world)).unwrap();
    // The in-repo fixtures use a relative import base (issue #201): the
    // default JSR specifier would make `deno check` reach the network, and
    // the manifest version is not published yet anyway.
    let (_json, _digest, ts) = generate_with_digest(&resolve, world_id, "../../../src").unwrap();
    let checked_in_path = root
        .join("runtime/tests/bindgen/generated")
        .join(format!("{world}.ts"));
    let checked_in = std::fs::read_to_string(&checked_in_path).unwrap_or_else(|_| {
        panic!(
            "missing checked-in snapshot {} — run the regen command in this file's doc comment",
            checked_in_path.display()
        )
    });
    assert_eq!(
        ts, checked_in,
        "generated output for world `{world}` drifted from the checked-in snapshot \
         ({}) — regenerate it (see this file's doc comment) if the change is intentional",
        checked_in_path.display()
    );
}

#[test]
fn hello_snapshot() {
    check_snapshot("hello", "hello");
}

#[test]
fn values_snapshot() {
    check_snapshot("values", "values");
}

#[test]
fn resources_snapshot() {
    check_snapshot("resources", "resources");
}

#[test]
fn async_probe_snapshot() {
    check_snapshot("async-probe", "async-probe");
}

#[test]
fn stream_echo_snapshot() {
    check_snapshot("stream-echo", "stream-echo");
}

#[test]
fn future_user_snapshot() {
    check_snapshot("future-user", "future-user");
}
