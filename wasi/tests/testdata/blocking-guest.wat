;; The genuinely-blocking guest — the shape no consumer previously
;; had, and the polymorph-iroh upstream-iroh class now has: a sync export
;; that parks its own wasm frame on wasi:io pollables (a timer here; the
;; consumer's real reactor adds socket pollables minted by external glue).
;;
;; Under the retired always-ready stubs this guest did not degrade, it
;; returned instantly without sleeping (the livelock shape, observable here
;; as elapsed-time ~0) — blocking_guest_test.ts pins elapsed >= duration as
;; the fail-on-pre-fix assertion.
;;
;;   nap: func(ns: u64) -> u32        subscribe-duration + pollable.block
;;   nap-poll: func(ns: u64) -> u32   subscribe-duration + poll([p]); returns
;;                                    the ready-list length (list lowering
;;                                    exercises the guest realloc path at
;;                                    resume time)
;;
;; The `pollable` resource type is defined by the wasi:io/poll instance and
;; shared into the clocks instance via an outer alias — the same cross-
;; instance type identity real wasip2 components carry.
;;
;; Regenerate: wasm-tools parse blocking-guest.wat -o blocking-guest.wasm
(component
  (import "wasi:io/poll@0.2.9" (instance $poll
    (export "pollable" (type $pollable (sub resource)))
    (export "[method]pollable.block" (func (param "self" (borrow $pollable))))
    (export "poll" (func (param "in" (list (borrow $pollable))) (result (list u32))))))

  (alias export $poll "pollable" (type $P))

  (import "wasi:clocks/monotonic-clock@0.2.9" (instance $clock
    (alias outer 1 $P (type $p))
    (export "subscribe-duration" (func (param "when" u64) (result (own $p))))))

  (alias export $poll "[method]pollable.block" (func $block))
  (alias export $poll "poll" (func $poll-fn))
  (alias export $clock "subscribe-duration" (func $subscribe))

  (core module $Mem
    (memory (export "mem") 1)
    (global $next (mut i32) (i32.const 64))
    (func (export "realloc") (param $old i32) (param $oldsz i32)
                             (param $align i32) (param $newsz i32) (result i32)
      (local $ret i32)
      (global.set $next
        (i32.and (i32.add (global.get $next) (i32.sub (local.get $align) (i32.const 1)))
                 (i32.xor (i32.sub (local.get $align) (i32.const 1)) (i32.const -1))))
      (local.set $ret (global.get $next))
      (global.set $next (i32.add (global.get $next) (local.get $newsz)))
      (local.get $ret)))
  (core instance $mem (instantiate $Mem))

  (canon lower (func $subscribe) (core func $subscribe'))
  (canon lower (func $block) (core func $block'))
  (canon lower (func $poll-fn)
    (memory $mem "mem") (realloc (func $mem "realloc"))
    (core func $poll'))
  (canon resource.drop $P (core func $drop))

  (core module $M
    (import "" "subscribe" (func $subscribe (param i64) (result i32)))
    (import "" "block" (func $block (param i32)))
    ;; poll: (list-ptr, list-len, retptr) -> (); result list written at retptr.
    (import "" "poll" (func $poll (param i32 i32 i32)))
    (import "" "drop" (func $drop (param i32)))
    (import "" "mem" (memory 1))

    ;; nap: park via pollable.block on a fresh timer.
    (func (export "nap") (param $ns i64) (result i32)
      (local $h i32)
      (local.set $h (call $subscribe (local.get $ns)))
      (call $block (local.get $h))
      (call $drop (local.get $h))
      (i32.const 1))

    ;; nap-poll: park via poll([timer]); return the ready-list length.
    (func (export "nap-poll") (param $ns i64) (result i32)
      (local $h i32)
      (local $len i32)
      (local.set $h (call $subscribe (local.get $ns)))
      ;; borrow-handle array at 16: one element.
      (i32.store (i32.const 16) (local.get $h))
      ;; retptr at 32: poll writes [ptr, len].
      (call $poll (i32.const 16) (i32.const 1) (i32.const 32))
      (local.set $len (i32.load (i32.const 36)))
      (call $drop (local.get $h))
      (local.get $len)))

  (core instance $i (instantiate $M (with "" (instance
    (export "subscribe" (func $subscribe'))
    (export "block" (func $block'))
    (export "poll" (func $poll'))
    (export "drop" (func $drop))
    (export "mem" (memory $mem "mem"))))))

  (func (export "nap") (param "ns" u64) (result u32)
    (canon lift (core func $i "nap")))
  (func (export "nap-poll") (param "ns" u64) (result u32)
    (canon lift (core func $i "nap-poll"))))
