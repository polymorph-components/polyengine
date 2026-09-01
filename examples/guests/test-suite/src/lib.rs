//! `test-suite` guest: an L1 suite component per the vendored
//! `polymorph:test@0.1.0` contract (wit/tests.wit), used as polyengine's
//! ct-runner fixture.
//!
//! Six deterministic cases exercising the contract surface:
//!   - `suite/basic/pass`      — a passing case.
//!   - `suite/basic/fail`      — fails with a one-line reason.
//!   - `suite/basic/skip`      — skips with a reason (the `outcome.skipped` arm).
//!   - `suite/diag/chatty`     — emits several `diagnostic` messages mid-run.
//!   - `suite/diag/slow`       — takes measurable time (yields repeatedly),
//!                               for budget/timeout plumbing.
//!   - `suite/nested/deep/leaf`— exercises a `/`-nested case name.

// No explicit `async:` option: the WIT source's own `async func` markers
// (on `test-context.diagnostic`, `tests.all`, `tests.test-case.run`) drive
// per-function sync/async generation, matching upstream `tests.wit` exactly.
wit_bindgen::generate!({
    world: "suite",
});

use std::time::Duration;

struct Component;

/// One case: `name()` is sync per the contract; `run` is async and takes
/// the runner-provided `context` by borrow (WIT: `run: async func(ctx:
/// borrow<context>) -> result<_, outcome>`).
struct Case {
    name: &'static str,
    body: for<'a> fn(&'a polymorph::test::test_context::Context) -> CaseFut<'a>,
}

type CaseFut<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(), exports::polymorph::test::tests::Outcome>> + 'a>,
>;

fn cases() -> Vec<Case> {
    vec![
        Case { name: "suite/basic/pass", body: |_ctx| Box::pin(async { Ok(()) }) },
        Case {
            name: "suite/basic/fail",
            body: |_ctx| {
                Box::pin(async {
                    Err(exports::polymorph::test::tests::Outcome::Failed(
                        "expected 2 + 2 = 4, got 5".to_string(),
                    ))
                })
            },
        },
        Case {
            name: "suite/basic/skip",
            body: |_ctx| {
                Box::pin(async {
                    Err(exports::polymorph::test::tests::Outcome::Skipped(
                        "declared hardware token unavailable at run time".to_string(),
                    ))
                })
            },
        },
        Case {
            name: "suite/diag/chatty",
            body: |ctx| {
                Box::pin(async move {
                    ctx.diagnostic("starting the chatty case".to_string()).await;
                    ctx.diagnostic("midpoint observation: ok".to_string()).await;
                    ctx.diagnostic("finishing up".to_string()).await;
                    Ok(())
                })
            },
        },
        Case {
            name: "suite/diag/slow",
            body: |ctx| {
                Box::pin(async move {
                    // Measurable wall time for budget/timeout plumbing
                    // (the ct-runner's `--case-timeout` gate); a real sleep
                    // rather than a spin-yield so the runner observes actual
                    // elapsed time, per harness.mjs's caseTimeoutMs race
                    // (js/viewer/harness.mjs runCases, the Promise.race
                    // against attempt).
                    ctx.diagnostic("sleeping briefly".to_string()).await;
                    async_std_sleep(Duration::from_millis(50)).await;
                    Ok(())
                })
            },
        },
        Case {
            name: "suite/nested/deep/leaf",
            body: |_ctx| Box::pin(async { Ok(()) }),
        },
    ]
}

/// A minimal sleep built on `wit_bindgen::yield_async` (no WASI clock
/// import in this fixture — kept a pure computational reactor per
/// examples/README.md's corpus convention). Not wall-accurate, just
/// guaranteed to take several scheduler turns so the runner's elapsed-time
/// measurement is nonzero.
async fn async_std_sleep(_d: Duration) {
    for _ in 0..2000 {
        wit_bindgen::yield_async().await;
    }
}

struct TestCase {
    inner: &'static Case,
}

impl exports::polymorph::test::tests::GuestTestCase for TestCase {
    fn name(&self) -> String {
        self.inner.name.to_string()
    }

    async fn run(
        &self,
        ctx: &polymorph::test::test_context::Context,
    ) -> Result<(), exports::polymorph::test::tests::Outcome> {
        (self.inner.body)(ctx).await
    }
}

impl exports::polymorph::test::tests::Guest for Component {
    type TestCase = TestCase;

    async fn all() -> Vec<exports::polymorph::test::tests::TestCase> {
        // `cases()` is deterministic (suite order, per the contract's `all`
        // doc comment); leak the boxed vec once so each `Case` can be
        // referenced by static-lifetime closures without per-call
        // reconstruction (fine for a fixture — this component never runs
        // `all()` in a loop that would grow memory unboundedly).
        static CASES: std::sync::OnceLock<Vec<Case>> = std::sync::OnceLock::new();
        let cases = CASES.get_or_init(cases);
        cases
            .iter()
            .map(|c| {
                exports::polymorph::test::tests::TestCase::new(TestCase { inner: c })
            })
            .collect()
    }
}

export!(Component);
