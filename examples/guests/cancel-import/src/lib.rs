//! `cancel-import` guest: the issue #239 corpus.
//!
//! Every export here models one route into the same runtime defect: two
//! `driveAsync` loops live on one store while one of them is parked in its
//! awaiting-race. That race used to hold a store-wide scheduling gate
//! (`Store.pendingResumptions`) for as long as the HOST took to answer, so the
//! second loop spun at its own top of loop and died in ~311ms on
//!
//!   driveAsync: a resumed-activation claim was never released
//!
//! `ping` is the cheap health poll whose failure surfaces that.
//!
//! Two ways to get a second driver, both here: an overlapping export call
//! (`block-for` + `ping`), and a DETACHED guest task — `spawn_local` work is
//! polled inside the exporting component-model task, which outlives the
//! export's `task.return`, so it runs while the host is idle and only the
//! settlement pump is driving.
//!
//! Two ways for such a task to park its wasm frame mid-activation, which is
//! what puts a thread in the race: a sync-typed host import that suspends
//! (`block`), and — the shape actually reported — dropping an in-flight async
//! import future. That drop is wit-bindgen's specified cancellation path: the
//! `Drop` impl on `WaitableOperation` (`rt/async_support/waitable.rs`) issues
//! the component model's `subtask.cancel`, synchronously, because "that's the
//! only way for this to be sound" in Rust.

wit_bindgen::generate!({
    world: "cancel-import",
});

use wit_bindgen::rt::async_support::spawn_local;

struct Component;

impl Guest for Component {
    /// The reported shape, minimized: ONE async import, polled once so the
    /// subtask is genuinely in flight, dropped later from a detached task.
    /// No select, no sockets, no retry loop — one drop suffices.
    async fn start_poll_drop(hold_ms: u64, drop_after_ms: u64) {
        spawn_local(async move {
            let mut held = Box::pin(sleep(hold_ms));
            // One poll starts the subtask: STARTED, handle live, host promise
            // outstanding. (`Box::pin`, not `pin!`: dropping a `Pin<&mut _>`
            // drops the pointer, and the cancellation never happens.)
            let _ = futures::poll!(held.as_mut());
            // Come back later, with the export call long since returned and
            // the host otherwise idle.
            sleep(drop_after_ms).await;
            // THE DROP: `subtask.cancel` on an import still in flight.
            drop(held);
            // Outlive the drop, so this is an in-task cancellation rather than
            // whole-task teardown — teardown drops are routine and harmless.
            sleep(hold_ms).await;
        });
    }

    /// The same cancellation reached the way real code reaches it: a timeout
    /// race in a detached task, where the loser is dropped in flight.
    async fn start_race_drop(slow_ms: u64, fast_ms: u64) {
        spawn_local(async move {
            {
                let slow = Box::pin(sleep(slow_ms));
                let fast = Box::pin(sleep(fast_ms));
                futures::future::select(slow, fast).await;
                // The loser is dropped at the end of this scope.
            }
            sleep(slow_ms).await;
        });
    }

    /// Control: the same mid-frame park with NO cancellation anywhere. Pins
    /// that the defect is about concurrent drivers, not about `subtask.cancel`.
    async fn start_block(ms: u64) {
        spawn_local(async move {
            // Yield through an async import first so `task.return` happens and
            // the export call finishes: the park below must land with no
            // export call outstanding.
            sleep(300).await;
            block(ms);
        });
    }

    /// The reduced form: an ordinary export call that parks mid-frame. Call it
    /// without awaiting and poll `ping` alongside, and there are two export
    /// drivers on one store with no detached task in sight.
    async fn block_for(ms: u64) {
        block(ms);
    }

    /// The health poll. Cheap, synchronous, and unrelated to everything above.
    fn ping() -> u32 {
        42
    }
}

export!(Component);
