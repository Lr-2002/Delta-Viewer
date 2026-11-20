use std::io;
use std::net::{Ipv4Addr, TcpListener};

// Chromium permits only six HTTP/1.1 connections to one origin. Each camera
// needs its own origin so a long, backpressured response cannot queue another
// camera behind six healthy streams. All listeners remain loopback-only.
pub const CAMERA_COUNT: usize = 7;

pub fn bind() -> io::Result<Vec<TcpListener>> {
    (0..CAMERA_COUNT)
        .map(|_| TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))
        .collect()
}

pub fn camera_lane(stream: &str) -> usize {
    match stream {
        "cam1" => 1,
        "cam2" => 2,
        "t265_left" => 3,
        "t265_right" => 4,
        "extension_left" | "stereo_left" => 5,
        "extension_right" | "stereo_right" => 6,
        _ => 0,
    }
}
