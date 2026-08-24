use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Clone)]
pub struct MediaStreamServer {
    address: SocketAddrV4,
    nonce: [u8; 32],
    routes: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl MediaStreamServer {
    pub fn start() -> AppResult<Self> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        let address = match listener.local_addr()? {
            std::net::SocketAddr::V4(address) => address,
            _ => return Err(AppError::Message("本机媒体流没有绑定 IPv4 回环地址".into())),
        };
        let mut nonce = [0_u8; 32];
        getrandom::fill(&mut nonce)
            .map_err(|_| AppError::Message("无法生成本机媒体流安全令牌".into()))?;
        let routes = Arc::new(Mutex::new(HashMap::new()));
        let server_routes = routes.clone();
        thread::Builder::new()
            .name("dohc-media-stream".into())
            .spawn(move || {
                for connection in listener.incoming() {
                    let Ok(stream) = connection else {
                        continue;
                    };
                    let routes = server_routes.clone();
                    let _ = thread::Builder::new()
                        .name("dohc-media-response".into())
                        .spawn(move || {
                            let _ = serve_connection(stream, &routes);
                        });
                }
            })?;
        Ok(Self {
            address,
            nonce,
            routes,
        })
    }

    pub fn register(&self, path: &Path) -> AppResult<String> {
        let canonical = path.canonicalize()?;
        if !canonical.is_file() {
            return Err(AppError::MissingPath(canonical.display().to_string()));
        }
        let mut hasher = blake3::Hasher::new();
        hasher.update(&self.nonce);
        hasher.update(canonical.as_os_str().as_encoded_bytes());
        let token = hasher.finalize().to_hex().to_string();
        self.routes
            .lock()
            .map_err(|_| AppError::Message("本机媒体流路由不可用".into()))?
            .insert(token.clone(), canonical);
        Ok(format!("http://{}/media/{token}", self.address))
    }
}

fn serve_connection(
    mut stream: TcpStream,
    routes: &Arc<Mutex<HashMap<String, PathBuf>>>,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let request = read_request(&stream)?;
    let Some(request) = request else {
        return Ok(());
    };
    if request.method == "OPTIONS" {
        return write_empty_response(&mut stream, "204 No Content", &[]);
    }
    if request.method != "GET" && request.method != "HEAD" {
        return write_empty_response(&mut stream, "405 Method Not Allowed", &[]);
    }
    let Some(token) = request.path.strip_prefix("/media/") else {
        return write_empty_response(&mut stream, "404 Not Found", &[]);
    };
    if token.is_empty() || !token.bytes().all(|value| value.is_ascii_hexdigit()) {
        return write_empty_response(&mut stream, "404 Not Found", &[]);
    }
    let path = routes
        .lock()
        .ok()
        .and_then(|routes| routes.get(token).cloned());
    let Some(path) = path else {
        return write_empty_response(&mut stream, "404 Not Found", &[]);
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return write_empty_response(&mut stream, "404 Not Found", &[]),
    };
    let total = file.metadata()?.len();
    let (start, end, partial) = match parse_range(request.range.as_deref(), total) {
        Ok(range) => range,
        Err(()) => {
            return write_empty_response(
                &mut stream,
                "416 Range Not Satisfiable",
                &[("Content-Range", format!("bytes */{total}"))],
            )
        }
    };
    let length = end.saturating_sub(start).saturating_add(1);
    let status = if partial {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let mut headers = vec![
        ("Accept-Ranges", "bytes".to_string()),
        ("Content-Type", "video/mp4".to_string()),
        ("Content-Length", length.to_string()),
        ("Cache-Control", "private, max-age=3600".to_string()),
    ];
    if partial {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{total}")));
    }
    write_headers(&mut stream, status, &headers)?;
    if request.method == "HEAD" {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    io::copy(&mut file.take(length), &mut stream)?;
    Ok(())
}

struct MediaRequest {
    method: String,
    path: String,
    range: Option<String>,
}

fn read_request(stream: &TcpStream) -> io::Result<Option<MediaRequest>> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let Some(first_line) = read_bounded_line(&mut reader)? else {
        return Ok(None);
    };
    let mut parts = first_line.split_whitespace();
    let Some(method) = parts.next() else {
        return Ok(None);
    };
    let Some(path) = parts.next() else {
        return Ok(None);
    };
    let mut range = None;
    let mut total_header_bytes = first_line.len();
    while let Some(line) = read_bounded_line(&mut reader)? {
        total_header_bytes = total_header_bytes.saturating_add(line.len());
        if total_header_bytes > 32 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "media request headers exceed limit",
            ));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }
    Ok(Some(MediaRequest {
        method: method.to_string(),
        path: path.to_string(),
        range,
    }))
}

