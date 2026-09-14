use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn scratch(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("polyengine-testgen-{name}-{}", std::process::id()))
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn run(input: &Path, output: &Path, selection: &[&str]) {
    let status = Command::new(env!("CARGO_BIN_EXE_testgen"))
        .args([
            "--test-dir",
            input.to_str().unwrap(),
            "--out-dir",
            output.to_str().unwrap(),
        ])
        .args(selection)
        .status()
        .unwrap();
    assert!(status.success());
}

fn manifest(output: &Path) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(output.join("manifest.json")).unwrap(),
    )
    .unwrap()["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn root_nested_collisions_cleanup_and_subset_selection() {
    let base = scratch("cli");
    let input = base.join("input");
    let output = base.join("output");
    let _ = fs::remove_dir_all(&base);
    write(&input.join("same.wast"), "(component)");
    write(&input.join("a/same.wast"), "(component)");
    write(&input.join("b/same.wast"), "(component)");
    run(&input, &output, &[]);
    assert_eq!(
        manifest(&output),
        ["a/same.json", "b/same.json", "same.json"]
    );

    fs::remove_file(input.join("a/same.wast")).unwrap();
    run(&input, &output, &[]);
    assert_eq!(manifest(&output), ["b/same.json", "same.json"]);
    assert!(!output.join("a/same.json").exists());

    write(&input.join("a/other.wast"), "(component)");
    run(&input, &output, &["a"]);
    assert_eq!(manifest(&output), ["a/other.json"]);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn refuses_overlapping_input_and_output() {
    let base = scratch("overlap");
    let input = base.join("input");
    write(&input.join("a/x.wast"), "(component)");
    let status = Command::new(env!("CARGO_BIN_EXE_testgen"))
        .args([
            "--test-dir",
            input.to_str().unwrap(),
            "--out-dir",
            input.join("out").to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(!status.success());
    fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn refuses_output_symlink_to_input_without_removing_source() {
    use std::os::unix::fs::symlink;

    let base = scratch("output-symlink");
    let input = base.join("input");
    let output = base.join("output");
    let source = input.join("a/x.wast");
    let _ = fs::remove_dir_all(&base);
    write(&source, "(component)");
    symlink(&input, &output).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_testgen"))
        .args([
            "--test-dir",
            input.to_str().unwrap(),
            "--out-dir",
            output.to_str().unwrap(),
            "a",
        ])
        .status()
        .unwrap();
    assert!(!status.success());
    assert_eq!(fs::read_to_string(&source).unwrap(), "(component)");
    fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn subset_cleanup_does_not_follow_output_subdirectory_symlink() {
    use std::os::unix::fs::symlink;

    let base = scratch("subdir-symlink");
    let input = base.join("input");
    let output = base.join("output");
    let source = input.join("a/x.wast");
    let _ = fs::remove_dir_all(&base);
    write(&source, "(component)");
    fs::create_dir_all(&output).unwrap();
    symlink(input.join("a"), output.join("a")).unwrap();

    run(&input, &output, &["a"]);
    assert_eq!(fs::read_to_string(&source).unwrap(), "(component)");
    assert!(!output.join("a").is_symlink());
    assert!(output.join("a/x.json").is_file());
    fs::remove_dir_all(base).unwrap();
}
