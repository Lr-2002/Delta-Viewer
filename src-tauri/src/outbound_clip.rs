use crate::error::{AppError, AppResult};
use crate::identity::AuthState;
use crate::outbound_media::{movie_clock, mp4_box, mp4_child, mp4_children, OutboundMediaServer};
use crate::{storage, user_center};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Interval {
    start_ms: u64,
    end_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Piece {
    part: usize,
    interval: Interval,
    segments: Vec<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClipRequest {
    dataset_id: String,
    recording_id: String,
    version: u64,
    destination: PathBuf,
    description: String,
    pieces: Vec<Piece>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipResult {
    output_path: PathBuf,
    video_count: usize,
}

#[derive(Deserialize)]
struct SourceVideo {
    segment: u64,
    part: Option<usize>,
    label: String,
    size: u64,
    sha256: Option<String>,
}

type ClipSources<'a> = BTreeMap<u64, (&'a SourceVideo, Vec<usize>)>;

fn fail(code: &str) -> AppError {
    AppError::Message(code.into())
}

fn check(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        return Err(AppError::Cancelled);
    }
    Ok(())
}

fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn camera(label: &str) -> Option<&str> {
    let mut terms = label.rsplit(['/', '\\']);
    let name = terms.next()?;
    let camera = terms.next().unwrap_or_else(|| {
        let stem = name.strip_suffix(".mp4").unwrap_or(name);
        stem.rsplit_once('-')
            .filter(|(_, suffix)| suffix.bytes().all(|byte| byte.is_ascii_digit()))
            .map_or(stem, |(prefix, _)| prefix)
    });
    let camera = match camera {
        "stereo_left" => "extension_left",
        "stereo_right" => "extension_right",
        value => value,
    };
    (safe_name(camera) && camera.len() <= 32).then_some(camera)
}

fn authorized_recording<'a>(
    value: &'a Value,
    request: &ClipRequest,
    owner: &str,
) -> AppResult<(&'a Value, Vec<SourceVideo>)> {
    let invalid = || fail("OUTBOUND_CLIP_SOURCE_CHANGED");
    let batch = value["batches"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|batch| batch["id"].as_str() == Some(&request.dataset_id))
        .ok_or_else(invalid)?;
    if batch["claim"].as_str() != Some(owner) {
        return Err(fail("OUTBOUND_NOT_OWNER"));
    }
    if batch["version"].as_u64() != Some(request.version) {
        return Err(invalid());
    }
    let recording = batch["recordings"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|row| row["id"].as_str() == Some(&request.recording_id))
        .ok_or_else(invalid)?;
    let videos = serde_json::from_value(recording["videos"].clone()).map_err(|_| invalid())?;
    Ok((recording, videos))
}

fn resolve_pieces<'a>(pieces: &[Piece], videos: &'a [SourceVideo]) -> AppResult<ClipSources<'a>> {
    let invalid = || fail("OUTBOUND_CLIP_RANGE_INVALID");
    let mut cameras: BTreeMap<&str, Vec<&SourceVideo>> = BTreeMap::new();
    for video in videos {
        // Manifest order is the immutable natural path order. Both clients and
        // server prefer the original numeric suffix over an ordinal fallback.
        let name = camera(&video.label).ok_or_else(invalid)?;
        cameras.entry(name).or_default().push(video);
    }
    let mut parts: BTreeMap<usize, BTreeSet<u64>> = BTreeMap::new();
    for tracks in cameras.values() {
        for (index, video) in tracks.iter().enumerate() {
            let part = video
                .part
                .or_else(|| {
                    video
                        .label
                        .rsplit_once('-')
                        .and_then(|(_, suffix)| suffix.get(..suffix.len().checked_sub(4)?))
                        .and_then(|suffix| suffix.parse::<usize>().ok())
                })
                .unwrap_or(index);
            let group = parts.entry(part).or_default();
            if !group.insert(video.segment) {
                return Err(invalid());
            }
        }
    }
    let mut files = BTreeMap::new();
    for (index, piece) in pieces.iter().enumerate() {
        let selected = piece.segments.iter().copied().collect::<BTreeSet<_>>();
        if piece.interval.end_ms <= piece.interval.start_ms
            || piece.interval.end_ms > 86_400_000
            || pieces.get(index.wrapping_sub(1)).is_some_and(|previous| {
                previous.part > piece.part
                    || previous.part == piece.part
                        && previous.interval.end_ms > piece.interval.start_ms
            })
            || parts.get(&piece.part) != Some(&selected)
            || selected.len() != piece.segments.len()
        {
            return Err(invalid());
        }
        let mut used_cameras = BTreeSet::new();
        for id in selected {
            let video = videos
                .iter()
                .find(|video| video.segment == id)
                .filter(|video| video.size > 0)
                .ok_or_else(invalid)?;
            if !used_cameras.insert(camera(&video.label).ok_or_else(invalid)?) {
                return Err(invalid());
            }
            files
                .entry(id)
                .or_insert_with(|| (video, Vec::new()))
                .1
                .push(index);
        }
    }
    Ok(files)
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ClipEncoder(Child);

