//! Bounded, cancellable GET retries for public GitHub update data only.
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use std::error::Error as _;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const ATTEMPTS: usize = 3;

pub(super) struct Request<'a> {
    pub url: &'a Url,
    pub limit: u64,
    pub expected: Option<u64>,
    pub stage: &'a str,
    pub cancelled: Option<&'a AtomicBool>,
}

enum Failure {
    Network(reqwest::Error),
    Invalid(AppError),
}
impl From<reqwest::Error> for Failure {
    fn from(error: reqwest::Error) -> Self {
        Self::Network(error)
    }
}

fn cancelled(flag: Option<&AtomicBool>) -> AppResult<()> {
    if flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

async fn interruptible<T>(
    future: impl Future<Output = T>,
    flag: Option<&AtomicBool>,
) -> AppResult<T> {
    cancelled(flag)?;
    let mut future = std::pin::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep(Duration::from_millis(100)), if flag.is_some() => cancelled(flag)?,
        }
    }
}

fn certificate_failure(error: &reqwest::Error) -> bool {
    let mut source = error.source();
    // Inspect causes for classification, never display URLs, proxy credentials
    // or signed CDN query strings from a transport error's source chain.
    for _ in 0..8 {
        let Some(cause) = source else { break };
        let text = cause.to_string().to_ascii_lowercase();
        if ["certificate", "cert_e_", "sec_e_untrusted", "unknownissuer"]
            .iter()
            .any(|needle| text.contains(needle))
        {
            return true;
        }
        source = cause.source();
    }
    false
}

fn retryable(error: &reqwest::Error) -> bool {
    if error.is_builder() || error.is_redirect() || certificate_failure(error) {
        return false;
    }
    if let Some(status) = error.status() {
        return matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504);
    }
    // reqwest 0.13 classifies an incomplete HTTP body as a decode error.
    // JSON parsing is outside this function and never retried as transport.
    error.is_timeout()
        || error.is_connect()
        || error.is_body()
        || error.is_request()
        || error.is_decode()
}

fn explain(error: &reqwest::Error) -> String {
    if let Some(status) = error.status() {
        let reason = match status.as_u16() {
            403 => "GitHub 拒绝访问或 API 额度已用尽",
            404 => "正式版本或更新资产不存在",
            407 => "系统代理要求身份验证",
            429 => "GitHub 请求受到限流",
            500..=599 => "GitHub 服务暂时异常",
            _ => "GitHub 返回请求错误",
        };
        return format!("{reason}（HTTP {}）", status.as_u16());
    }
    if error.is_timeout() {
        "连接或读取超时".into()
    } else if certificate_failure(error) {
        "HTTPS 证书验证失败，请检查系统时间、证书及代理设置".into()
    } else if error.is_redirect() {
        "下载跳转超出允许的官方 HTTPS 地址".into()
    } else if error.is_connect() {
        "无法建立连接，请检查网络、DNS 及系统代理".into()
    } else if error.is_body() || error.is_request() || error.is_decode() {
        "连接中断或响应未完整收到".into()
    } else {
        "原因未知，请检查网络后重试；不能据此判定为断网".into()
    }
}

async fn recover(failure: Failure, request: &Request<'_>, attempt: usize) -> AppResult<()> {
    match failure {
        Failure::Invalid(error) => Err(error),
        Failure::Network(error) => {
            if attempt >= ATTEMPTS || !retryable(&error) {
                return Err(AppError::Message(format!(
                    "UPDATE_NETWORK_FAILED: {}失败：{}（服务：{}，已尝试 {attempt} 次）。可稍后重试",
                    request.stage,
                    explain(&error),
                    request.url.host_str().unwrap_or("GitHub"),
                )));
            }
            interruptible(
                tokio::time::sleep(Duration::from_millis(300 * attempt as u64)),
                request.cancelled,
            )
            .await
        }
    }
}

