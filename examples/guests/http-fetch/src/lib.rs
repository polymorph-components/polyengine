//! `http-fetch` guest: drives the REAL `wasi:http@0.3` outbound
//! surface (see wit/world.wit) — guest-constructed requests, `client.send`,
//! streamed response bodies, and the trailers/res future choreography the
//! WIT mandates (every guest-created future writer MUST write: dropping
//! one unwritten is a CABI trap; contracts/embedder-api.md §"Streams and
//! futures").

wit_bindgen::generate!({
    world: "http-fetch",
    generate_all,
});

use wit_bindgen::rt::async_support::StreamReader;
use wit_bindgen::StreamResult;

use crate::wasi::http::client;
use crate::wasi::http::types::{ErrorCode, Fields, Request, Response, Trailers};

/// A trailers future resolving ok(none), written from a spawned task
/// (futures are rendezvous: the write completes when the host reads it).
fn no_trailers() -> wit_bindgen::rt::async_support::FutureReader<Result<Option<Trailers>, ErrorCode>>
{
    let (tx, rx) = wit_future::new(|| Ok(None));
    wit_bindgen::rt::async_support::spawn_local(async move {
        let _ = tx.write(Ok(None)).await;
    });
    rx
}

/// The `res` future consume-body wants: resolves ok(()).
fn ok_res() -> wit_bindgen::rt::async_support::FutureReader<Result<(), ErrorCode>> {
    let (tx, rx) = wit_future::new(|| Ok(()));
    wit_bindgen::rt::async_support::spawn_local(async move {
        let _ = tx.write(Ok(())).await;
    });
    rx
}

async fn read_to_end(rx: &mut StreamReader<u8>) -> Vec<u8> {
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

async fn drain_response(response: Response) -> Vec<u8> {
    let (mut body, _trailers) = Response::consume_body(response, ok_res());
    read_to_end(&mut body).await
}

struct Component;

impl Guest for Component {
    async fn get(authority: String, path: String) -> Result<(u16, Vec<u8>), String> {
        let headers = Fields::new();
        let (request, _transmitted) = Request::new(headers, None, no_trailers(), None);
        request
            .set_scheme(Some(&crate::wasi::http::types::Scheme::Http))
            .map_err(|_| "set-scheme".to_string())?;
        request
            .set_authority(Some(&authority))
            .map_err(|_| "set-authority".to_string())?;
        request
            .set_path_with_query(Some(&path))
            .map_err(|_| "set-path-with-query".to_string())?;
        let response = client::send(request).await.map_err(|e| format!("{e:?}"))?;
        let status = response.get_status_code();
        Ok((status, drain_response(response).await))
    }

    async fn post_echo(
        authority: String,
        path: String,
        body: Vec<u8>,
    ) -> Result<Vec<u8>, String> {
        let headers = Fields::new();
        // One content stream, written from a spawned task while `send`
        // consumes it.
        let (mut tx, contents) = wit_stream::new();
        wit_bindgen::rt::async_support::spawn_local(async move {
            let _ = tx.write_all(body).await;
            // drop(tx): end of the request body
        });
        let (request, _transmitted) = Request::new(headers, Some(contents), no_trailers(), None);
        request
            .set_method(&crate::wasi::http::types::Method::Post)
            .map_err(|_| "set-method".to_string())?;
        request
            .set_scheme(Some(&crate::wasi::http::types::Scheme::Http))
            .map_err(|_| "set-scheme".to_string())?;
        request
            .set_authority(Some(&authority))
            .map_err(|_| "set-authority".to_string())?;
        request
            .set_path_with_query(Some(&path))
            .map_err(|_| "set-path-with-query".to_string())?;
        let response = client::send(request).await.map_err(|e| format!("{e:?}"))?;
        Ok(drain_response(response).await)
    }
}

export!(Component);