impl Drop for ClipEncoder {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

pub(crate) async fn export(
    app: &AppHandle,
    data: &Path,
    auth: &AuthState,
    media: &OutboundMediaServer,
    request: ClipRequest,
    operation_id: u64,
    cancelled: &AtomicBool,
) -> AppResult<ClipResult> {
    if !safe_name(&request.dataset_id)
        || !safe_name(&request.recording_id)
        || request.pieces.is_empty()
        || request.pieces.len() > 512
        || request.description.chars().count() > 1000
        || !request.destination.is_absolute()
    {
        return Err(fail("OUTBOUND_CLIP_RANGE_INVALID"));
    }
    let session = auth.managed_session()?;
    let list = json!({"action":"list","datasetId":request.dataset_id});
    let details = cancellable(
        user_center::outbound_review_request(data, auth, list.clone()),
        cancelled,
    )
    .await?;
    let (recording, videos) = authorized_recording(&details, &request, &session.0.username)?;
    let files = resolve_pieces(&request.pieces, &videos)?;
    let destination = request.destination.canonicalize()?;
    let ffmpeg_app = app.clone();
    let ffmpeg = tauri::async_runtime::spawn_blocking(move || {
        crate::export::lerobot::find_ffmpeg(Some(&ffmpeg_app))
    })
    .await
    .map_err(|_| fail("OUTBOUND_CLIP_ENCODE"))?
    .map_err(|_| fail("OUTBOUND_CLIP_FFMPEG_MISSING"))?;
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|_| fail("OUTBOUND_CLIP_OUTPUT"))?;
    let suffix = blake3::hash(&nonce).to_hex()[..10].to_string();
    let staging_path = destination.join(format!(".outbound-clip-{suffix}.partial"));
    fs::create_dir(&staging_path)?;
    let staging = Staging(staging_path);
    let source = staging.0.join("source.tmp");
    let mut camera_clips: BTreeMap<String, Vec<EncodedClip>> = BTreeMap::new();