pub(super) async fn bytes(
    client: &Client,
    request: Request<'_>,
    mut progress: impl FnMut(u64, usize),
) -> AppResult<Vec<u8>> {
    for attempt in 1..=ATTEMPTS {
        cancelled(request.cancelled)?;
        // A failed attempt's partial response is discarded, never cached or
        // appended to the next request. Verification still runs after success.
        progress(0, attempt);
        let result = async {
            let response = interruptible(client.get(request.url.clone()).send(), request.cancelled)
                .await
                .map_err(Failure::Invalid)??
                .error_for_status()?;
            if response.content_length().is_some_and(|size| {
                size > request.limit || request.expected.is_some_and(|expected| size != expected)
            }) {
                return Err(Failure::Invalid(super::update_manifest_error(
                    "更新响应大小不符合清单或超过上限",
                )));
            }
            let mut bytes = Vec::new();
            let mut chunks = response.bytes_stream();
            while let Some(chunk) = interruptible(chunks.next(), request.cancelled)
                .await
                .map_err(Failure::Invalid)?
            {
                let chunk = chunk?;
                if bytes.len() as u64 + chunk.len() as u64 > request.limit {
                    return Err(Failure::Invalid(super::update_manifest_error(
                        "更新响应超过大小限制",
                    )));
                }
                bytes.extend_from_slice(&chunk);
                progress(bytes.len() as u64, attempt);
            }
            if request
                .expected
                .is_some_and(|size| size != bytes.len() as u64)
            {
                return Err(Failure::Invalid(super::update_manifest_error(
                    "更新包未完整收到，大小与清单不符",
                )));
            }
            Ok(bytes)
        }
        .await;
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(failure) => recover(failure, &request, attempt).await?,
        }
    }
    unreachable!("last failed attempt returns an error")
}

