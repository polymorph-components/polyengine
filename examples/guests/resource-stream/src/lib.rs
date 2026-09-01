//! `resource-stream` guest: consumes streams whose elements are OWNED
//! HOST RESOURCES (the tcp `listen` shape; see wit/world.wit).
//! `sum-tickets` drains; `take-then-drop` abandons the reader mid-stream
//! so the host's un-taken-element release path (contracts/embedder-api.md
//! §"Streams and futures") is
//! observable from the host's dtor counts.

wit_bindgen::generate!({
    world: "resource-stream",
});

struct Component;

impl Guest for Component {
    async fn sum_tickets(count: u32) -> u32 {
        let mut rx = tickets(count);
        let mut sum = 0u32;
        while let Some(t) = rx.next().await {
            sum += t.value();
            // `t` drops here: the host dtor runs per element.
        }
        sum
    }

    async fn take_then_drop(count: u32, take: u32) -> u32 {
        let mut rx = tickets(count);
        let mut sum = 0u32;
        for _ in 0..take {
            match rx.next().await {
                Some(t) => sum += t.value(),
                None => break,
            }
        }
        sum
        // `rx` drops here with the producer still live: elements already
        // lowered but never taken must be released host-side, not leaked.
    }
}

export!(Component);
