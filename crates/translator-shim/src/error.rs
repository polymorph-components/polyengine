//! Structured translation verdicts.
//!
//! Translation can fail for three materially different reasons, and consumers
//! (the conformance harness above all) must be able to tell them apart:
//!
//! - **`validation`** — the input is not a valid component. This is
//!   wasmtime's frontend (wasmparser validation + component type checking)
//!   saying no. This, and only this, is the verdict that satisfies the
//!   official suite's `assert_invalid` / `assert_malformed` commands.
//! - **`unsupported`** — the component is valid, but uses a shape this
//!   plan-format version cannot represent (e.g. the GC data model or
//!   re-exported imported modules). A conformance run must *not* score these as
//!   correct rejections; they are triage items.
//! - **`internal`** — a shim invariant broke. Always a bug here.
//!
//! `assert_malformed` (binary decoding) vs `assert_invalid` (type checking)
//! are deliberately *not* split: wasmparser reports both as
//! `BinaryReaderError`, and the distinction is not recoverable without
//! string-matching wasmtime's messages. Both map to `validation`, which is
//! sound for the suite (a rejection with the right phase is what both
//! commands require).

use std::fmt;

use serde::Serialize;

/// Which stage of translation produced a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// wasmtime/wasmparser rejected the input: the component is invalid or
    /// malformed. The only phase that satisfies `assert_invalid` /
    /// `assert_malformed`.
    Validation,
    /// Valid component, unrepresentable in this plan-format version.
    Unsupported,
    /// Shim invariant violation — a bug.
    Internal,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Validation => "validation",
            Phase::Unsupported => "unsupported",
            Phase::Internal => "internal",
        }
    }
}

impl fmt::Display for Phase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A structured translation failure: phase + human message (+ the full
/// anyhow chain for diagnostics).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateError {
    pub phase: Phase,
    pub message: String,
    /// Full `{:?}` rendering of the underlying error chain (diagnostics
    /// only; not part of any verdict).
    pub detail: String,
}

impl fmt::Display for TranslateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.phase, self.message)
    }
}

impl std::error::Error for TranslateError {}

impl TranslateError {
    pub fn new(phase: Phase, message: impl Into<String>) -> Self {
        let message = message.into();
        TranslateError {
            phase,
            detail: message.clone(),
            message,
        }
    }

    /// Classify an `anyhow::Error` raised *after* wasmtime accepted the
    /// component: `Unsupported` markers keep their phase, anything else is a
    /// shim bug.
    pub fn from_plan_error(e: anyhow::Error) -> Self {
        let phase = if e.chain().any(|c| c.downcast_ref::<Unsupported>().is_some()) {
            Phase::Unsupported
        } else {
            Phase::Internal
        };
        TranslateError {
            phase,
            message: format!("{e}"),
            detail: format!("{e:?}"),
        }
    }

    /// Classify an error from wasmtime's component frontend: the input was
    /// rejected, i.e. it is invalid or malformed.
    pub fn from_frontend(e: anyhow::Error) -> Self {
        TranslateError {
            phase: Phase::Validation,
            message: format!("{e}"),
            detail: format!("{e:?}"),
        }
    }
}

/// Marker error: a valid component whose shape the plan cannot represent.
/// Constructed via [`unsupported!`].
#[derive(Debug)]
pub struct Unsupported(pub String);

impl fmt::Display for Unsupported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unsupported {}

/// `bail!`-alike that tags the failure as [`Phase::Unsupported`].
#[macro_export]
macro_rules! unsupported {
    ($($arg:tt)*) => {
        return Err(::anyhow::Error::new($crate::error::Unsupported(format!($($arg)*))))
    };
}