pub(super) async fn head(client: &Client, url: &Url) -> AppResult<Response> {
    let request = Request {
        url,
        limit: 0,
        expected: None,
        stage: "查询官方最新版本",
        cancelled: None,
    };
    for attempt in 1..=ATTEMPTS {
        match client
            .head(url.clone())
            .send()
            .await
            .and_then(Response::error_for_status)
        {
            Ok(response) => return Ok(response),
            Err(error) => recover(Failure::Network(error), &request, attempt).await?,
        }
    }
    unreachable!("last failed attempt returns an error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{atomic::AtomicUsize, Arc};

    enum Reply {
        Data(&'static str),
        Slow(Duration),
    }

    fn server(replies: Vec<Reply>) -> (Url, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
        #[cfg(not(target_os = "windows"))]
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!(
            "http://{}/metadata",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let counted = count.clone();
        let thread = std::thread::spawn(move || {
            for reply in replies {
                let deadline = std::time::Instant::now() + Duration::from_secs(4);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "expected request was not received"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("accept: {error}"),
                    }
                };
                // Winsock accepts inherit the listener's nonblocking mode.
                // This thread intentionally waits for the complete request;
                // an early WouldBlock must not consume a scripted response.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                let mut received = 0;
                while !request[..received].windows(4).any(|end| end == b"\r\n\r\n") {
                    assert!(received < request.len(), "test request headers too large");
                    let size = stream.read(&mut request[received..]).unwrap();
                    assert!(size > 0, "test client closed before completing headers");
                    received += size;
                }
                counted.fetch_add(1, Ordering::SeqCst);
                match reply {
                    Reply::Data(response) => {
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Reply::Slow(duration) => std::thread::sleep(duration),
                }
            }
        });
        (url, count, thread)
    }
    fn client(timeout: Duration) -> Client {
        Client::builder()
            .no_proxy()
            .timeout(timeout)
            .build()
            .unwrap()
    }
    fn request(url: &Url) -> Request<'_> {
        Request {
            url,
            limit: 64,
            expected: None,
            stage: "读取更新清单",
            cancelled: None,
        }
    }
    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    #[test]
    fn loopback_server_waits_for_complete_fragmented_request_headers() {
        let (url, count, worker) = server(vec![Reply::Data(OK)]);
        let mut client = std::net::TcpStream::connect(("127.0.0.1", url.port().unwrap())).unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        client
            .write_all(b"GET /metadata HTTP/1.1\r\nHost: localhost\r\n")
            .unwrap();
        let mut byte = [0];
        let error = client.read(&mut byte).unwrap_err();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        client.write_all(b"\r\n").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert_eq!(response, OK);
        worker.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn retries_service_failure_and_connection_drop_then_succeeds() {
        tauri::async_runtime::block_on(async {
            let (url, count, worker) = server(vec![
                Reply::Data(
                    "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                ),
                Reply::Data(""),
                Reply::Data(OK),
            ]);
            assert_eq!(
                bytes(&client(Duration::from_secs(1)), request(&url), |_, _| {})
                    .await
                    .unwrap(),
                b"ok"
            );
            worker.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 3);
        });
    }

    #[test]
    fn timed_out_request_retries_and_recovers() {
        tauri::async_runtime::block_on(async {
            let (url, count, worker) = server(vec![
                Reply::Slow(Duration::from_millis(400)),
                Reply::Data(OK),
            ]);
            assert_eq!(
                bytes(
                    &client(Duration::from_millis(250)),
                    request(&url),
                    |_, _| {}
                )
                .await
                .unwrap(),
                b"ok"
            );
            worker.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn interrupted_download_restarts_without_appending_partial_bytes() {
        tauri::async_runtime::block_on(async {
            let (url, count, worker) = server(vec![
                Reply::Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nx"),
                Reply::Data(OK),
            ]);
            let mut progress = Vec::new();
            let mut request = request(&url);
            request.limit = 2;
            request.expected = Some(2);
            let result = bytes(&client(Duration::from_secs(1)), request, |n, a| {
                progress.push((n, a))
            })
            .await
            .unwrap();
            assert_eq!(result, b"ok");
            assert!(progress.contains(&(0, 2)));
            worker.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn permanent_http_errors_do_not_retry_or_masquerade_as_offline() {
        tauri::async_runtime::block_on(async {
            for (response, expected) in [
                (
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
                    "资产不存在",
                ),
                (
                    "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
                    "拒绝访问",
                ),
            ] {
                let (url, count, worker) = server(vec![Reply::Data(response)]);
                let error = bytes(&client(Duration::from_secs(1)), request(&url), |_, _| {})
                    .await
                    .unwrap_err()
                    .to_string();
                assert!(error.contains(expected), "{error}");
                assert!(error.contains("已尝试 1 次"));
                worker.join().unwrap();
                assert_eq!(count.load(Ordering::SeqCst), 1);
            }
        });
    }

    #[test]
    fn retry_budget_ends_and_error_names_stage_and_timeout() {
        tauri::async_runtime::block_on(async {
            let (url, count, worker) = server(
                (0..3)
                    .map(|_| Reply::Slow(Duration::from_millis(100)))
                    .collect(),
            );
            let error = bytes(&client(Duration::from_millis(40)), request(&url), |_, _| {})
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains("读取更新清单失败"));
            assert!(error.contains("超时"));
            assert!(error.contains("已尝试 3 次"));
            worker.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 3);
        });
    }

    #[test]
    fn invalid_sizes_and_disallowed_redirects_are_not_retried() {
        tauri::async_runtime::block_on(async {
            for response in [
                "HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n",
                "HTTP/1.1 302 Found\r\nLocation: http://evil.test/asset\r\nContent-Length: 0\r\n\r\n",
            ] {
                let (url,count,worker)=server(vec![Reply::Data(response)]);
                let client=Client::builder().no_proxy().redirect(super::super::redirects()).build().unwrap();
                assert!(bytes(&client,request(&url),|_,_|{}).await.is_err());
                worker.join().unwrap(); assert_eq!(count.load(Ordering::SeqCst),1);
            }
        });
    }

    #[test]
    fn cancellation_interrupts_waiting_for_headers() {
        tauri::async_runtime::block_on(async {
            let (url, count, worker) = server(vec![Reply::Slow(Duration::from_secs(1))]);
            let flag = Arc::new(AtomicBool::new(false));
            let trigger = flag.clone();
            let cancel = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while count.load(Ordering::SeqCst) == 0 {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "request did not start"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                std::thread::sleep(Duration::from_millis(50));
                trigger.store(true, Ordering::SeqCst)
            });
            let mut request = request(&url);
            request.cancelled = Some(&flag);
            let start = std::time::Instant::now();
            assert!(matches!(
                bytes(&client(Duration::from_secs(5)), request, |_, _| {}).await,
                Err(AppError::Cancelled)
            ));
            assert!(start.elapsed() < Duration::from_millis(900));
            cancel.join().unwrap();
            worker.join().unwrap();
        });
    }

    #[test]
    fn official_latest_head_retries_without_following_redirect() {
        tauri::async_runtime::block_on(async {
            let (url,count,worker)=server(vec![
                Reply::Data("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                Reply::Data("HTTP/1.1 302 Found\r\nLocation: https://github.com/Lr-2002/Delta-Viewer/releases/tag/v1.1.0\r\nContent-Length: 0\r\n\r\n"),
            ]);
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let response = head(&client, &url).await.unwrap();
            assert_eq!(response.status().as_u16(), 302);
            worker.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 2);
        });
    }
}
