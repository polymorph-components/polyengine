//! The boundary microbench guest: tight loops over the host imports so
//! the host can time calls-per-second for each boundary shape.

mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "bench",
        generate_all,
        // Needed by the compound-element lanes' guest-side cache (issue
        // #261): `lift_ops` clones a thread_local-cached `Vec<Op>` rather
        // than rebuilding it every call (see `cached_ops` below).
        additional_derives: [Clone],
    });
}

use bindings::bench::boundary::host;
use bindings::{
    NodeUpdateKind, Op, OpAddEventListener, OpCheckpoint, OpInsertElement, OpInsertText,
    OpMoveNode, OpRemoveAttribute, OpRemoveEventListener, OpSetAttribute, OpSetClassList,
    OpSetStyle, OpSetText,
};
use std::cell::RefCell;
use wit_bindgen::rt::async_support::{spawn_local, StreamReader};

struct Component;

impl bindings::Guest for Component {
    async fn send(iters: u32, size: u32) -> u64 {
        let payload = vec![0xa5u8; size as usize];
        let mut acc = 0u64;
        for _ in 0..iters {
            acc = acc.wrapping_add(host::ping(payload.clone()).await as u64);
        }
        acc
    }

    async fn recv(iters: u32, size: u32) -> u64 {
        let mut acc = 0u64;
        for _ in 0..iters {
            let got = host::fetch(size).await;
            acc = acc.wrapping_add(got.len() as u64);
        }
        acc
    }

    async fn send_sync(iters: u32, size: u32) -> u64 {
        let payload = vec![0xa5u8; size as usize];
        let mut acc = 0u64;
        for _ in 0..iters {
            acc = acc.wrapping_add(host::ping_sync(&payload) as u64);
        }
        acc
    }

    // Stream-shaped lanes (issue #68): drain / pump / pass-through, no
    // host import involved — the host drives the stream endpoint
    // directly (see driver-polyengine.mjs).

    async fn stream_sink(s: StreamReader<u8>) -> u64 {
        s.collect().await.len() as u64
    }

    async fn stream_source(n: u32) -> StreamReader<u8> {
        let (mut writer, reader) = bindings::wit_stream::new();
        spawn_local(async move {
            let payload = vec![0x5au8; n as usize];
            writer.write_all(payload).await;
            // `writer` drops here, closing the stream.
        });
        reader
    }

    async fn stream_pass(s: StreamReader<u8>) -> StreamReader<u8> {
        s
    }

    // Compound-element lanes (issue #261): a 16-case variant-over-records
    // element (`Op`, see wit/bench.wit for why this width/shape), the
    // only non-flat payload in the instrument — every other shape above
    // is a scalar (`list<u8>`, `u32`, `stream<u8>`) and takes a bulk copy
    // path (issues #63/#67). These measure the per-element interpreted
    // lift/lower loop instead.

    async fn lift_ops(n: u32) -> Vec<Op> {
        // Guest-side construction is cached (`cached_ops`, keyed on `n`):
        // the warmup call builds it, every timed call clones it. See the
        // README footnote for the measured clone-residue cost this still
        // leaves inside the timed region.
        cached_ops(n)
    }

    async fn lower_ops(ops: Vec<Op>) -> u64 {
        let mut acc = 0u64;
        for op in &ops {
            acc = acc.wrapping_add(fold_op(op));
        }
        acc
    }
}

/// Deterministically cycles through all 16 `Op` cases so each is
/// exercised in proportion (`i % 16`), with both `option<u16>` branches
/// and varying (small — this is not a payload-size lane) `list<u8>`
/// lengths.
fn build_ops(n: u32) -> Vec<Op> {
    (0..n)
        .map(|i| match i % 16 {
            0 => Op::InsertElement(OpInsertElement {
                id: i,
                tag: format!("div{i}"),
                parent: option_u16(i),
            }),
            1 => Op::RemoveElement(i),
            2 => Op::SetAttribute(OpSetAttribute {
                id: i,
                key: "class".to_string(),
                value: format!("c{i}"),
            }),
            3 => Op::RemoveAttribute(OpRemoveAttribute {
                id: i,
                key: "data-x".to_string(),
            }),
            4 => Op::SetText(OpSetText {
                id: i,
                text: format!("text{i}"),
            }),
            5 => Op::InsertText(OpInsertText {
                id: i,
                text: format!("t{i}"),
                parent: option_u16(i),
            }),
            6 => Op::MoveNode(OpMoveNode {
                id: i,
                new_parent: option_u16(i),
                index: (i % 64) as u16,
            }),
            7 => Op::ClearChildren(i),
            8 => Op::SetClassList(OpSetClassList {
                id: i,
                classes: small_bytes(i),
            }),
            9 => Op::SetStyle(OpSetStyle {
                id: i,
                style: small_bytes(i),
            }),
            10 => Op::AddEventListener(OpAddEventListener {
                id: i,
                event: "click".to_string(),
            }),
            11 => Op::RemoveEventListener(OpRemoveEventListener {
                id: i,
                event: "click".to_string(),
            }),
            12 => Op::Focus(i),
            13 => Op::Blur,
            14 => Op::ScrollIntoView,
            _ => Op::Checkpoint(OpCheckpoint {
                id: i,
                update_kind: match i % 4 {
                    0 => NodeUpdateKind::Inserted,
                    1 => NodeUpdateKind::Updated,
                    2 => NodeUpdateKind::Removed,
                    _ => NodeUpdateKind::Moved,
                },
            }),
        })
        .collect()
}

