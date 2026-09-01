//! `tcp-echo` guest: the REAL `wasi:sockets@0.3.0` TCP surface end to end
//! (see wit/world.wit). `echo-client` is the wosh listener's exact
//! driving shape (`listener-core/src/tcp.rs`); `start-echo-server` runs
//! the accept path — `stream<tcp-socket>` elements arriving as live
//! resources — and its teardown (dropping the accept stream) must close
//! the host's OS listener through the producer-cancellation hook
//! (contracts/embedder-api.md §"Streams and futures").

wit_bindgen::generate!({
    world: "tcp-echo",
    generate_all,
});

use wit_bindgen::rt::async_support::FutureReader;
use wit_bindgen::StreamResult;

use crate::wasi::sockets::types::{
    IpAddressFamily, IpSocketAddress, Ipv4SocketAddress, TcpSocket,
};

fn loopback(port: u16) -> IpSocketAddress {
    IpSocketAddress::Ipv4(Ipv4SocketAddress {
        port,
        address: (127, 0, 0, 1),
    })
}

/// Drain a byte stream to end-of-stream (the peer's FIN, a drop, or a
/// cancel — the caller does not care which).
async fn read_to_end(rx: &mut wit_bindgen::rt::async_support::StreamReader<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let (result, buf) = rx.read(Vec::with_capacity(4096)).await;
        out.extend_from_slice(&buf);
        match result {
            StreamResult::Complete(_) => {}
            StreamResult::Dropped | StreamResult::Cancelled => break,
        }
    }
    out
}

struct Component;

impl Guest for Component {
    async fn echo_client(port: u16, payload: Vec<u8>) -> Vec<u8> {
        let sock = TcpSocket::create(IpAddressFamily::Ipv4).expect("create");
        sock.connect(loopback(port)).await.expect("connect");

        // One send stream for the socket's lifetime (the wosh shape).
        let (mut tx, tx_reader) = wit_stream::new();
        let send_done = sock.send(tx_reader);
        let (mut rx, _rx_done) = sock.receive();

        let unwritten = tx.write_all(payload).await;
        assert!(unwritten.is_empty(), "the host took the whole payload");
        drop(tx); // FIN: the echo peer sees end-of-input

        let echoed = read_to_end(&mut rx).await;
        let _ = send_done.await;
        echoed
    }

    async fn start_echo_server(conns: u32) -> (u16, FutureReader<u32>) {
        let sock = TcpSocket::create(IpAddressFamily::Ipv4).expect("create");
        sock.bind(loopback(0)).expect("bind");
        let mut accepts = sock.listen().expect("listen");
        let port = match sock.get_local_address().expect("get-local-address") {
            IpSocketAddress::Ipv4(a) => a.port,
            IpSocketAddress::Ipv6(a) => a.port,
        };

        let (done_tx, done_rx) = wit_future::new(|| 0u32);
        wit_bindgen::rt::async_support::spawn_local(async move {
            let mut total = 0u32;
            for _ in 0..conns {
                let Some(conn) = accepts.next().await else {
                    break; // fatal listener death: the stream closed on us
                };
                // Read to the client's FIN, then echo back and FIN.
                let (mut rx, _rx_done) = conn.receive();
                let bytes = read_to_end(&mut rx).await;
                total += bytes.len() as u32;
                let (mut tx, tx_reader) = wit_stream::new();
                let send_done = conn.send(tx_reader);
                let _ = tx.write_all(bytes).await;
                drop(tx); // FIN
                let _ = send_done.await;
                // `conn` drops here: the accepted socket closes.
            }
            // Dropping the accept stream is the cancellation path: the
            // host's parked accept must retire and the OS listener close.
            drop(accepts);
            drop(sock);
            let _ = done_tx.write(total).await;
        });

        (port, done_rx)
    }
}

export!(Component);