    for (file_index, (segment, (video, pieces))) in files.iter().enumerate() {
        check(cancelled)?;
        let camera = camera(&video.label).ok_or_else(|| fail("OUTBOUND_CLIP_SOURCE_CHANGED"))?;
        let _ = app.emit("outbound-clip-progress", json!({"operationId":operation_id,"current":file_index+1,"total":files.len(),"camera":camera}));
        let input = json!({"action":"video-url","datasetId":request.dataset_id,"recordingId":request.recording_id,"segment":segment});
        let ticket = cancellable(
            user_center::outbound_review_request(data, auth, input),
            cancelled,
        )
        .await?;
        let ticket = ticket["url"]
            .as_str()
            .ok_or_else(|| fail("OUTBOUND_CLIP_SOURCE_READ"))?;
        let url = media.register(auth, session.clone(), ticket, 0)?;
        let read = cancellable(
            media.download_clip_source(auth, &url, video.size, video.sha256.as_deref(), &source),
            cancelled,
        )
        .await;
        let _ = media.release(auth, &[url]);
        read?;
        let camera_dir = staging.0.join(camera);
        fs::create_dir_all(&camera_dir)?;
        for &index in pieces {
            let piece = &request.pieces[index];
            let filename = format!("video-{:05}.mp4", index);
            let output = camera_dir.join(&filename);
            let duration = encode(&ffmpeg, &source, &output, piece.interval, cancelled)
                .await
                .map_err(|error| {
                    if matches!(error, AppError::Cancelled) {
                        error
                    } else {
                        fail(&format!("{} [{}]", error, camera))
                    }
                })?;
            camera_clips.entry(camera.to_owned()).or_default().push(EncodedClip {
                index,
                duration,
                provenance: json!({"part":piece.part,"source":video.label,"sourceRange":piece.interval}),
            });
        }
        fs::remove_file(&source)?;
    }
    let mut outputs = Vec::with_capacity(camera_clips.len());
    let camera_count = camera_clips.len();
    for (camera, clips) in camera_clips.iter_mut() {
        check(cancelled)?;
        if clips.len() != request.pieces.len() || clips.iter().any(|clip| clip.duration <= 0.0) {
            return Err(fail(&format!("OUTBOUND_CLIP_CAMERA_GAP [{camera}]")));
        }
        clips.sort_by_key(|clip| clip.index);
        if clips
            .iter()
            .enumerate()
            .any(|(index, clip)| clip.index != index)
        {
            return Err(fail(&format!("OUTBOUND_CLIP_CAMERA_GAP [{camera}]")));
        }
        let camera_dir = staging.0.join(camera);
        let output = camera_dir.join("video.mp4");
        let duration = if clips.len() == 1 {
            fs::rename(camera_dir.join("video-00000.mp4"), &output)?;
            clips[0].duration
        } else {
            let _ = app.emit("outbound-clip-progress", json!({"operationId":operation_id,"current":outputs.len()+1,"total":camera_count,"camera":camera,"joining":true}));
            let duration = stitch(&ffmpeg, &camera_dir, clips, cancelled)
                .await
                .map_err(|error| {
                    if matches!(error, AppError::Cancelled) {
                        error
                    } else {
                        fail(&format!("{error} [{camera}]"))
                    }
                })?;
            for clip in clips.iter() {
                fs::remove_file(camera_dir.join(format!("video-{:05}.mp4", clip.index)))?;
            }
            duration
        };
        outputs.push(
            json!({"camera":camera,"path":format!("{camera}/video.mp4"),"durationSeconds":duration,
            "clips":clips.iter().map(|clip| &clip.provenance).collect::<Vec<_>>() }),
        );
    }

    let latest = cancellable(
        user_center::outbound_review_request(data, auth, list),
        cancelled,
    )
    .await?;
    let (latest_recording, _) = authorized_recording(&latest, &request, &session.0.username)?;
    if latest_recording["videos"] != recording["videos"] || auth.managed_session()? != session {
        return Err(fail("OUTBOUND_CLIP_SOURCE_CHANGED"));
    }
    check(cancelled)?;
    let description = json!({"schema":"delta.outbound-clip.v2","description":request.description.trim(),
        "source":{"datasetId":request.dataset_id,"recordingId":request.recording_id,"name":recording["name"],
            "reviewVersion":request.version,"decision":recording["decision"]},
        "videos":outputs});
    fs::write(
        staging.0.join("description.json"),
        serde_json::to_vec_pretty(&description)?,
    )?;
    check(cancelled)?;
    let output_path = destination.join(format!("{}-clip-{suffix}", request.recording_id));
    storage::publish_noreplace(&staging.0, &output_path)?;
    Ok(ClipResult {
        output_path,
        video_count: outputs.len(),
    })
}

async fn cancellable<T>(
    work: impl std::future::Future<Output = AppResult<T>>,
    cancelled: &AtomicBool,
) -> AppResult<T> {
    tokio::select! {
        result = work => result,
        _ = async {
            while !cancelled.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        } => Err(AppError::Cancelled),
    }
}

struct EncodedClip {
    index: usize,
    duration: f64,
    provenance: Value,
}

