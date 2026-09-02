//! `bindgen` CLI (docs/architecture.md §9 kickoff): WIT world -> typed TS facade +
//! embedded canonical digest.
//!
//! ```text
//! bindgen <wit-path> [--world <name>] --out <file.ts> [--import-base <prefix>]
//! bindgen digest <wit-path> [--world <name>]   # print canonical digest only
//! ```

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "bindgen", about = "polyengine WIT -> TS bindgen (kickoff)")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Command>,

    /// WIT file or directory (used when no subcommand is given: `generate`).
    wit_path: Option<PathBuf>,

    #[arg(long)]
    world: Option<String>,

    #[arg(long)]
    out: Option<PathBuf>,

    /// Import base the generated bindings resolve the runtime through.
    ///
    /// Resolution rule, by what the base addresses: a path or URL
    /// specifier addresses a *file* and yields `{base}/{module}/mod.ts`; a
    /// bare or registry specifier addresses an entry in a package's
    /// `exports` map — runtime/deno.json declares `./plan` / `./digest` /
    /// `./embedder` — and yields `{base}/{module}`.
    ///
    /// Concretely, file-addressed when the base starts with `.`, `/`,
    /// `file:`, `http://` or `https://`; export-addressed otherwise. An
    /// unrecognized scheme falls back to export-addressed, so a future
    /// registry scheme works by default while anything file-like must be
    /// spelled as a path, a `file:` URL, or an `http(s)` URL.
    ///
    /// Useful non-default values: `../../../src` (in-repo fixture
    /// regeneration), `@polyengine/runtime` (consumers using an import map
    /// or npm rather than a `jsr:` specifier).
    ///
    /// The default's version is derived from runtime/deno.json at build
    /// time. Caveat: this repo's manifests always carry the NEXT release,
    /// so on a development checkout between releases the default pins a
    /// version that is not published yet (semver ranges never resolve to
    /// the `-pre.g<hash>` prereleases) — bindings from a dev checkout
    /// belong to that unreleased line.
    #[arg(long, value_name = "PREFIX", default_value = bindgen::codegen::DEFAULT_IMPORT_BASE)]
    import_base: String,
}

#[derive(Subcommand)]
enum Command {
    /// Print only the canonical digest (debugging / cross-language tests).
    Digest {
        wit_path: PathBuf,
        #[arg(long)]
        world: Option<String>,
        /// Also print the canonical JSON that was hashed.
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Some(Command::Digest {
            wit_path,
            world,
            json,
        }) => print_digest(&wit_path, world.as_deref(), json),
        None => {
            let wit_path = cli.wit_path.context("missing <wit-path>")?;
            let out = cli.out.context("missing --out <file.ts>")?;
            generate(&wit_path, cli.world.as_deref(), &out, &cli.import_base)
        }
    }
}

fn generate(
    wit_path: &std::path::Path,
    world: Option<&str>,
    out: &std::path::Path,
    import_base: &str,
) -> Result<()> {
    let (resolve, world_id) = bindgen::digest::resolve_world(wit_path, world)?;
    let (_canonical_json, digest, ts) =
        bindgen::codegen::generate_with_digest(&resolve, world_id, import_base)?;
    std::fs::write(out, ts).with_context(|| format!("writing {}", out.display()))?;
    eprintln!("wrote {} (digest {digest})", out.display());
    Ok(())
}

fn print_digest(wit_path: &std::path::Path, world: Option<&str>, json: bool) -> Result<()> {
    let (resolve, world_id) = bindgen::digest::resolve_world(wit_path, world)?;
    let d = bindgen::digest::compute(&resolve, world_id)?;
    if json {
        println!("{}", d.canonical_json);
    }
    println!("{}", d.digest);
    Ok(())
}
