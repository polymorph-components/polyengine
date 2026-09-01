//! Regenerate `testdata/<name>.wasm` from `testdata/<name>.wat` using the
//! `wat` crate that matches the pinned `wasmparser`/`wasmtime-environ`
//! family, rather than whatever `wasm-tools` CLI happens to be installed.
//!
//! `testdata/gen.sh` prefers the CLI for the older fixtures (byte-stable
//! since the earliest fixtures were committed); fixtures using syntax newer
//! than the installed CLI understands
//! are generated here instead:
//!
//!   cargo run -p translator-shim --example emit-testdata -- relend-borrow
//!
//! With no arguments every `.wat` in `testdata/` is regenerated.

fn main() {
    let dir = format!("{}/testdata", env!("CARGO_MANIFEST_DIR"));
    let names: Vec<String> = {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if !args.is_empty() {
            args
        } else {
            let mut all: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "wat"))
                .map(|p| p.file_stem().unwrap().to_string_lossy().to_string())
                .collect();
            all.sort();
            all
        }
    };

    for name in names {
        let wat = format!("{dir}/{name}.wat");
        let bytes = match wat::parse_file(&wat) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("{name}: FAILED to parse: {e}");
                std::process::exit(1);
            }
        };
        // Sanity: the fixture must actually be translatable (or fail with a
        // verdict we intend), so a broken fixture is caught here rather than
        // in a downstream test.
        match translator_shim::translate(&bytes) {
            Ok(_) => {}
            Err(e) => eprintln!("{name}: note: translate() says [{}] {}", e.phase, e.message),
        }
        std::fs::write(format!("{dir}/{name}.wasm"), &bytes).unwrap();
        println!("generated {name}.wasm ({} bytes)", bytes.len());
    }
}