fn read_bounded_line(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    const MAX_LINE_BYTES: u64 = 8192;
    let mut line = String::new();
    let bytes_read = reader
        .by_ref()
        .take(MAX_LINE_BYTES + 1)
        .read_line(&mut line)?;
    if bytes_read == 0 {
        return Ok(None);
    }
    if bytes_read as u64 > MAX_LINE_BYTES || !line.ends_with('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "media request line exceeds limit",
        ));
    }
    Ok(Some(line))
}

fn parse_range(value: Option<&str>, total: u64) -> Result<(u64, u64, bool), ()> {
    if total == 0 {
        return Err(());
    }
    let Some(value) = value else {
        return Ok((0, total - 1, false));
    };
    let bytes = value.strip_prefix("bytes=").ok_or(())?;
    if bytes.contains(',') {
        return Err(());
    }
    let (start, end) = bytes.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?.min(total);
        if suffix == 0 {
            return Err(());
        }
        return Ok((total - suffix, total - 1, true));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= total {
        return Err(());
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(total - 1)
    };
    if end < start {
        return Err(());
    }
    Ok((start, end, true))
}

fn write_empty_response(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
) -> io::Result<()> {
    let mut headers = headers.to_vec();
    headers.push(("Content-Length", "0".into()));
    write_headers(stream, status, &headers)
}

fn write_headers(
    stream: &mut TcpStream,
    status: &str,
    headers: &[(&str, String)],
) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\n")?;
    write!(stream, "Access-Control-Allow-Origin: *\r\n")?;
    write!(stream, "Access-Control-Allow-Headers: Range\r\n")?;
    write!(stream, "Connection: close\r\n")?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "\r\n")?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::{parse_range, MediaStreamServer};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_browser_byte_ranges() {
        assert_eq!(parse_range(None, 100), Ok((0, 99, false)));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok((10, 19, true)));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Ok((90, 99, true)));
        assert_eq!(parse_range(Some("bytes=-5"), 100), Ok((95, 99, true)));
        assert!(parse_range(Some("bytes=100-"), 100).is_err());
    }

    #[test]
    fn serves_only_registered_files_with_range_support() {
        let root = std::env::temp_dir().join(format!(
            "dohc-media-stream-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("preview.mp4");
        fs::write(&path, b"0123456789").unwrap();
        let server = MediaStreamServer::start().unwrap();
        let url = server.register(&path).unwrap();
        let address_and_path = url.strip_prefix("http://").unwrap();
        let (address, request_path) = address_and_path.split_once('/').unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET /{request_path} HTTP/1.1\r\nHost: {address}\r\nRange: bytes=3-6\r\n\r\n"
        )
        .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let separator = response
            .windows(4)
            .position(|value| value == b"\r\n\r\n")
            .unwrap();
        assert!(String::from_utf8_lossy(&response[..separator]).contains("206 Partial Content"));
        assert_eq!(&response[separator + 4..], b"3456");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires DOHC_MP4_SAMPLE_ROOT and GStreamer"]
    fn gstreamer_discovers_the_real_camera_zero_loopback_stream() {
        let root = PathBuf::from(
            std::env::var_os("DOHC_MP4_SAMPLE_ROOT")
                .expect("DOHC_MP4_SAMPLE_ROOT must point to an MP4 episode"),
        );
        let path = root.join("cam0/cam0-00000.mp4");
        let server = MediaStreamServer::start().unwrap();
        let url = server.register(&path).unwrap();
        let output = Command::new("gst-discoverer-1.0")
            .arg(&url)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("video"));
        assert!(stdout.contains("H.264"));
    }
}
