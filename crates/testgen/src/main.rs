//! testgen: convert the official Component Model `.wast` test suite into
//! JSON command files + extracted `.wasm`/`.wat` artifacts, by driving
//! `wast` and `json-from-wast` (the `wasm-tools json-from-wast` implementation)
//! as libraries. See harness/README.md for the pipeline and schema documentation.
//!
//! Usage:
//!   testgen [--test-dir DIR] [--out-dir DIR] [SUBDIR...]
//!
//! Defaults (resolved relative to the repository root, so this works from
//! any working directory):
//!   --test-dir third_party/component-model/test
//!   --out-dir  harness/generated
//!
//! SUBDIR arguments (e.g. `binary validation`) restrict conversion to those
//! test suite subdirectories; the default is everything.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(failures) if failures == 0 => ExitCode::SUCCESS,
        Ok(failures) => {
            eprintln!("testgen: {failures} file(s) failed to convert");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("testgen: error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn repo_root() -> PathBuf {
    // crates/testgen -> crates -> repo root
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate lives two levels below the repo root")
        .to_path_buf()
}

fn run() -> Result<usize> {
    let root = repo_root();
    let mut test_dir = root.join("third_party/component-model/test");
    let mut out_dir = root.join("harness/generated");
    let mut subdirs: Vec<String> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--test-dir" => test_dir = PathBuf::from(args.next().context("--test-dir needs a value")?),
            "--out-dir" => out_dir = PathBuf::from(args.next().context("--out-dir needs a value")?),
            "--help" | "-h" => {
                println!("usage: testgen [--test-dir DIR] [--out-dir DIR] [SUBDIR...]");
                return Ok(0);
            }
            s if s.starts_with('-') => bail!("unknown flag: {s}"),
            s => subdirs.push(s.to_string()),
        }
    }

    if !test_dir.is_dir() {
        bail!("test dir not found: {}", test_dir.display());
    }

    // Deterministic subdir set: sorted, filtered to requested names.
    let mut found: Vec<String> = std::fs::read_dir(&test_dir)
        .with_context(|| format!("reading {}", test_dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    if !subdirs.is_empty() {
        for want in &subdirs {
            if !found.contains(want) {
                bail!("no such test subdirectory: {want} (available: {})", found.join(", "));
            }
        }
        found.retain(|d| subdirs.contains(d));
    }

    let mut converted = 0usize;
    let mut total_commands = 0usize;
    let mut failures: Vec<(PathBuf, anyhow::Error)> = Vec::new();

    for sub in &found {
        let in_sub = test_dir.join(sub);
        let out_sub = out_dir.join(sub);
        // Regenerate from scratch so deleted/renamed wast files leave no
        // stale outputs behind.
        if out_sub.exists() {
            std::fs::remove_dir_all(&out_sub)
                .with_context(|| format!("cleaning {}", out_sub.display()))?;
        }
        std::fs::create_dir_all(&out_sub)
            .with_context(|| format!("creating {}", out_sub.display()))?;

        let mut wast_files: Vec<PathBuf> = std::fs::read_dir(&in_sub)
            .with_context(|| format!("reading {}", in_sub.display()))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "wast"))
            .collect();
        wast_files.sort();

        for wast_path in wast_files {
            let stem = wast_path
                .file_stem()
                .context("wast file has no stem")?
                .to_string_lossy()
                .into_owned();
            // Stable, machine-independent source reference.
            let source_rel = format!(
                "third_party/component-model/test/{sub}/{}",
                wast_path.file_name().unwrap().to_string_lossy()
            );
            let text = std::fs::read_to_string(&wast_path)
                .with_context(|| format!("reading {}", wast_path.display()))?;

            let mut lexer = wast::lexer::Lexer::new(&text);
            lexer.allow_confusing_unicode(true);
            let buf = match wast::parser::ParseBuffer::new_with_lexer(lexer) {
                Ok(buf) => buf,
                Err(e) => {
                    failures.push((wast_path, pretty(e, &source_rel, &text)));
                    continue;
                }
            };
            let ast: wast::Wast = match wast::parser::parse(&buf) {
                Ok(ast) => ast,
                Err(e) => {
                    failures.push((wast_path, pretty(e, &source_rel, &text)));
                    continue;
                }
            };
            match json_from_wast::Opts::default().convert(&source_rel, &text, ast) {
                Ok(wast) => {
                    let n_artifacts = wast.wasms.len();
                    for (filename, bytes) in &wast.wasms {
                        std::fs::write(out_sub.join(filename), bytes)
                            .with_context(|| format!("writing {sub}/{filename}"))?;
                    }
                    let mut json = serde_json::to_string_pretty(&wast)?;
                    json.push('\n');
                    std::fs::write(out_sub.join(format!("{stem}.json")), json)
                        .with_context(|| format!("writing {sub}/{stem}.json"))?;
                    println!(
                        "converted {source_rel}: {} commands, {} artifacts",
                        wast.commands.len(),
                        n_artifacts
                    );
                    converted += 1;
                    total_commands += wast.commands.len();
                }
                Err(e) => failures.push((wast_path, e)),
            }
        }
    }

    // Manifest: lets consumers (e.g. a browser runner without directory
    // listings) discover the generated JSON files. Sorted, deterministic.
    let mut json_files: Vec<String> = Vec::new();
    for sub in &found {
        let out_sub = out_dir.join(sub);
        let mut files: Vec<String> = std::fs::read_dir(&out_sub)?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.ends_with(".json"))
            .map(|f| format!("{sub}/{f}"))
            .collect();
        files.sort();
        json_files.extend(files);
    }
    let manifest = serde_json::json!({ "files": json_files });
    let mut manifest_str = serde_json::to_string_pretty(&manifest)?;
    manifest_str.push('\n');
    std::fs::write(out_dir.join("manifest.json"), manifest_str)?;

    println!(
        "testgen: converted {converted} wast file(s), {total_commands} commands, {} failure(s)",
        failures.len()
    );
    for (path, e) in &failures {
        eprintln!("--- FAILED: {}\n{e:#}", path.display());
    }
    Ok(failures.len())
}

fn pretty(mut e: wast::Error, path: &str, text: &str) -> anyhow::Error {
    e.set_path(std::path::Path::new(path));
    e.set_text(text);
    anyhow::anyhow!("{e}")
}
