//! testgen: convert the official Component Model `.wast` test suite into
//! JSON command files + extracted `.wasm`/`.wat` artifacts, by driving
//! `wast` and `json-from-wast` (the `wasm-tools json-from-wast` implementation)
//! as libraries. See harness/README.md for the pipeline and schema documentation.
//!
//! Usage:
//!   testgen [--test-dir DIR] [--out-dir DIR] [--source-prefix PREFIX] [SUBDIR...]
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

#[derive(serde::Serialize)]
struct SupplementaryFile {
    path: String,
    source: String,
    directives: std::collections::BTreeMap<String, bool>,
}

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
    let mut source_prefix = "third_party/component-model/test".to_string();
    let mut source_revision: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--test-dir" => {
                test_dir = PathBuf::from(args.next().context("--test-dir needs a value")?)
            }
            "--out-dir" => out_dir = PathBuf::from(args.next().context("--out-dir needs a value")?),
            "--source-prefix" => {
                source_prefix = args.next().context("--source-prefix needs a value")?
            }
            "--source-revision" => {
                source_revision = Some(args.next().context("--source-revision needs a value")?)
            }
            "--help" | "-h" => {
                println!("usage: testgen [--test-dir DIR] [--out-dir DIR] [--source-prefix PREFIX] [SUBDIR...]");
                return Ok(0);
            }
            s if s.starts_with('-') => bail!("unknown flag: {s}"),
            s => subdirs.push(s.to_string()),
        }
    }

    if !test_dir.is_dir() {
        bail!("test dir not found: {}", test_dir.display());
    }
    let canonical_input = test_dir.canonicalize()?;
    let canonical_output = if out_dir.exists() {
        // Resolve the complete existing path: its final component may itself
        // be a symlink back into the input tree.
        out_dir.canonicalize()?
    } else {
        out_dir.parent().unwrap_or(&out_dir).canonicalize()?.join(
            out_dir
                .file_name()
                .context("output directory has no final component")?,
        )
    };
    if canonical_input.starts_with(&canonical_output)
        || canonical_output.starts_with(&canonical_input)
    {
        bail!("input and output directories must not overlap");
    }

    // Deterministic subdir set: sorted, filtered to requested names.
    let mut found: Vec<String> = std::fs::read_dir(&test_dir)
        .with_context(|| format!("reading {}", test_dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    if std::fs::read_dir(&test_dir)?
        .filter_map(|e| e.ok())
        .any(|e| e.path().extension().is_some_and(|ext| ext == "wast"))
    {
        found.push(String::new());
    }
    found.sort();
    if !subdirs.is_empty() {
        for want in &subdirs {
            if !found.contains(want) {
                bail!(
                    "no such test subdirectory: {want} (available: {})",
                    found
                        .iter()
                        .filter(|s| !s.is_empty())
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
        }
        found.retain(|d| subdirs.contains(d));
    }

    let mut converted = 0usize;
    let mut total_commands = 0usize;
    let mut failures: Vec<(PathBuf, anyhow::Error)> = Vec::new();
    let mut generated_files = Vec::new();
    let mut supplementary_files = Vec::new();

    if subdirs.is_empty() && out_dir.exists() {
        std::fs::remove_dir_all(&out_dir)
            .with_context(|| format!("cleaning {}", out_dir.display()))?;
    }
    std::fs::create_dir_all(&out_dir)?;

    for sub in &found {
        let in_sub = test_dir.join(sub);
        let out_sub = out_dir.join(sub);
        // Regenerate from scratch so deleted/renamed wast files leave no
        // stale outputs behind.
        if !sub.is_empty() && out_sub.exists() {
            std::fs::remove_dir_all(&out_sub)
                .with_context(|| format!("cleaning {}", out_sub.display()))?;
        }
        std::fs::create_dir_all(&out_sub)
            .with_context(|| format!("creating {}", out_sub.display()))?;

        let mut wast_files = if sub.is_empty() {
            std::fs::read_dir(&test_dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "wast"))
                .collect()
        } else {
            recursive_wast_files(&in_sub)?
        };
        wast_files.sort();

        for wast_path in wast_files {
            let stem = wast_path
                .file_stem()
                .context("wast file has no stem")?
                .to_string_lossy()
                .into_owned();
            // Stable, machine-independent source reference.
            let relative = wast_path
                .strip_prefix(&test_dir)
                .expect("discovered below test dir");
            let source_rel = format!(
                "{}/{}",
                source_prefix.trim_end_matches('/'),
                relative.to_string_lossy().replace('\\', "/")
            );
            let relative_parent = relative.parent().unwrap_or(Path::new(""));
            let artifact_dir = out_dir.join(relative_parent);
            std::fs::create_dir_all(&artifact_dir)
                .with_context(|| format!("creating {}", artifact_dir.display()))?;
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
                        std::fs::write(artifact_dir.join(filename), bytes).with_context(|| {
                            format!("writing {}/{filename}", relative_parent.display())
                        })?;
                    }
                    let mut json = serde_json::to_string_pretty(&wast)?;
                    json.push('\n');
                    std::fs::write(artifact_dir.join(format!("{stem}.json")), json).with_context(
                        || format!("writing {}/{stem}.json", relative_parent.display()),
                    )?;
                    let generated = relative
                        .with_extension("json")
                        .to_string_lossy()
                        .replace('\\', "/");
                    generated_files.push(generated.clone());
                    supplementary_files.push(SupplementaryFile {
                        path: generated,
                        source: source_rel.clone(),
                        directives: parse_directives(&text)?,
                    });
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
    generated_files.sort();
    supplementary_files.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest = serde_json::json!({ "files": generated_files });
    let mut manifest_str = serde_json::to_string_pretty(&manifest)?;
    manifest_str.push('\n');
    std::fs::write(out_dir.join("manifest.json"), manifest_str)?;
    let metadata = serde_json::json!({
        "source_revision": source_revision,
        "files": supplementary_files,
    });
    let mut metadata_str = serde_json::to_string_pretty(&metadata)?;
    metadata_str.push('\n');
    std::fs::write(out_dir.join("supplementary-metadata.json"), metadata_str)?;

    println!(
        "testgen: converted {converted} wast file(s), {total_commands} commands, {} failure(s)",
        failures.len()
    );
    for (path, e) in &failures {
        eprintln!("--- FAILED: {}\n{e:#}", path.display());
    }
    Ok(failures.len())
}

fn parse_directives(text: &str) -> Result<std::collections::BTreeMap<String, bool>> {
    let mut directives = std::collections::BTreeMap::new();
    for line in text
        .lines()
        .take_while(|line| line.trim().is_empty() || line.starts_with(";;!"))
    {
        let Some(setting) = line.strip_prefix(";;!") else {
            continue;
        };
        let (key, value) = setting.split_once('=').context("invalid ;;! directive")?;
        const KNOWN: &[&str] = &[
            "bulk_memory",
            "component_model_async",
            "component_model_async_stackful",
            "component_model_error_context",
            "component_model_fixed_length_lists",
            "component_model_gc",
            "component_model_implements",
            "component_model_map",
            "component_model_memory64",
            "component_model_more_async_builtins",
            "component_model_threading",
            "exceptions",
            "function_references",
            "gc",
            "gc_types",
            "hogs_memory",
            "memory64",
            "multi_memory",
            "reference_types",
        ];
        if !KNOWN.contains(&key.trim()) {
            bail!("unknown ;;! directive {}", key.trim());
        }
        let value = match value.trim() {
            "true" => true,
            "false" => false,
            other => bail!("unknown ;;! value {other:?} for {}", key.trim()),
        };
        if directives.insert(key.trim().to_string(), value).is_some() {
            bail!("duplicate ;;! directive {}", key.trim());
        }
    }
    Ok(directives)
}

fn recursive_wast_files(root: &Path) -> Result<Vec<PathBuf>> {
    recursive_files_with_extension(root, "wast")
}

fn recursive_files_with_extension(root: &Path, extension: &str) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in
            std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))?
        {
            let path = entry?.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == extension) {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recursive_discovery_preserves_distinct_parent_paths() {
        let root = std::env::temp_dir().join(format!("polyengine-testgen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/nested")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/nested/same.wast"), "").unwrap();
        std::fs::write(root.join("b/same.wast"), "").unwrap();
        let got = recursive_wast_files(&root).unwrap();
        assert_eq!(
            got,
            vec![root.join("a/nested/same.wast"), root.join("b/same.wast")]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directives_are_strict() {
        let got = parse_directives(
            ";;! component_model_async = true\n;;! component_model_implements = false\n(component)",
        )
        .unwrap();
        assert_eq!(got["component_model_async"], true);
        assert_eq!(got["component_model_implements"], false);
        assert!(parse_directives(";;! gc = maybe").is_err());
        assert!(parse_directives(";;! imaginary = true").is_err());
    }
}

fn pretty(mut e: wast::Error, path: &str, text: &str) -> anyhow::Error {
    e.set_path(std::path::Path::new(path));
    e.set_text(text);
    anyhow::anyhow!("{e}")
}