/// Exercises both `option<u16>` branches.
fn option_u16(i: u32) -> Option<u16> {
    if i % 3 == 0 {
        None
    } else {
        Some((i % 0xffff) as u16)
    }
}

/// A short `list<u8>` (2-5 bytes; not a payload-size lane).
fn small_bytes(i: u32) -> Vec<u8> {
    let len = 2 + (i % 4) as usize;
    (0..len).map(|j| ((i + j as u32) % 256) as u8).collect()
}

thread_local! {
    /// Guest-side cache for `lift_ops` (issue #261, revision 2): the
    /// warmup call builds `Vec<Op>` for a given `n`; every timed call
    /// clones the cached vector instead of rebuilding it, so the timed
    /// region no longer pays a `format!`-per-element guest allocation.
    /// The clone itself (Strings and `list<u8>`s are deep-copied) still
    /// allocates inside the timed region — see the README footnote for
    /// its measured cost.
    static OPS_CACHE: RefCell<Option<(u32, Vec<Op>)>> = const { RefCell::new(None) };
}

fn cached_ops(n: u32) -> Vec<Op> {
    OPS_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let needs_build = !matches!(&*cache, Some((cached_n, _)) if *cached_n == n);
        if needs_build {
            *cache = Some((n, build_ops(n)));
        }
        cache.as_ref().unwrap().1.clone()
    })
}

/// Cheap, non-allocating fold touching every field so nothing is
/// dead-code-eliminated (used by `lower_ops`).
fn fold_op(op: &Op) -> u64 {
    match op {
        Op::InsertElement(o) => fold_fields(o.id, o.tag.len() as u64, o.parent.unwrap_or(0) as u64, 0),
        Op::RemoveElement(id) => fold_fields(*id, 0, 0, 1),
        Op::SetAttribute(o) => fold_fields(o.id, o.key.len() as u64, o.value.len() as u64, 2),
        Op::RemoveAttribute(o) => fold_fields(o.id, o.key.len() as u64, 0, 3),
        Op::SetText(o) => fold_fields(o.id, o.text.len() as u64, 0, 4),
        Op::InsertText(o) => fold_fields(o.id, o.text.len() as u64, o.parent.unwrap_or(0) as u64, 5),
        Op::MoveNode(o) => fold_fields(o.id, o.new_parent.unwrap_or(0) as u64, o.index as u64, 6),
        Op::ClearChildren(id) => fold_fields(*id, 0, 0, 7),
        Op::SetClassList(o) => fold_fields(o.id, o.classes.len() as u64, 0, 8),
        Op::SetStyle(o) => fold_fields(o.id, o.style.len() as u64, 0, 9),
        Op::AddEventListener(o) => fold_fields(o.id, o.event.len() as u64, 0, 10),
        Op::RemoveEventListener(o) => fold_fields(o.id, o.event.len() as u64, 0, 11),
        Op::Focus(id) => fold_fields(*id, 0, 0, 12),
        Op::Blur => fold_fields(0, 0, 0, 13),
        Op::ScrollIntoView => fold_fields(0, 0, 0, 14),
        Op::Checkpoint(o) => fold_fields(
            o.id,
            match o.update_kind {
                NodeUpdateKind::Inserted => 0,
                NodeUpdateKind::Updated => 1,
                NodeUpdateKind::Removed => 2,
                NodeUpdateKind::Moved => 3,
            },
            0,
            15,
        ),
    }
}

fn fold_fields(id: u32, a: u64, b: u64, case_const: u64) -> u64 {
    (id as u64)
        .wrapping_add(a)
        .wrapping_add(b)
        .wrapping_add(case_const)
}

bindings::export!(Component with_types_in bindings);
