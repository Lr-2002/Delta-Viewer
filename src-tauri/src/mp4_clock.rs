//! Read a constant-frame-rate MP4 clock without launching seven decoder processes.
//! mdat is skipped; only bounded atom headers and stts entries are read.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
fn u32be(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().unwrap())
}
fn children(file: &mut File, start: u64, end: u64) -> Option<Vec<([u8; 4], u64, u64)>> {
    let mut pos = start;
    let mut result = Vec::new();
    while pos + 8 <= end && result.len() < 128 {
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut header = [0; 8];
        file.read_exact(&mut header).ok()?;
        let mut size = u32be(&header[..4]) as u64;
        let mut head = 8;
        if size == 1 {
            let mut wide = [0; 8];
            file.read_exact(&mut wide).ok()?;
            size = u64::from_be_bytes(wide);
            head = 16;
        }
        if size == 0 {
            size = end - pos;
        }
        if size < head || size > end - pos {
            return None;
        }
        result.push((header[4..8].try_into().ok()?, pos + head, pos + size));
        pos += size;
    }
    (pos == end).then_some(result)
}
fn child(file: &mut File, start: u64, end: u64, kind: &[u8; 4]) -> Option<(u64, u64)> {
    children(file, start, end)?
        .into_iter()
        .find(|item| &item.0 == kind)
        .map(|item| (item.1, item.2))
}
pub fn fps(path: &Path) -> Option<f64> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let (moov, end) = child(&mut file, 0, len, b"moov")?;
    for (_, start, end) in children(&mut file, moov, end)?
        .into_iter()
        .filter(|item| &item.0 == b"trak")
    {
        let Some((mdia, end)) = child(&mut file, start, end, b"mdia") else {
            continue;
        };
        let (hdlr, hdlr_end) = child(&mut file, mdia, end, b"hdlr")?;
        if hdlr_end - hdlr < 12 {
            return None;
        }
        file.seek(SeekFrom::Start(hdlr + 8)).ok()?;
        let mut kind = [0; 4];
        file.read_exact(&mut kind).ok()?;
        if &kind != b"vide" {
            continue;
        }
        let (mdhd, mdhd_end) = child(&mut file, mdia, end, b"mdhd")?;
        file.seek(SeekFrom::Start(mdhd)).ok()?;
        let mut version = [0; 1];
        file.read_exact(&mut version).ok()?;
        let offset = if version[0] == 0 {
            12
        } else if version[0] == 1 {
            20
        } else {
            return None;
        };
        if mdhd + offset + 4 > mdhd_end {
            return None;
        }
        file.seek(SeekFrom::Start(mdhd + offset)).ok()?;
        let mut scale = [0; 4];
        file.read_exact(&mut scale).ok()?;
        let scale = u32be(&scale);
        let (minf, minf_end) = child(&mut file, mdia, end, b"minf")?;
        let (stbl, stbl_end) = child(&mut file, minf, minf_end, b"stbl")?;
        let (stts, stts_end) = child(&mut file, stbl, stbl_end, b"stts")?;
        if stts_end - stts < 16 {
            return None;
        }
        file.seek(SeekFrom::Start(stts + 4)).ok()?;
        let mut bytes = [0; 4];
        file.read_exact(&mut bytes).ok()?;
        // Only trust a genuinely constant clock. Variable-rate files retain the
        // established FFmpeg probe/fallback rather than guessing an average.
        if u32be(&bytes) != 1 {
            return None;
        }
        let mut entry = [0; 8];
        file.read_exact(&mut entry).ok()?;
        let count = u32be(&entry[..4]);
        let delta = u32be(&entry[4..]);
        if count == 0 || delta == 0 || scale == 0 {
            return None;
        }
        let fps = scale as f64 / delta as f64;
        return (fps.is_finite() && (1.0..=240.0).contains(&fps)).then_some(fps);
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    fn atom(kind: &[u8; 4], data: Vec<u8>) -> Vec<u8> {
        let mut out = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend(kind);
        out.extend(data);
        out
    }
    #[test]
    fn reads_constant_clock_skips_media_and_rejects_variable_clock() {
        let root = std::env::temp_dir().join(format!(
            "delta-mp4-clock-{}.mp4",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let build = |count: u32| {
            let mut mdhd = vec![0; 12];
            mdhd.extend(15360_u32.to_be_bytes());
            mdhd.extend([0; 8]);
            let mut hdlr = vec![0; 8];
            hdlr.extend(b"vide");
            let mut stts = vec![0; 4];
            stts.extend(count.to_be_bytes());
            stts.extend(9000_u32.to_be_bytes());
            stts.extend(512_u32.to_be_bytes());
            let mut mdia = atom(b"mdhd", mdhd);
            mdia.extend(atom(b"hdlr", hdlr));
            mdia.extend(atom(b"minf", atom(b"stbl", atom(b"stts", stts))));
            atom(b"moov", atom(b"trak", atom(b"mdia", mdia)))
        };
        let mut data = atom(b"mdat", vec![0; 1024]);
        data.extend(build(1));
        std::fs::write(&root, data).unwrap();
        assert_eq!(fps(&root), Some(30.0));
        std::fs::write(&root, build(2)).unwrap();
        assert_eq!(fps(&root), None);
        std::fs::write(&root, b"bad").unwrap();
        assert_eq!(fps(&root), None);
        std::fs::remove_file(root).unwrap();
    }
}
