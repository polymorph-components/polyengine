//! A minimal local replacement for `wit_bindgen_core::Source` (issue: drop
//! the `wit-bindgen-core` dependency, whose only use in this crate was this
//! type as a string-accumulation buffer). Reproduces its brace-tracking
//! auto-indent behavior exactly (verified byte-for-byte by
//! `crates/bindgen/tests/codegen_snapshot.rs`): each `push_str` line gets the
//! current indent prepended, a line ending in `{` bumps the indent for
//! subsequent lines, a line starting with `}` drops the indent (and trims a
//! trailing two-space indent already written for that line), and text
//! recognized as a line comment (`//`) suspends brace tracking until the next
//! newline — `codegen.rs` uses `\x20` escapes on intentional `{`/`}`
//! characters that are not real braces to defeat this exact tracking.
//!
//! Source: wit-bindgen-core 0.58.0 `src/source.rs` (`push_str`), reproduced
//! under upstream's license (this crate is Apache-2.0; wit-bindgen-core is
//! Apache-2.0 WITH LLVM-exception).

use std::fmt;

#[derive(Default)]
pub struct Source {
    s: String,
    indent: usize,
    in_line_comment: bool,
    continuing_line: bool,
}

impl Source {
    pub fn push_str(&mut self, src: &str) {
        let lines = src.lines().collect::<Vec<_>>();
        for (i, line) in lines.iter().enumerate() {
            if !self.continuing_line {
                if !line.is_empty() {
                    for _ in 0..self.indent {
                        self.s.push_str("  ");
                    }
                }
                self.continuing_line = true;
            }

            let trimmed = line.trim();
            if trimmed.starts_with("//") {
                self.in_line_comment = true;
            }

            if !self.in_line_comment {
                if trimmed.starts_with('}') && self.s.ends_with("  ") {
                    self.s.pop();
                    self.s.pop();
                }
            }
            self.s.push_str(if lines.len() == 1 {
                line
            } else {
                line.trim_start()
            });
            if !self.in_line_comment {
                if trimmed.ends_with('{') {
                    self.indent += 1;
                }
                if trimmed.starts_with('}') {
                    self.indent = self.indent.saturating_sub(1);
                }
            }
            if i != lines.len() - 1 || src.ends_with('\n') {
                self.newline();
            }
        }
    }

    fn newline(&mut self) {
        self.in_line_comment = false;
        self.continuing_line = false;
        self.s.push('\n');
    }

    pub fn as_str(&self) -> &str {
        &self.s
    }
}

impl fmt::Write for Source {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.push_str(s);
        Ok(())
    }
}
