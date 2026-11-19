//! Read-only transport for the fixed, authenticated outbound video origin.
use crate::{
    error::{AppError, AppResult},
    identity::AuthState,
    model::UserIdentity,
};
use futures_util::{stream, StreamExt};
use reqwest::{Client, Response, Url};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{tcp::OwnedWriteHalf, TcpListener, TcpStream},
    sync::Semaphore,
};
const PREFIX: &str = "/outbound-media/";
const PART: u64 = 1024 * 1024;
// One browser range spans several decode buffers, keeping the four-request
// pipeline filled across the old 4 MiB boundary. At most four 1 MiB bodies are
// resident; response length does not increase parallelism or retain media.
const WINDOW: u64 = 16 * PART;
const LIFETIME: Duration = Duration::from_secs(3600);
type Session = (UserIdentity, String);
#[derive(Clone)]
pub struct OutboundMediaServer {
    address: SocketAddr,
    routes: Arc<Mutex<HashMap<String, Arc<Route>>>>,
    client: Client,
}
struct Route {
    url: Url,
    auth: AuthState,
    session: Session,
    created: Instant,
    released: AtomicBool,
    // Verified object metadata only; every block still rechecks live authority.
    verified: Mutex<Option<(u64, Option<String>)>>,
    inspected: tokio::sync::Mutex<Option<bool>>,
    failure: Mutex<Option<&'static str>>,
}
// Drive upstream bodies even while the browser applies socket backpressure.
// Dropping a browser request still aborts its bounded in-flight reads.
struct PartTask(tokio::task::JoinHandle<Result<Part, ()>>);
impl std::future::Future for PartTask {
    type Output = Result<Part, ()>;
    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        std::pin::Pin::new(&mut self.0)
            .poll(cx)
            .map(|result| result.unwrap_or(Err(())))
    }
}
impl Drop for PartTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Route {
    fn fail(&self, code: &'static str) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(code);
        }
    }
    fn valid(&self) -> bool {
        !self.released.load(Ordering::Relaxed)
            && self.created.elapsed() < LIFETIME
            && self.auth.managed_session().is_ok_and(|s| s == self.session)
    }
}
fn invalid() -> AppError {
    AppError::Message("OUTBOUND_VIDEO_URL_INVALID".into())
}
fn allowed_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value).map_err(|_| invalid())?;
    let token = url
        .path()
        .strip_prefix("/api/platform/manager-outbound/media/")
        .ok_or_else(invalid)?;
    if url.scheme() != "https"
        || url.host_str() != Some("114.111.19.219")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    Ok(url)
}
impl OutboundMediaServer {
    pub fn start() -> AppResult<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        // Normal public certificate and IP verification; no redirects/proxies.
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .http1_only()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(25))
            .pool_max_idle_per_host(32)
            .build()
            .map_err(|_| AppError::Message("OUTBOUND_MEDIA_TRANSPORT_UNAVAILABLE".into()))?;
        Self::with_client(client)
    }
    fn with_client(client: Client) -> AppResult<Self> {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let server = Self {
            address: listener.local_addr()?,
            routes: Arc::default(),
            client,
        };
        let state = server.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else {
                return;
            };
            let slots = Arc::new(Semaphore::new(16));
            while let Ok((mut socket, _)) = listener.accept().await {
                let state = state.clone();
                let permit = slots.clone().try_acquire_owned();
                tauri::async_runtime::spawn(async move {
                    let Ok(_permit) = permit else {
                        let _ = socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
                        return;
                    };
                    let _ = state.serve(socket).await;
                });
            }
        });
        Ok(server)
    }
    pub fn register(&self, auth: &AuthState, session: Session, url: &str) -> AppResult<String> {
        let url = allowed_url(url)?;
        if auth.managed_session()? != session {
            return Err(AppError::Message("OUTBOUND_ACCOUNT_CHANGED".into()));
        }
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| invalid())?;
        let token = blake3::hash(&random).to_hex().to_string();
        let mut routes = self.routes.lock().map_err(|_| invalid())?;
        routes.retain(|_, route| route.valid());
        if routes.len() >= 512 {
            if let Some(oldest) = routes
                .iter()
                .min_by_key(|(_, r)| r.created)
                .map(|(k, _)| k.clone())
            {
                routes.remove(&oldest);
            }
        }
        routes.insert(
            token.clone(),
            Arc::new(Route {
                url,
                auth: auth.clone(),
                session,
                created: Instant::now(),
                released: AtomicBool::new(false),
                verified: Mutex::new(None),
                inspected: tokio::sync::Mutex::new(None),
                failure: Mutex::new(None),
            }),
        );
        Ok(format!("http://{}{PREFIX}{token}", self.address))
    }
    fn local_token(&self, value: &str) -> AppResult<String> {
        let url = Url::parse(value).map_err(|_| invalid())?;
        let token = url.path().strip_prefix(PREFIX).ok_or_else(invalid)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port() != Some(self.address.port())
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || token.len() != 64
            || !token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
        Ok(token.to_owned())
    }
    // Read only, bounded codes; no network, ticket, object path or credentials.
    pub fn status(&self, auth: &AuthState, url: &str) -> AppResult<Option<&'static str>> {
        let session = auth.managed_session()?;
        let token = self.local_token(url)?;
        let routes = self.routes.lock().map_err(|_| invalid())?;
        let route = routes
            .get(&token)
            .filter(|route| route.session == session)
            .ok_or_else(invalid)?;
        if !route.valid() {
            return Ok(Some("OUTBOUND_MEDIA_EXPIRED"));
        }
        let code = *route.failure.lock().map_err(|_| invalid())?;
        Ok(code)
    }
    /// Read the movie clock through the same authorized, conditional ranges as
    /// playback. No decoder or media-body download is needed for other parts.
    pub async fn metadata(&self, auth: &AuthState, url: &str) -> AppResult<f64> {
        let session = auth.managed_session()?;
        let token = self.local_token(url)?;
        let route = self
            .routes
            .lock()
            .map_err(|_| invalid())?
            .get(&token)
            .filter(|route| route.session == session && route.valid())
            .cloned()
            .ok_or_else(invalid)?;
        let result =
            tokio::time::timeout(Duration::from_secs(25), self.movie_duration(&route)).await;
        if !route.valid() || auth.managed_session()? != session {
            return Err(AppError::Message("OUTBOUND_ACCOUNT_CHANGED".into()));
        }
        match result {
            Ok(Ok(duration)) => Ok(duration),
            other => {
                if other.is_err() {
                    route.fail("OUTBOUND_MEDIA_TIMEOUT");
                }
                let code = route
                    .failure
                    .lock()
                    .map_err(|_| invalid())?
                    .unwrap_or("OUTBOUND_MEDIA_DURATION_INVALID");
                Err(AppError::Message(code.into()))
            }
        }
    }

    /// Frame stepping is opt-in. Read at most one MiB of index, never media
    /// payload or a guessed FPS; unsupported timing must not poison playback.
    pub async fn frame_step(&self, auth: &AuthState, url: &str) -> AppResult<Option<f64>> {
        let session = auth.managed_session()?;
        let token = self.local_token(url)?;
        let route = self
            .routes
            .lock()
            .map_err(|_| invalid())?
            .get(&token)
            .filter(|route| route.session == session && route.valid())
            .cloned()
            .ok_or_else(invalid)?;
        let result =
            tokio::time::timeout(Duration::from_secs(25), self.movie_frame_step(&route)).await;
        if !route.valid() || auth.managed_session()? != session {
            return Err(AppError::Message("OUTBOUND_ACCOUNT_CHANGED".into()));
        }
        match result {
            Ok(Ok(step)) => Ok(step),
            _ => Err(AppError::Message("OUTBOUND_FRAME_STEP_UNAVAILABLE".into())),
        }
    }

    async fn movie_frame_step(&self, route: &Route) -> Result<Option<f64>, ()> {
        let verified = route.verified.lock().map_err(|_| ())?.clone();
        let first = self
            .part(
                route,
                0,
                65535,
                verified.as_ref().map(|(n, e)| (*n, e.as_deref())),
            )
            .await?;
        let expected = Some((first.total, first.etag.as_deref()));
        let mut offset = 0_u64;
        for _ in 0..64 {
            if offset >= first.total {
                return Ok(None);
            }
            let extra;
            let bytes = if offset.saturating_add(16) <= first.body.len() as u64 {
                &first.body[offset as usize..]
            } else {
                extra = self
                    .part(route, offset, (offset + 15).min(first.total - 1), expected)
                    .await?;
                &extra.body
            };
            let Some((size, kind)) = mp4_box(bytes, offset, first.total) else {
                return Ok(None);
            };
            if &kind == b"moov" {
                if size > PART {
                    return Ok(None);
                }
                let index;
                let bytes = if offset + size <= first.body.len() as u64 {
                    &first.body[offset as usize..(offset + size) as usize]
                } else {
                    index = self
                        .part(route, offset, offset + size - 1, expected)
                        .await?;
                    &index.body
                };
                return Ok(mp4_child(bytes, b"moov").and_then(constant_video_step));
            }
            offset += size;
        }
        Ok(None)
    }

    async fn movie_duration(&self, route: &Route) -> Result<f64, ()> {
        let verified = route.verified.lock().map_err(|_| ())?.clone();
        let first = self
            .part(
                route,
                0,
                65535,
                verified.as_ref().map(|(n, e)| (*n, e.as_deref())),
            )
            .await?;
        let total = first.total;
        let expected = Some((total, first.etag.as_deref()));
        let mut offset = 0;
        for _ in 0..64 {
            if offset >= total {
                route.fail("OUTBOUND_MEDIA_INDEX_MISSING");
                return Err(());
            }
            let block;
            let bytes = if offset.saturating_add(64) <= first.body.len() as u64 {
                &first.body[offset as usize..]
            } else {
                block = self
                    .part(route, offset, (offset + 63).min(total - 1), expected)
                    .await?;
                &block.body
            };
            let (size, kind) = mp4_box(bytes, offset, total)
                .ok_or_else(|| route.fail("OUTBOUND_MEDIA_CONTAINER_INVALID"))?;
            if &kind == b"moov" {
                let end = offset + size;
                offset += if bytes.get(..4) == Some(&[0, 0, 0, 1]) {
                    16
                } else {
                    8
                };
                for _ in 0..128 {
                    if offset >= end {
                        break;
                    }
                    let child;
                    let bytes = if offset.saturating_add(64) <= first.body.len() as u64 {
                        &first.body[offset as usize..(end.min(first.body.len() as u64)) as usize]
                    } else {
                        child = self
                            .part(route, offset, (offset + 63).min(end - 1), expected)
                            .await?;
                        &child.body
                    };
                    let (size, kind) = mp4_box(bytes, offset, end)
                        .ok_or_else(|| route.fail("OUTBOUND_MEDIA_CONTAINER_INVALID"))?;
                    if &kind == b"mvhd" {
                        let header = if bytes.get(..4) == Some(&[0, 0, 0, 1]) {
                            16
                        } else {
                            8
                        };
                        return movie_clock(
                            bytes
                                .get(header..size.min(bytes.len() as u64) as usize)
                                .ok_or(())?,
                        )
                        .ok_or_else(|| route.fail("OUTBOUND_MEDIA_DURATION_INVALID"));
                    }
                    offset += size;
                }
                route.fail("OUTBOUND_MEDIA_DURATION_INVALID");
                return Err(());
            }
            offset += size;
        }
        route.fail("OUTBOUND_MEDIA_CONTAINER_INVALID");
        Err(())
    }
    pub fn release(&self, auth: &AuthState, urls: &[String]) -> AppResult<()> {
        let session = auth.managed_session()?;
        if urls.len() > 32 {
            return Err(invalid());
        }
        let mut routes = self.routes.lock().map_err(|_| invalid())?;
        for value in urls {
            let url = Url::parse(value).map_err(|_| invalid())?;
            let token = url.path().strip_prefix(PREFIX).ok_or_else(invalid)?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.port() != Some(self.address.port())
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || token.len() != 64
                || !token.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid());
            }
            if routes
                .get(token)
                .is_some_and(|route| route.session == session)
            {
                if let Some(route) = routes.remove(token) {
                    route.released.store(true, Ordering::Relaxed);
                }
            }
        }
        Ok(())
    }
    async fn serve(&self, mut socket: TcpStream) -> std::io::Result<()> {
        socket.set_nodelay(true)?;
        let Ok(Ok(request)) =
            tokio::time::timeout(Duration::from_secs(5), read_request(&mut socket)).await
        else {
            return Ok(());
        };
        let (mut reader, mut writer) = socket.into_split();
        let token = request
            .path
            .strip_prefix(PREFIX)
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()));
        let route = token.and_then(|token| self.routes.lock().ok()?.get(token).cloned());
        let Some(route) = route else {
            return empty(&mut writer, "404 Not Found").await;
        };
        if !route.valid() {
            return empty(&mut writer, "403 Forbidden").await;
        }
        if request.method == "OPTIONS" {
            return empty(&mut writer, "204 No Content").await;
        }
        if !matches!(request.method.as_str(), "GET" | "HEAD") {
            return empty(&mut writer, "405 Method Not Allowed").await;
        }
        if request.range.as_deref().is_some_and(|r| !valid_range(r)) {
            return empty(&mut writer, "416 Range Not Satisfiable").await;
        }
        let work = async {
            if self.proxy(&route, &request, &mut writer).await.is_err() {
                // Never turn a truncated declared body into a successful MP4.
                let _ = writer.shutdown().await;
            }
        };
        let mut unexpected = [0_u8; 1];
        tokio::select! {
            _ = work => {},
            _ = reader.read(&mut unexpected) => {},
            _ = tokio::time::sleep(Duration::from_secs(120)) => { route.fail("OUTBOUND_MEDIA_TIMEOUT"); },
            _ = async { loop { tokio::time::sleep(Duration::from_millis(100)).await; if !route.valid() { break } } } => {},
        }
        Ok(())
    }
    async fn proxy(
        &self,
        route: &Arc<Route>,
        request: &Request,
        writer: &mut OwnedWriteHalf,
    ) -> Result<(), ()> {
        if request.method == "GET" {
            self.inspect_mp4(route).await?;
        }
        let open = request
            .range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.strip_suffix('-'))
            .and_then(|r| r.parse::<u64>().ok());
        if request.method == "GET" {
            if let Some(start) = open {
                let verified = route.verified.lock().map_err(|_| ())?.clone();
                if let Some((total, etag)) = verified {
                    if start >= total {
                        return empty(writer, "416 Range Not Satisfiable")
                            .await
                            .map_err(|_| ());
                    }
                    let end = start.saturating_add(WINDOW - 1).min(total - 1);
                    // Poll all four blocks together, including the first. A
                    // first-block barrier halves throughput on high-rate cam0.
                    let chunks = (start..=end).step_by(PART as usize).map(|offset| {
                        self.spawn_part(
                            route,
                            offset,
                            offset.saturating_add(PART - 1).min(end),
                            total,
                            etag.clone(),
                        )
                    });
                    let mut chunks = stream::iter(chunks).buffered(4);
                    let first = chunks.next().await.ok_or(())??;
                    headers(writer, 206, end - start + 1, Some((start, end, total))).await?;
                    writer.write_all(&first.body).await.map_err(|_| ())?;
                    drop(first);
                    while let Some(chunk) = chunks.next().await {
                        let chunk = chunk?;
                        if !route.valid() {
                            return Err(());
                        }
                        writer.write_all(&chunk.body).await.map_err(|_| ())?;
                    }
                    return writer.shutdown().await.map_err(|_| ());
                }
                let first = self
                    .part(route, start, start.saturating_add(PART - 1), None)
                    .await?;
                let total = first.total;
                let end = start.saturating_add(WINDOW - 1).min(total - 1);
                let etag = first.etag.clone();
                {
                    let mut verified = route.verified.lock().map_err(|_| ())?;
                    let actual = (total, etag.clone());
                    if verified.as_ref().is_some_and(|prior| prior != &actual) {
                        return Err(());
                    }
                    *verified = Some(actual);
                }
                headers(writer, 206, end - start + 1, Some((start, end, total))).await?;
                writer.write_all(&first.body).await.map_err(|_| ())?;
                let next = first.end + 1;
                drop(first);
                let rest = (next..=end).step_by(PART as usize).map(|offset| {
                    self.spawn_part(
                        route,
                        offset,
                        offset.saturating_add(PART - 1).min(end),
                        total,
                        etag.clone(),
                    )
                });
                let mut parts = stream::iter(rest).buffered(3);
                while let Some(part) = parts.next().await {
                    let part = part?;
                    if !route.valid() {
                        return Err(());
                    }
                    writer.write_all(&part.body).await.map_err(|_| ())?;
                }
                writer.shutdown().await.map_err(|_| ())?;
                return Ok(());
            }
        }
        let mut outgoing = self.client.request(
            if request.method == "HEAD" {
                reqwest::Method::HEAD
            } else {
                reqwest::Method::GET
            },
            route.url.clone(),
        );
        if let Some(range) = &request.range {
            outgoing = outgoing.header("Range", range);
        }
        let response = outgoing.send().await.map_err(|_| ())?;
        if !route.valid() {
            return Err(());
        }
        if !response.status().is_success() {
            return empty(
                writer,
                if response.status().as_u16() == 416 {
                    "416 Range Not Satisfiable"
                } else {
                    "502 Bad Gateway"
                },
            )
            .await
            .map_err(|_| ());
        }
        let length = response
            .headers()
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<u64>().ok())
            .ok_or(())?;
        let status = response.status().as_u16();
        let range = content_range(&response);
        if status == 206 && range.is_none() || status != 200 && status != 206 {
            return Err(());
        }
        if request.range.is_some() != (status == 206) {
            return Err(());
        }
        if let Some((start, end, total)) = range {
            if end - start + 1 != length
                || requested_range(request.range.as_deref().ok_or(())?, total) != Some((start, end))
            {
                return Err(());
            }
        }
        headers(writer, status, length, range).await?;
        if request.method == "HEAD" {
            return Ok(());
        }
        let mut stream = response.bytes_stream();
        let mut count = 0_u64;
        while let Some(bytes) = stream.next().await {
            let bytes = bytes.map_err(|_| ())?;
            count = count.checked_add(bytes.len() as u64).ok_or(())?;
            if count > length || !route.valid() {
                return Err(());
            }
            writer.write_all(&bytes).await.map_err(|_| ())?;
        }
        if count != length {
            return Err(());
        }
        Ok(())
    }
    fn spawn_part(
        &self,
        route: &Arc<Route>,
        start: u64,
        end: u64,
        total: u64,
        etag: Option<String>,
    ) -> PartTask {
        let server = self.clone();
        let route = route.clone();
        PartTask(tokio::spawn(async move {
            server
                .part(&route, start, end, Some((total, etag.as_deref())))
                .await
        }))
    }
    async fn part(
        &self,
        route: &Route,
        start: u64,
        end: u64,
        expected: Option<(u64, Option<&str>)>,
    ) -> Result<Part, ()> {
        if !route.valid() {
            return Err(());
        }
        let mut request = self
            .client
            .get(route.url.clone())
            .header("Range", format!("bytes={start}-{end}"));
        if let Some((_, Some(etag))) = expected {
            request = request.header("If-Match", etag);
        }
        let response = request.send().await.map_err(|error| {
            route.fail(if error.is_timeout() {
                "OUTBOUND_MEDIA_TIMEOUT"
            } else {
                "OUTBOUND_MEDIA_NETWORK"
            });
        })?;
        if response.status().as_u16() != 206 || !route.valid() {
            route.fail(match response.status().as_u16() {
                401 | 403 => "OUTBOUND_MEDIA_EXPIRED",
                409 | 412 => "OUTBOUND_SOURCE_CHANGED",
                429 | 503 => "OUTBOUND_MEDIA_BUSY",
                502 | 504 => "OUTBOUND_MEDIA_UPSTREAM",
                404 => "OUTBOUND_VIDEO_NOT_FOUND",
                _ => "OUTBOUND_MEDIA_RESPONSE_INVALID",
            });
            return Err(());
        }
        let (actual_start, actual_end, total) = content_range(&response)
            .ok_or_else(|| route.fail("OUTBOUND_MEDIA_RESPONSE_INVALID"))?;
        let etag = response
            .headers()
            .get("etag")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let length = actual_end - actual_start + 1;
        if actual_start != start
            || actual_end != end.min(total - 1)
            || length > PART
            || response.content_length() != Some(length)
            || expected.is_some_and(|(size, tag)| size != total || tag != etag.as_deref())
        {
            route.fail("OUTBOUND_MEDIA_INTEGRITY");
            return Err(());
        }
        let mut body = Vec::with_capacity(length as usize);
        let mut stream = response.bytes_stream();
        while let Some(bytes) = stream.next().await {
            let bytes = bytes.map_err(|_| route.fail("OUTBOUND_MEDIA_NETWORK"))?;
            if body.len() + bytes.len() > length as usize || !route.valid() {
                route.fail("OUTBOUND_MEDIA_INTEGRITY");
                return Err(());
            }
            body.extend_from_slice(&bytes);
        }
        if body.len() as u64 != length {
            route.fail("OUTBOUND_MEDIA_INTEGRITY");
            return Err(());
        }
        Ok(Part {
            total,
            end: actual_end,
            etag,
            body,
        })
    }
    async fn inspect_mp4(&self, route: &Route) -> Result<(), ()> {
        let mut inspected = route.inspected.lock().await;
        if let Some(valid) = *inspected {
            return if valid { Ok(()) } else { Err(()) };
        }
        // Skip media payload by declared box lengths. A missing end index must
        // never cause WebView2 to download hundreds of MiB looking for it.
        let first = self.part(route, 0, 65535, None).await?;
        let total = first.total;
        let etag = first.etag.as_deref();
        let mut offset = 0_u64;
        for _ in 0..64 {
            if offset == total {
                route.fail("OUTBOUND_MEDIA_INDEX_MISSING");
                *inspected = Some(false);
                return Err(());
            }
            let extra;
            let bytes = if offset.saturating_add(16) <= first.body.len() as u64 {
                &first.body[offset as usize..offset as usize + 16]
            } else {
                extra = self
                    .part(
                        route,
                        offset,
                        offset.saturating_add(15).min(total - 1),
                        Some((total, etag)),
                    )
                    .await?;
                &extra.body[..]
            };
            let header = mp4_box(bytes, offset, total);
            let Some((size, kind)) = header else {
                route.fail("OUTBOUND_MEDIA_CONTAINER_INVALID");
                *inspected = Some(false);
                return Err(());
            };
            if &kind == b"moov" {
                *route.verified.lock().map_err(|_| ())? = Some((total, first.etag.clone()));
                *inspected = Some(true);
                return Ok(());
            }
            offset += size;
        }
        // Unusual containers beyond the inspection budget remain decoder-owned.
        *inspected = Some(true);
        Ok(())
    }
}
fn mp4_children(mut bytes: &[u8]) -> Option<Vec<([u8; 4], &[u8])>> {
    let mut children = Vec::new();
    while !bytes.is_empty() {
        if children.len() >= 128 {
            return None;
        }
        let (size, kind) = mp4_box(bytes, 0, bytes.len() as u64)?;
        let header = if bytes.get(..4)? == [0, 0, 0, 1] {
            16
        } else {
            8
        };
        children.push((kind, bytes.get(header..size as usize)?));
        bytes = &bytes[size as usize..];
    }
    Some(children)
}
fn mp4_child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    mp4_children(bytes)?
        .into_iter()
        .find_map(|(k, p)| (&k == kind).then_some(p))
}
fn constant_video_step(movie: &[u8]) -> Option<f64> {
    for (kind, track) in mp4_children(movie)? {
        if &kind != b"trak" {
            continue;
        }
        let media = mp4_child(track, b"mdia")?;
        if mp4_child(media, b"hdlr")?.get(8..12)? != b"vide" {
            continue;
        }
        let clock = mp4_child(media, b"mdhd")?;
        let at = match clock.first()? {
            0 => 12,
            1 => 20,
            _ => return None,
        };
        let scale = u32::from_be_bytes(clock.get(at..at + 4)?.try_into().ok()?);
        let sample_table = mp4_child(mp4_child(media, b"minf")?, b"stbl")?;
        let table = mp4_child(sample_table, b"stts")?;
        if table.get(..4)? != [0, 0, 0, 0] {
            return None;
        }
        let count = u32::from_be_bytes(table.get(4..8)?.try_into().ok()?) as usize;
        if scale == 0 || count == 0 || count > 65536 || table.len() != 8 + count * 8 {
            return None;
        }
        let mut delta = None;
        let mut sample_count = 0_i64;
        for entry in table[8..].chunks_exact(8) {
            let samples = u32::from_be_bytes(entry[..4].try_into().ok()?);
            let ticks = u32::from_be_bytes(entry[4..].try_into().ok()?);
            if samples == 0 || ticks == 0 || delta.is_some_and(|d| d != ticks) {
                return None;
            }
            delta = Some(ticks);
            sample_count += i64::from(samples);
        }
        // B-frame decode order can differ from display order. Verify that the
        // composition runs still cover one contiguous frame lattice, without
        // expanding a potentially enormous per-sample timestamp array.
        if let Some((_, composition)) = mp4_children(sample_table)?
            .into_iter()
            .find(|(k, _)| k == b"ctts")
        {
            composition_clock(composition, i64::from(delta?), sample_count)?;
        }
        let step = f64::from(delta?) / f64::from(scale);
        return (step.is_finite() && step > 0. && step <= 1.).then_some(step);
    }
    None
}
fn composition_clock(table: &[u8], delta: i64, samples: i64) -> Option<()> {
    let version = *table.first()?;
    if version > 1 || table.get(1..4)? != [0, 0, 0] {
        return None;
    }
    let count = u32::from_be_bytes(table.get(4..8)?.try_into().ok()?) as usize;
    if count == 0 || count > 65536 || table.len() != 8 + count * 8 {
        return None;
    }
    let mut runs = Vec::with_capacity(count);
    let mut decoded = 0_i64;
    let mut residue = None;
    for entry in table[8..].chunks_exact(8) {
        let n = i64::from(u32::from_be_bytes(entry[..4].try_into().ok()?));
        let ticks = if version == 1 {
            i64::from(i32::from_be_bytes(entry[4..].try_into().ok()?))
        } else {
            i64::from(u32::from_be_bytes(entry[4..].try_into().ok()?))
        };
        let rem = ticks.rem_euclid(delta);
        if n == 0 || residue.is_some_and(|r| r != rem) {
            return None;
        }
        residue = Some(rem);
        let start = decoded + (ticks - rem) / delta;
        runs.push((start, start + n));
        decoded += n;
    }
    if decoded != samples {
        return None;
    }
    runs.sort_unstable();
    runs.windows(2)
        .all(|pair| pair[0].1 == pair[1].0)
        .then_some(())
}
fn movie_clock(payload: &[u8]) -> Option<f64> {
    let (scale_at, duration_at, wide) = match payload.first()? {
        0 => (12, 16, false),
        1 => (20, 24, true),
        _ => return None,
    };
    let scale = u32::from_be_bytes(payload.get(scale_at..scale_at + 4)?.try_into().ok()?);
    let ticks = if wide {
        u64::from_be_bytes(payload.get(duration_at..duration_at + 8)?.try_into().ok()?)
    } else {
        u64::from(u32::from_be_bytes(
            payload.get(duration_at..duration_at + 4)?.try_into().ok()?,
        ))
    };
    if scale == 0 || ticks == 0 || ticks == if wide { u64::MAX } else { u64::from(u32::MAX) } {
        return None;
    }
    let seconds = ticks as f64 / f64::from(scale);
    (seconds.is_finite() && seconds > 0.).then_some(seconds)
}
fn mp4_box(bytes: &[u8], offset: u64, total: u64) -> Option<(u64, [u8; 4])> {
    let kind = bytes.get(4..8)?.try_into().ok()?;
    let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
    let size = match size {
        0 => total.checked_sub(offset)?,
        1 => u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?),
        value => u64::from(value),
    };
    let minimum = if bytes.get(..4)? == [0, 0, 0, 1] {
        16
    } else {
        8
    };
    (size >= minimum && offset.checked_add(size)? <= total).then_some((size, kind))
}
struct Part {
    total: u64,
    end: u64,
    etag: Option<String>,
    body: Vec<u8>,
}
fn content_range(response: &Response) -> Option<(u64, u64, u64)> {
    parse_content_range(response.headers().get("content-range")?.to_str().ok()?)
}
fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}
fn valid_range(value: &str) -> bool {
    let Some((start, end)) = value.strip_prefix("bytes=").and_then(|v| v.split_once('-')) else {
        return false;
    };
    (!start.is_empty() || !end.is_empty())
        && [start, end]
            .iter()
            .all(|v| v.bytes().all(|b| b.is_ascii_digit()))
        && [start, end]
            .iter()
            .all(|v| v.is_empty() || v.parse::<u64>().is_ok())
        && (start.is_empty()
            || end.is_empty()
            || start.parse::<u64>().ok() <= end.parse::<u64>().ok())
}
fn requested_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if total == 0 {
        return None;
    }
    if start.is_empty() {
        let n = end.parse::<u64>().ok()?.min(total);
        return (n > 0).then_some((total - n, total - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().ok()?.min(total - 1)
    };
    (start <= end && start < total).then_some((start, end))
}
struct Request {
    method: String,
    path: String,
    range: Option<String>,
}
async fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    let mut bytes = Vec::new();
    let mut b = [0_u8; 1];
    while bytes.len() < 8192 {
        if stream.read(&mut b).await? != 1 {
            break;
        }
        bytes.push(b[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| std::io::ErrorKind::InvalidData)?;
    if !text.ends_with("\r\n\r\n") {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default().to_owned();
    let path = first.next().unwrap_or_default().to_owned();
    let mut range = None;
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or(std::io::ErrorKind::InvalidData)?;
        if name.eq_ignore_ascii_case("range") {
            if range.is_some() {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            range = Some(value.trim().to_owned());
        }
    }
    Ok(Request {
        method,
        path,
        range,
    })
}
async fn empty(writer: &mut OwnedWriteHalf, status: &str) -> std::io::Result<()> {
    writer.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").as_bytes()).await
}
async fn headers(
    writer: &mut OwnedWriteHalf,
    status: u16,
    length: u64,
    range: Option<(u64, u64, u64)>,
) -> Result<(), ()> {
    let range = range
        .map(|(a, b, total)| format!("Content-Range: bytes {a}-{b}/{total}\r\n"))
        .unwrap_or_default();
    writer.write_all(format!("HTTP/1.1 {status} {}\r\nContent-Type: video/mp4\r\nContent-Length: {length}\r\n{range}Accept-Ranges: bytes\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nCross-Origin-Resource-Policy: cross-origin\r\nConnection: close\r\n\r\n", if status==206 {"Partial Content"} else {"OK"}).as_bytes()).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::WorkspaceMode;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn auth() -> AuthState {
        let auth = AuthState::default();
        auth.set_workspace_mode(Some(WorkspaceMode::Managed))
            .unwrap();
        let user = serde_json::from_str(
            r#"{"username":"test-reviewer","displayName":"Fixture","role":"operator"}"#,
        )
        .unwrap();
        auth.set_managed_session(user, "fixture-token".into())
            .unwrap();
        auth
    }
    fn fixture_route(server: &OutboundMediaServer, auth: &AuthState, origin: SocketAddr) -> String {
        let token = "a".repeat(64);
        server.routes.lock().unwrap().insert(
            token.clone(),
            Arc::new(Route {
                url: Url::parse(&format!("http://{origin}/video")).unwrap(),
                auth: auth.clone(),
                session: auth.managed_session().unwrap(),
                created: Instant::now(),
                released: AtomicBool::new(false),
                verified: Mutex::new(None),
                inspected: tokio::sync::Mutex::new(None),
                failure: Mutex::new(None),
            }),
        );
        format!("http://{}{PREFIX}{token}", server.address)
    }
    #[test]
    fn only_fixed_private_video_tickets_can_be_registered() {
        let good = format!(
            "https://114.111.19.219/api/platform/manager-outbound/media/{}",
            "a".repeat(64)
        );
        assert!(allowed_url(&good).is_ok());
        for bad in [
            good.replace("https:", "http:"),
            good.replace("114.111.19.219", "127.0.0.1"),
            good.replace("114.111.19.219", "114.111.19.219:8443"),
            good.replace("https://", "https://u:p@"),
            format!("{good}?url=x"),
            format!("{good}#x"),
            good.replace("/media/", "/other/"),
        ] {
            assert!(allowed_url(&bad).is_err());
        }
    }
    #[test]
    fn retiring_tickets_revokes_live_routes_without_touching_other_sessions() {
        tauri::async_runtime::block_on(async {
            let server = OutboundMediaServer::with_client(Client::new()).unwrap();
            let auth = auth();
            let ticket = server
                .register(
                    &auth,
                    auth.managed_session().unwrap(),
                    &format!(
                        "https://114.111.19.219/api/platform/manager-outbound/media/{}",
                        "a".repeat(64)
                    ),
                )
                .unwrap();
            let token = Url::parse(&ticket)
                .unwrap()
                .path()
                .strip_prefix(PREFIX)
                .unwrap()
                .to_owned();
            let route = server.routes.lock().unwrap().get(&token).unwrap().clone();
            let other = AuthState::default();
            other
                .set_workspace_mode(Some(WorkspaceMode::Managed))
                .unwrap();
            let (user, _) = auth.managed_session().unwrap();
            other
                .set_managed_session(user, "different-session".into())
                .unwrap();
            server
                .release(&other, std::slice::from_ref(&ticket))
                .unwrap();
            assert!(route.valid());
            assert!(server
                .release(&auth, &[ticket.replace("127.0.0.1", "example.com")])
                .is_err());
            assert!(route.valid());
            server
                .release(&auth, std::slice::from_ref(&ticket))
                .unwrap();
            assert!(
                !route.valid(),
                "an active request holding the route is cancelled too"
            );
            assert!(server.routes.lock().unwrap().get(&token).is_none());
            server
                .release(&auth, std::slice::from_ref(&ticket))
                .unwrap();
        });
    }
    fn fixture_byte(i: u64) -> u8 {
        b"\0\0\0\x08ftyp\0\0\0\x08moov"
            .get(i as usize)
            .copied()
            .unwrap_or((i % 251) as u8)
    }
    #[test]
    fn paused_browser_body_does_not_expire_healthy_upstream_reads() {
        tauri::async_runtime::block_on(async {
            let fixture = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let origin = fixture.local_addr().unwrap();
            let mut data = vec![0x5a; (WINDOW + 123) as usize];
            data[..16].copy_from_slice(b"\0\0\0\x08ftyp\0\0\0\x08moov");
            let data = Arc::new(data);
            let expected = data.clone();
            let upstream = tokio::spawn(async move {
                while let Ok((mut socket, _)) = fixture.accept().await {
                    let data = data.clone();
                    tokio::spawn(async move {
                        let request = read_request(&mut socket).await.unwrap();
                        let total = data.len() as u64;
                        let (start, end) =
                            requested_range(request.range.as_deref().unwrap(), total).unwrap();
                        let header = format!("HTTP/1.1 206 OK\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n", end-start+1);
                        if socket.write_all(header.as_bytes()).await.is_ok() {
                            let _ = socket.write_all(&data[start as usize..=end as usize]).await;
                        }
                    });
                }
            });
            let source = Client::builder()
                .no_proxy()
                .http1_only()
                .timeout(Duration::from_secs(1))
                .build()
                .unwrap();
            let server = OutboundMediaServer::with_client(source).unwrap();
            let auth = auth();
            let url = fixture_route(&server, &auth, origin);
            let browser = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            let response = browser
                .get(&url)
                .header("Range", "bytes=0-")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 206);
            // Model the decoder not consuming the socket beyond a source
            // request deadline. Source bytes remain fast and available.
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let bytes = response.bytes().await.unwrap();
            assert_eq!(bytes.len(), WINDOW as usize);
            assert!(
                bytes.as_ref() == &expected[..WINDOW as usize],
                "resumed stream must remain exact and ordered"
            );
            assert_eq!(server.status(&auth, &url).unwrap(), None);
            upstream.abort();
        });
    }
    #[test]
    fn frame_clock_uses_video_track_and_rejects_variable_or_truncated_timing() {
        assert!((constant_video_step(&frame_movie(1000, &[100, 100])).unwrap() - 0.1).abs() < 1e-9);
        assert!(constant_video_step(&frame_movie(1000, &[100, 200])).is_none());
        assert!(constant_video_step(&frame_movie(0, &[100])).is_none());
        assert!(constant_video_step(&frame_movie(1000, &[0])).is_none());
        let mut truncated = frame_movie(1000, &[100]);
        truncated.pop();
        assert!(constant_video_step(&truncated).is_none());
        let table = |offsets: &[i32]| {
            let mut bytes = vec![1, 0, 0, 0];
            bytes.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
            for offset in offsets {
                bytes.extend_from_slice(&1_u32.to_be_bytes());
                bytes.extend_from_slice(&offset.to_be_bytes());
            }
            bytes
        };
        assert!(composition_clock(&table(&[100, 200, -200, -100]), 100, 4).is_some());
        assert!(composition_clock(&table(&[100, 200, -200, -50]), 100, 4).is_none());
        assert!(composition_clock(&table(&[100, 200, -200, 0]), 100, 4).is_none());
        assert!(composition_clock(&table(&[100, 200, -200, -100]), 100, 5).is_none());
    }
    fn test_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    }
    fn frame_movie(scale: u32, deltas: &[u32]) -> Vec<u8> {
        let mut hdlr = vec![0; 12];
        hdlr[8..12].copy_from_slice(b"vide");
        let mut clock = vec![0; 24];
        clock[12..16].copy_from_slice(&scale.to_be_bytes());
        let mut stts = vec![0; 4];
        stts.extend_from_slice(&(deltas.len() as u32).to_be_bytes());
        for delta in deltas {
            stts.extend_from_slice(&10_u32.to_be_bytes());
            stts.extend_from_slice(&delta.to_be_bytes());
        }
        let mut media = test_box(b"hdlr", &hdlr);
        media.extend(test_box(b"mdhd", &clock));
        media.extend(test_box(
            b"minf",
            &test_box(b"stbl", &test_box(b"stts", &stts)),
        ));
        let video = test_box(b"trak", &test_box(b"mdia", &media));
        hdlr[8..12].copy_from_slice(b"soun");
        let mut movie = test_box(b"trak", &test_box(b"mdia", &test_box(b"hdlr", &hdlr)));
        movie.extend(video);
        movie
    }
    #[test]
    fn continuous_timeline_reads_real_movie_clocks_without_media_or_foreign_authority() {
        tauri::async_runtime::block_on(async {
            let fixture = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let origin = fixture.local_addr().unwrap();
            let mode = Arc::new(AtomicUsize::new(0));
            let bytes = Arc::new(AtomicUsize::new(0));
            let m = mode.clone();
            let count = bytes.clone();
            let upstream = tokio::spawn(async move {
                while let Ok((mut socket, _)) = fixture.accept().await {
                    let request = read_request(&mut socket).await.unwrap();
                    let mode = m.load(Ordering::SeqCst);
                    let mut payload = vec![0; if mode == 1 { 32 } else { 20 }];
                    payload[0] = u8::from(mode == 1);
                    let scale_at = if mode == 1 { 20 } else { 12 };
                    payload[scale_at..scale_at + 4]
                        .copy_from_slice(&(if mode == 2 { 0_u32 } else { 1000 }).to_be_bytes());
                    if mode == 1 {
                        payload[24..32].copy_from_slice(&12345_u64.to_be_bytes());
                    } else {
                        payload[16..20].copy_from_slice(&12345_u32.to_be_bytes());
                    }
                    let mut movie = test_box(b"mvhd", &payload);
                    movie.extend(frame_movie(
                        1000,
                        if mode == 2 { &[100, 200] } else { &[100] },
                    ));
                    let tail = test_box(b"moov", &movie);
                    let moov = 512 * PART;
                    let total = if mode == 3 {
                        moov
                    } else {
                        moov + tail.len() as u64
                    };
                    let (start, end) =
                        requested_range(request.range.as_deref().unwrap(), total).unwrap();
                    let mut prefix = 8_u32.to_be_bytes().to_vec();
                    prefix.extend_from_slice(b"ftyp");
                    prefix.extend_from_slice(&((moov - 8) as u32).to_be_bytes());
                    prefix.extend_from_slice(b"mdat");
                    let body: Vec<u8> = (start..=end)
                        .map(|i| {
                            if i < 16 {
                                prefix[i as usize]
                            } else if i >= moov {
                                tail[(i - moov) as usize]
                            } else {
                                0
                            }
                        })
                        .collect();
                    count.fetch_add(body.len(), Ordering::SeqCst);
                    socket.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
                    socket.write_all(&body).await.unwrap();
                }
            });
            let server = OutboundMediaServer::with_client(Client::new()).unwrap();
            let identity = auth();
            for mode_value in 0..4 {
                mode.store(mode_value, Ordering::SeqCst);
                bytes.store(0, Ordering::SeqCst);
                let url = fixture_route(&server, &identity, origin);
                let result = server.metadata(&identity, &url).await;
                if mode_value < 2 {
                    assert!((result.unwrap() - 12.345).abs() < 0.000001);
                } else {
                    assert!(result.is_err());
                }
                assert!(
                    bytes.load(Ordering::SeqCst) < 66000,
                    "skip the 512 MiB mdat with bounded headers"
                );
                bytes.store(0, Ordering::SeqCst);
                let step = server.frame_step(&identity, &url).await.unwrap();
                if mode_value < 2 {
                    assert!((step.unwrap() - 0.1).abs() < 1e-9);
                } else {
                    assert_eq!(step, None);
                }
                assert!(
                    bytes.load(Ordering::SeqCst) < 66000,
                    "frame clock skips media payload too"
                );
                let before = bytes.load(Ordering::SeqCst);
                let other = auth();
                let (user, _) = other.managed_session().unwrap();
                other
                    .set_managed_session(user, "different-token".into())
                    .unwrap();
                assert!(server.metadata(&other, &url).await.is_err());
                assert!(server.frame_step(&other, &url).await.is_err());
                assert!(server
                    .metadata(&identity, &url.replace("127.0.0.1", "example.com"))
                    .await
                    .is_err());
                server
                    .release(&identity, std::slice::from_ref(&url))
                    .unwrap();
                assert!(server.metadata(&identity, &url).await.is_err());
                assert!(server.frame_step(&identity, &url).await.is_err());
                assert_eq!(
                    bytes.load(Ordering::SeqCst),
                    before,
                    "rejected authority never reads upstream"
                );
            }
            upstream.abort();
        });
    }
    #[test]
    fn missing_mp4_index_is_detected_without_downloading_the_video() {
        tauri::async_runtime::block_on(async {
            let fixture = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let origin = fixture.local_addr().unwrap();
            let mode = Arc::new(AtomicUsize::new(0));
            let read_bytes = Arc::new(AtomicUsize::new(0));
            let m = mode.clone();
            let count = read_bytes.clone();
            let upstream = tokio::spawn(async move {
                while let Ok((mut socket, _)) = fixture.accept().await {
                    let request = read_request(&mut socket).await.unwrap();
                    let mode = m.load(Ordering::SeqCst);
                    if mode >= 3 {
                        let status = if mode == 3 {
                            "503 Unavailable"
                        } else {
                            "403 Forbidden"
                        };
                        socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                        continue;
                    }
                    let total = 512 * 1024 * 1024_u64;
                    let (start, end) =
                        requested_range(request.range.as_deref().unwrap(), total).unwrap();
                    let mut body = vec![0_u8; (end - start + 1) as usize];
                    let mdat_size = match mode {
                        0 => total - 16,
                        1 => total - 8,
                        _ => total,
                    };
                    let prefix = [
                        8_u32.to_be_bytes().as_slice(),
                        b"ftyp",
                        (mdat_size as u32).to_be_bytes().as_slice(),
                        b"mdat",
                    ]
                    .concat();
                    let tail = [8_u32.to_be_bytes().as_slice(), b"moov"].concat();
                    for (i, byte) in body.iter_mut().enumerate() {
                        let offset = start + i as u64;
                        if offset < prefix.len() as u64 {
                            *byte = prefix[offset as usize];
                        }
                        if mode == 0 && offset >= total - 8 {
                            *byte = tail[(offset - (total - 8)) as usize];
                        }
                    }
                    count.fetch_add(body.len(), Ordering::SeqCst);
                    let header = format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n",body.len());
                    socket.write_all(header.as_bytes()).await.unwrap();
                    let _ = socket.write_all(&body).await;
                }
            });
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let server = OutboundMediaServer::with_client(client.clone()).unwrap();
            let auth = auth();
            let url = fixture_route(&server, &auth, origin);
            let route = server
                .routes
                .lock()
                .unwrap()
                .get(&"a".repeat(64))
                .unwrap()
                .clone();
            server.inspect_mp4(&route).await.unwrap();
            assert!(
                read_bytes.load(Ordering::SeqCst) <= 65552,
                "tail index is found by skipping 512 MiB of payload"
            );
            let before = read_bytes.load(Ordering::SeqCst);
            server.inspect_mp4(&route).await.unwrap();
            assert_eq!(read_bytes.load(Ordering::SeqCst), before);
            assert_eq!(server.status(&auth, &url).unwrap(), None);
            for (value, code) in [
                (1, "OUTBOUND_MEDIA_INDEX_MISSING"),
                (2, "OUTBOUND_MEDIA_CONTAINER_INVALID"),
                (3, "OUTBOUND_MEDIA_BUSY"),
                (4, "OUTBOUND_MEDIA_EXPIRED"),
            ] {
                mode.store(value, Ordering::SeqCst);
                read_bytes.store(0, Ordering::SeqCst);
                let url = fixture_route(&server, &auth, origin);
                assert!(client
                    .get(&url)
                    .header("Range", "bytes=0-")
                    .send()
                    .await
                    .is_err());
                assert_eq!(server.status(&auth, &url).unwrap(), Some(code));
                assert!(read_bytes.load(Ordering::SeqCst) <= 65536);
            }
            let other = self::auth();
            let (user, _) = other.managed_session().unwrap();
            other
                .set_managed_session(user, "another-session".into())
                .unwrap();
            assert!(server.status(&other, &url).is_err());
            assert!(server
                .status(&auth, &url.replace("127.0.0.1", "example.com"))
                .is_err());
            assert!(mp4_box(&[0, 0, 0, 4], 0, 4).is_none());
            assert!(mp4_box(b"\0\0\0\x01mdat\0\0\0\0\0\0\0\x10", 0, 16).is_some());
            upstream.abort();
        });
    }
    #[test]
    fn seven_cameras_ranges_integrity_logout_and_disconnect() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        tauri::async_runtime::block_on(async {
            let fixture = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let origin = fixture.local_addr().unwrap();
            let mode = Arc::new(AtomicUsize::new(0));
            let active = Arc::new(AtomicUsize::new(0));
            let starts = Arc::new(AtomicUsize::new(0));
            let m = mode.clone();
            let a = active.clone();
            let started = starts.clone();
            // Build the immutable fixture before request deadlines start. Seven
            // clients must measure transport, rather than regenerate 112 MiB
            // of debug-build pattern data while other native tests run.
            let fixture_bytes = Arc::new((0..17 * PART + 17).map(fixture_byte).collect::<Vec<_>>());
            let upstream = tokio::spawn(async move {
                while let Ok((mut socket, _)) = fixture.accept().await {
                    let m = m.clone();
                    let a = a.clone();
                    let started = started.clone();
                    let fixture_bytes = fixture_bytes.clone();
                    tokio::spawn(async move {
                        let request = read_request(&mut socket).await.unwrap();
                        let mode = m.load(Ordering::SeqCst);
                        if mode == 6 {
                            started.fetch_add(1, Ordering::SeqCst);
                            while started.load(Ordering::SeqCst) < 4 {
                                tokio::time::sleep(Duration::from_millis(2)).await;
                            }
                        }
                        if mode == 4 {
                            a.fetch_add(1, Ordering::SeqCst);
                            let mut b = [0; 1];
                            let _ = socket.read(&mut b).await;
                            a.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        let total = fixture_bytes.len() as u64;
                        let (start, end) = request
                            .range
                            .as_deref()
                            .and_then(|v| requested_range(v, total))
                            .unwrap_or((0, total - 1));
                        let status = if request.range.is_some() { 206 } else { 200 };
                        let bad = mode == 1;
                        let changed = mode == 3 && start >= PART;
                        let header=format!("HTTP/1.1 {status} OK\r\nContent-Length: {}\r\n{}ETag: \"{}\"\r\nConnection: close\r\n\r\n",end-start+1,
                            if status==206{format!("Content-Range: bytes {}-{end}/{total}\r\n",if bad {start+1}else{start})}else{String::new()},if changed{"changed"}else{"fixture"});
                        if socket.write_all(header.as_bytes()).await.is_err() {
                            return;
                        }
                        if request.method == "HEAD" {
                            return;
                        }
                        let bytes = &fixture_bytes[start as usize..=end as usize];
                        let bytes = if mode == 2 {
                            &bytes[..11.min(bytes.len())]
                        } else {
                            bytes
                        };
                        let _ = socket.write_all(bytes).await;
                    });
                }
            });
            let client = Client::builder()
                .http1_only()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let server = OutboundMediaServer::with_client(client.clone()).unwrap();
            let auth = auth();
            let url = fixture_route(&server, &auth, origin);
            // Drain every camera concurrently, as the real seven players do.
            // Per-byte assertions run after every body finishes, so checking
            // one camera cannot consume another camera's request deadline.
            let bodies = futures_util::future::join_all((0..7).map(|_| async {
                let response = client
                    .get(&url)
                    .header("Range", "bytes=0-")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 206);
                assert_eq!(
                    response.headers()["content-range"],
                    format!("bytes 0-{}/{}", WINDOW - 1, 17 * PART + 17)
                );
                response.bytes().await.unwrap()
            }))
            .await;
            for bytes in bodies {
                assert_eq!(bytes.len(), WINDOW as usize);
                assert!(
                    bytes
                        .iter()
                        .enumerate()
                        .all(|(i, b)| *b == fixture_byte(i as u64)),
                    "parallel chunks remain ordered and exact"
                );
            }
            let head = client.head(&url).send().await.unwrap();
            assert_eq!(head.status(), 200);
            assert_eq!(
                head.headers()["content-length"],
                (17 * PART + 17).to_string()
            );
            assert_eq!(head.bytes().await.unwrap().len(), 0);
            for range in ["bytes=7-81", "bytes=-57", "bytes=17825792-"] {
                let response = client
                    .get(&url)
                    .header("Range", range)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status(), 206);
                let (start, end) = requested_range(range, 17 * PART + 17).unwrap();
                assert_eq!(
                    response.bytes().await.unwrap().as_ref(),
                    (start..=end).map(fixture_byte).collect::<Vec<_>>()
                );
            }
            assert_eq!(
                client
                    .get(&url)
                    .header("Range", "bytes=0-1,7-9")
                    .send()
                    .await
                    .unwrap()
                    .status(),
                416
            );
            assert_eq!(client.post(&url).send().await.unwrap().status(), 405);
            mode.store(6, Ordering::SeqCst);
            let parallel = client
                .get(&url)
                .header("Range", "bytes=0-")
                .send()
                .await
                .unwrap();
            assert_eq!(parallel.bytes().await.unwrap().len(), WINDOW as usize);
            assert_eq!(
                starts.load(Ordering::SeqCst),
                16,
                "all four verified block requests dispatch before any body is available"
            );
            for bad in [1, 2, 3] {
                mode.store(bad, Ordering::SeqCst);
                match client.get(&url).header("Range", "bytes=0-").send().await {
                    Err(_) => {}
                    Ok(response) => assert!(
                        response.bytes().await.is_err(),
                        "bad ranges/short bodies/source changes never become valid MP4s"
                    ),
                }
            }
            mode.store(4, Ordering::SeqCst);
            let mut raw = TcpStream::connect(server.address).await.unwrap();
            let path = Url::parse(&url).unwrap().path().to_owned();
            raw.write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while active.load(Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            drop(raw);
            tokio::time::timeout(Duration::from_secs(2), async {
                while active.load(Ordering::SeqCst) > 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let request = client.get(&url).header("Range", "bytes=0-").send();
            tokio::pin!(request);
            tokio::select! {r=&mut request=>panic!("unexpected {r:?}"),_ = tokio::time::sleep(Duration::from_millis(100))=>{}}
            auth.set_user(None).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_secs(1), request)
                    .await
                    .unwrap()
                    .is_err(),
                "logout cancels an in-flight private read"
            );
            assert_eq!(
                client.get(&url).send().await.unwrap().status(),
                403,
                "old route cannot be reused after logout"
            );
            mode.store(0, Ordering::SeqCst);
            upstream.abort();
        });
    }
}