async fn stitch(
    ffmpeg: &Path,
    directory: &Path,
    clips: &[EncodedClip],
    cancelled: &AtomicBool,
) -> AppResult<f64> {
    use std::fmt::Write as _;
    let mut command = Command::new(ffmpeg);
    command.current_dir(directory).args([
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-n",
        "-filter_complex_threads",
        "2",
    ]);
    let mut media = Vec::with_capacity(clips.len());
    for clip in clips {
        let name = format!("video-{:05}.mp4", clip.index);
        let info = output_video_info(&directory.join(&name))
            .ok_or_else(|| fail("OUTBOUND_CLIP_INCOMPLETE"))?;
        media.push(info);
        command.args(["-threads", "1", "-protocol_whitelist", "file", "-i", &name]);
    }
    let (width, height) = media[0].dimensions;
    let has_audio = media.iter().any(|info| info.audio);
    let mut filters = String::new();
    for (index, (clip, info)) in clips.iter().zip(&media).enumerate() {
        let _ = write!(filters, "[{index}:v:0]scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v{index}];");
        if has_audio {
            let duration = clip.duration;
            if info.audio {
                let _ = write!(filters, "[{index}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur={duration:.6},atrim=duration={duration:.6},asetpts=PTS-STARTPTS[a{index}];");
            } else {
                let _ = write!(
                    filters,
                    "anullsrc=r=48000:cl=stereo:d={duration:.6}[a{index}];"
                );
            }
        }
    }
    for index in 0..clips.len() {
        let _ = write!(filters, "[v{index}]");
        if has_audio {
            let _ = write!(filters, "[a{index}]");
        }
    }
    let _ = write!(
        filters,
        "concat=n={}:v=1:a={}[video]",
        clips.len(),
        u8::from(has_audio)
    );
    if has_audio {
        filters.push_str("[audio]");
    }
    let filter_file = directory.join("concat.txt");
    fs::write(&filter_file, filters)?;
    command.args(["-filter_complex_script", "concat.txt", "-map", "[video]"]);
    if has_audio {
        command.args(["-map", "[audio]"]);
    }
    clip_codec(&mut command);
    command.arg("video.mp4");
    let total = clips.iter().map(|clip| clip.duration).sum::<f64>();
    run_encoder(command, total, cancelled).await?;
    let duration = output_video_info(&directory.join("video.mp4"))
        .map(|info| info.duration)
        .ok_or_else(|| fail("OUTBOUND_CLIP_INCOMPLETE"))?;
    if (duration - total).abs() > 0.12 {
        return Err(fail("OUTBOUND_CLIP_INCOMPLETE"));
    }
    fs::remove_file(filter_file)?;
    Ok(duration)
}

async fn encode(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    range: Interval,
    cancelled: &AtomicBool,
) -> AppResult<f64> {
    check(cancelled)?;
    let requested = (range.end_ms - range.start_ms) as f64 / 1000.;
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-n",
            "-protocol_whitelist",
            "file",
            "-f",
            "mov",
            "-ss",
            &format!("{:.3}", range.start_ms as f64 / 1000.),
        ])
        .arg("-i")
        .arg(input)
        .args([
            "-t",
            &format!("{requested:.3}"),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
        ]);
    clip_codec(&mut command);
    command.arg(output);
    run_encoder(command, requested, cancelled).await?;
    let duration = output_video_info(output)
        .map(|info| info.duration)
        .ok_or_else(|| fail("OUTBOUND_CLIP_INCOMPLETE"))?;
    if (duration - requested).abs() > 0.12 {
        return Err(fail("OUTBOUND_CLIP_INCOMPLETE"));
    }
    Ok(duration)
}

fn clip_codec(command: &mut Command) {
    command.args([
        "-fps_mode",
        "passthrough",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
    ]);
    if cfg!(windows) {
        command.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]);
    } else {
        command.args(["-c:v", "mpeg4", "-q:v", "2", "-enc_time_base", "1/60000"]);
    }
}

async fn run_encoder(
    mut command: Command,
    requested: f64,
    cancelled: &AtomicBool,
) -> AppResult<()> {
    check(cancelled)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = ClipEncoder(
        command
            .spawn()
            .map_err(|_| fail("OUTBOUND_CLIP_FFMPEG_MISSING"))?,
    );
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Acquire)
            || started.elapsed().as_secs_f64() > (requested * 8.).max(120.)
        {
            check(cancelled)?;
            return Err(fail("OUTBOUND_CLIP_ENCODE"));
        }
        match process.0.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            _ => return Err(fail("OUTBOUND_CLIP_ENCODE")),
        }
    }
    Ok(())
}

