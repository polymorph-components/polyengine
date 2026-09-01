//! `future-import` guest: exercises host imports whose results carry
//! futures — the `wasi:sockets@0.3` TCP `send`/`receive` shapes reduced to
//! `u32` payloads (see wit/world.wit). `run-send` is the livelock probe:
//! it writes the stream only AFTER the sync `send-sink` import returns, so
//! it can only complete if the host returned the future immediately
//! instead of parking the call on it.

wit_bindgen::generate!({
    world: "future-import",
});

struct Component;

impl Guest for Component {
    async fn run_next() -> u32 {
        next_value().await
    }

    async fn run_send(n: u32) -> u32 {
        let (mut tx, reader) = wit_stream::new();
        // Sync import: returns the future handle immediately
        // (contracts/embedder-api.md §"Streams and futures"). The
        // stream is written afterwards, from this same task.
        let done = send_sink(reader);
        let half = (n / 2) as usize;
        let _ = tx.write_all(vec![1u8; half]).await;
        let _ = tx.write_all(vec![1u8; n as usize - half]).await;
        drop(tx); // end-of-stream: the host's future settles after this
        done.await
    }

    async fn run_recv() -> (u32, u32) {
        let (mut rx, done) = recv_pair();
        let mut sum = 0u32;
        while let Some(b) = rx.next().await {
            sum += u32::from(b);
        }
        let v = done.await;
        (sum, v)
    }
}

export!(Component);
