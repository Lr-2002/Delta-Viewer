//! Local-only HTTP fixtures for OTA and diagnostic protocol regression.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::JoinHandle;

pub struct Reply {
    pub method: &'static str,
    pub path: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
pub fn serve(replies: Vec<Reply>) -> (String, JoinHandle<Vec<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(e) => panic!("fixture accept failed: {e}"),
                }
            };
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                let mut bytes = [0; 4096];
                let read = stream.read(&mut bytes).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&bytes[..read]);
                assert!(request.len() < 2 * 1024 * 1024);
                if let Some(end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let header = String::from_utf8_lossy(&request[..header_end]);
            assert_eq!(
                header.lines().next().unwrap(),
                format!("{} {} HTTP/1.1", reply.method, reply.path)
            );
            let size = header
                .lines()
                .find_map(|line| {
                    let (k, v) = line.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + size {
                let mut bytes = [0; 4096];
                let read = stream.read(&mut bytes).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&bytes[..read]);
            }
            requests.push(request);
            write!(
                stream,
                "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
                reply.status,
                reply.body.len()
            )
            .unwrap();
            for (k, v) in reply.headers {
                write!(stream, "{k}: {v}\r\n").unwrap();
            }
            stream.write_all(b"\r\n").unwrap();
            stream.write_all(&reply.body).unwrap();
        }
        requests
    });
    (url, worker)
}