struct VideoInfo {
    duration: f64,
    dimensions: (u16, u16),
    audio: bool,
}

fn output_video_info(path: &Path) -> Option<VideoInfo> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut offset = 0;
    for _ in 0..16 {
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut header = [0; 16];
        file.read_exact(&mut header).ok()?;
        let (size, kind) = mp4_box(&header, offset, length)?;
        if &kind == b"moov" && size <= 32 * 1024 * 1024 {
            let header_len = if header[..4] == [0, 0, 0, 1] { 16 } else { 8 };
            file.seek(SeekFrom::Start(offset + header_len)).ok()?;
            let mut bytes = vec![0; (size - header_len) as usize];
            file.read_exact(&mut bytes).ok()?;
            let mut video = None;
            let mut audio = false;
            for (kind, track) in mp4_children(&bytes)? {
                if &kind != b"trak" {
                    continue;
                }
                let media = mp4_child(track, b"mdia")?;
                let handler = mp4_child(media, b"hdlr")?.get(8..12)?;
                if handler == b"soun" {
                    audio = true;
                }
                if handler == b"vide" {
                    let table = mp4_child(mp4_child(media, b"minf")?, b"stbl")?;
                    let sizes = mp4_child(table, b"stsz")?;
                    if u32::from_be_bytes(sizes.get(8..12)?.try_into().ok()?) > 0 {
                        let description = mp4_child(table, b"stsd")?;
                        let width = u16::from_be_bytes(description.get(40..42)?.try_into().ok()?);
                        let height = u16::from_be_bytes(description.get(42..44)?.try_into().ok()?);
                        video = Some((movie_clock(mp4_child(media, b"mdhd")?)?, (width, height)));
                    }
                }
            }
            return video.map(|(duration, dimensions)| VideoInfo {
                duration,
                dimensions,
                audio,
            });
        }
        offset += size;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_bind_all_cameras_and_excluded_parts_to_the_current_manifest() {
        let videos = vec![
            SourceVideo {
                segment: 0,
                part: Some(0),
                label: "cam0/start.mp4".into(),
                size: 1,
                sha256: None,
            },
            SourceVideo {
                segment: 2,
                part: Some(2),
                label: "cam0/end.mp4".into(),
                size: 1,
                sha256: None,
            },
            SourceVideo {
                segment: 3,
                part: Some(0),
                label: "cam1/start.mp4".into(),
                size: 1,
                sha256: None,
            },
            SourceVideo {
                segment: 5,
                part: Some(2),
                label: "cam1/end.mp4".into(),
                size: 1,
                sha256: None,
            },
        ];
        let interval = Interval {
            start_ms: 300,
            end_ms: 750,
        };
        let mut pieces = vec![
            Piece {
                part: 0,
                interval,
                segments: vec![0, 3],
            },
            Piece {
                part: 2,
                interval,
                segments: vec![2, 5],
            },
        ];
        let files = resolve_pieces(&pieces, &videos).unwrap();
        assert_eq!(files[&0].1, [0]);
        assert_eq!(files[&2].1, [1]);
        pieces[1].segments = vec![2];
        assert!(resolve_pieces(&pieces, &videos).is_err());
        pieces[1].segments = vec![2, 5];
        pieces[1].part = 1;
        assert!(resolve_pieces(&pieces, &videos).is_err());
        pieces[1].part = 0;
        pieces[1].segments = vec![0, 3];
        assert!(resolve_pieces(&pieces, &videos).is_err());
    }

    #[test]
    fn exported_cameras_contain_only_the_actual_cut_frames() {
        let inspect = std::env::var_os("DOHC_CLIP_TEST_INSPECT").unwrap_or_else(|| "ffmpeg".into());
        let encoder = std::env::var_os("DOHC_CLIP_TEST_ENCODER").unwrap_or_else(|| inspect.clone());
        let root = std::env::temp_dir().join(format!("outbound-clip-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let root = Staging(root);
        let input = root.0.join("source.mp4");
        let raw = root.0.join("source.yuv");
        let mut pixels = Vec::new();
        // Three seconds at 10 fps, with a unique luminance for each source frame.
        for frame in 0..30 {
            pixels.extend(vec![32 + frame * 6; 64 * 32]);
            pixels.extend([128; 64 * 32 / 2]);
        }
        fs::write(&raw, pixels).unwrap();
        let generated = Command::new(&inspect)
            .args([
                "-nostdin",
                "-v",
                "error",
                "-f",
                "rawvideo",
                "-pixel_format",
                "yuv420p",
                "-video_size",
                "64x32",
                "-framerate",
                "10",
                "-i",
            ])
            .arg(&raw)
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=d=3",
                "-c:a",
                "aac",
                "-c:v",
                "libx264",
                "-g",
                "30",
                "-threads",
                "1",
                "-movflags",
                "+faststart",
            ])
            .arg(&input)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let source = fs::read(&input).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let run = |path: &Path, start, end| {
            runtime.block_on(encode(
                Path::new(&encoder),
                &input,
                path,
                Interval {
                    start_ms: start,
                    end_ms: end,
                },
                &cancelled,
            ))
        };
        let check_frames = |file: &Path, first: u8, count: usize| {
            let output = Command::new(&inspect)
                .args(["-nostdin", "-v", "error", "-i"])
                .arg(file)
                .args([
                    "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1",
                ])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout.len(), count * 64 * 32 * 3 / 2);
            for (i, frame) in output.stdout.chunks_exact(64 * 32 * 3 / 2).enumerate() {
                assert!(
                    frame[0].abs_diff(32 + (first + i as u8) * 6) <= 3,
                    "wrong source frame {i}"
                );
            }
            let audio = Command::new(&inspect)
                .args(["-nostdin", "-v", "error", "-i"])
                .arg(file)
                .args(["-map", "0:a:0", "-f", "null", "-"])
                .status()
                .unwrap();
            assert!(audio.success());
        };
        for camera in 0..7 {
            let file = root.0.join(format!("camera-{camera}.mp4"));
            assert!((run(&file, 700, 1900).unwrap() - 1.2).abs() < 0.01);
            check_frames(&file, 7, 12);
        }
        for (piece, start, end, first) in [(0, 0, 700, 0), (1, 1900, 3000, 19)] {
            let file = root.0.join(format!("retained-{piece}.mp4"));
            run(&file, start, end).unwrap();
            check_frames(&file, first, ((end - start) / 100) as usize);
        }
        let clips = [
            EncodedClip {
                index: 0,
                duration: 0.7,
                provenance: Value::Null,
            },
            EncodedClip {
                index: 1,
                duration: 1.1,
                provenance: Value::Null,
            },
        ];
        for clip in &clips {
            fs::rename(
                root.0.join(format!("retained-{}.mp4", clip.index)),
                root.0.join(format!("video-{:05}.mp4", clip.index)),
            )
            .unwrap();
        }
        let stitched = runtime
            .block_on(stitch(Path::new(&encoder), &root.0, &clips, &cancelled))
            .unwrap();
        assert!((stitched - 1.8).abs() < 0.01);
        let joined = Command::new(&inspect)
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(root.0.join("video.mp4"))
            .args([
                "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(joined.status.success());
        let expected: Vec<u8> = (0..7).chain(19..30).map(|i| 32 + i * 6).collect();
        let actual: Vec<u8> = joined
            .stdout
            .chunks_exact(64 * 32 * 3 / 2)
            .map(|frame| frame[0])
            .collect();
        assert_eq!(actual.len(), expected.len());
        assert!(
            actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 3),
            "{actual:?}"
        );
        assert!(run(&root.0.join("incomplete.mp4"), 2700, 3600).is_err());
        cancelled.store(true, Ordering::Release);
        assert!(matches!(
            run(&root.0.join("cancelled.mp4"), 700, 1900),
            Err(AppError::Cancelled)
        ));
        assert_eq!(fs::read(input).unwrap(), source);
    }
}
