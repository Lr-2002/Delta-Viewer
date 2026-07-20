import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FileSearch,
  FolderOpen,
  Gauge,
  HardDrive,
  Images,
  LoaderCircle,
  Pause,
  Play,
  PackageOpen,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { ChecksPanel } from "./components/ChecksPanel";
import { ExportPanel } from "./components/ExportPanel";
import { FramePanel } from "./components/FramePanel";
import { ProgressStrip } from "./components/ProgressStrip";
import { TelemetryChart } from "./components/TelemetryChart";
import {
  DEMO_ROOT,
  cancelTask,
  chooseDirectory,
  exportEpisode,
  importEpisode,
  isTauriRuntime,
  loadEpisode,
  onTaskProgress,
  scanSource,
  validateEpisode,
} from "./lib/backend";
import { formatBytes, shortPath } from "./lib/format";
import type {
  EpisodeData,
  EpisodeSummary,
  ExportFormat,
  ExportResult,
  MetricKey,
  ScanResult,
  TaskProgress,
  ValidationReport,
} from "./types";

type View = "review" | "checks" | "export";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "position", label: "位置" },
  { key: "velocity", label: "速度" },
  { key: "euler", label: "欧拉角" },
  { key: "omega", label: "角速度" },
];

function App() {
  const [sourcePath, setSourcePath] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<EpisodeSummary | null>(null);
  const [data, setData] = useState<EpisodeData | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mcap");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [view, setView] = useState<View>("review");
  const [metric, setMetric] = useState<MetricKey>("position");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const frameRef = useRef(0);
  const didAutoLoad = useRef(false);

  useEffect(() => {
    frameRef.current = currentFrame;
  }, [currentFrame]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onTaskProgress((nextProgress) => setProgress(nextProgress)).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (didAutoLoad.current || isTauriRuntime()) return;
    didAutoLoad.current = true;
    void openSource(DEMO_ROOT, true);
  }, []);

  useEffect(() => {
    if (!playing || !data) return;
    const maxFrame = getMaxFrame(data);
    const interval = window.setInterval(() => {
      const next = frameRef.current + 1;
      if (next > maxFrame) {
        setPlaying(false);
        return;
      }
      frameRef.current = next;
      setCurrentFrame(next);
    }, Math.max(16, Math.round(1000 / (30 * speed))));
    return () => window.clearInterval(interval);
  }, [data, playing, speed]);

  async function openSource(path: string, autoLoad = false) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = await scanSource(path);
      setSourcePath(result.sourceRoot);
      setScan(result);
      const first = result.episodes[0] ?? null;
      setSelectedEpisode(first);
      if (autoLoad && first) await loadAndValidate(first.root, false);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function chooseSource() {
    const path = await chooseDirectory("选择 SD 卡或记录目录");
    if (path) await openSource(path);
  }

  async function loadSelectedEpisode() {
    if (!selectedEpisode) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      let root = selectedEpisode.root;
      if (isTauriRuntime()) {
        const destinationParent = await chooseDirectory("选择本地导入目录");
        if (!destinationParent) return;
        const imported = await importEpisode(selectedEpisode.root, destinationParent);
        root = imported.destination;
        setNotice(`已导入本地，BLAKE3 ${imported.datasetBlake3.slice(0, 16)}…`);
      }
      await loadAndValidate(root, true);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function loadAndValidate(root: string, updateSelection: boolean) {
    const loaded = await loadEpisode(root);
    const checked = await validateEpisode(root);
    setData(loaded);
    setReport(checked);
    setExportResult(null);
    setCurrentFrame(loaded.states[0]?.frameId ?? loaded.summary.streams[0]?.firstFrame ?? 0);
    frameRef.current = loaded.states[0]?.frameId ?? 0;
    setView("review");
    if (updateSelection) {
      setSelectedEpisode(loaded.summary);
      setSourcePath(root);
    }
  }

  function resetLoadedData() {
    setData(null);
    setReport(null);
    setPlaying(false);
    setExportResult(null);
    setCurrentFrame(0);
  }

  function moveFrame(delta: number) {
    if (!data) return;
    const next = Math.max(0, Math.min(getMaxFrame(data), currentFrame + delta));
    frameRef.current = next;
    setCurrentFrame(next);
  }

  async function runExport() {
    if (!data || report?.status === "error") return;
    const destinationParent = await chooseDirectory(`选择 ${exportFormatLabel(exportFormat)} 导出目录`);
    if (!destinationParent) return;
    setError("");
    setNotice("");
    setBusy(true);
    setExportResult(null);
    try {
      const result = await exportEpisode(data.summary.root, destinationParent, exportFormat);
      setExportResult(result);
      setNotice(`已导出 ${exportFormatLabel(exportFormat)}：${shortPath(result.outputPath, 72)}`);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const currentState = useMemo(
    () => data?.states.find((state) => state.frameId === currentFrame) ?? data?.states[0] ?? null,
    [currentFrame, data],
  );
  const maxFrame = data ? getMaxFrame(data) : 0;
  const status = report?.status ?? (data ? "warning" : "idle");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">D</span>
          <div>
            <strong>DOHC Viewer</strong>
            <span>recording workspace</span>
          </div>
        </div>
        <div className="source-display">
          <HardDrive size={16} />
          <span title={sourcePath}>{sourcePath ? shortPath(sourcePath, 58) : "未选择 SD 卡"}</span>
          {sourcePath ? <span className="source-dot" /> : null}
        </div>
        <div className="topbar-actions">
          <StatusBadge status={status} />
          <button className="button button-secondary" type="button" onClick={() => void chooseSource()} disabled={busy}>
            <FolderOpen size={16} />
            选择 SD 卡
          </button>
          <button className="button button-primary" type="button" onClick={() => void loadSelectedEpisode()} disabled={!selectedEpisode || busy}>
            <Download size={16} />
            导入并检查
          </button>
        </div>
      </header>

      {progress ? <ProgressStrip progress={progress} onCancel={() => void cancelTask()} /> : null}
      {error ? (
        <div className="alert-banner alert-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button type="button" className="text-button" onClick={() => setError("")}>关闭</button>
        </div>
      ) : null}
      {notice ? (
        <div className="alert-banner alert-notice" role="status">
          <Check size={17} />
          <span>{notice}</span>
          <button type="button" className="text-button" onClick={() => setNotice("")}>关闭</button>
        </div>
      ) : null}

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="section-kicker">SOURCE</span>
              <h1>记录</h1>
            </div>
            <button className="icon-button" type="button" onClick={() => void chooseSource()} title="重新扫描" aria-label="重新扫描">
              <RotateCcw size={17} />
            </button>
          </div>
          <div className="sidebar-path" title={sourcePath}>{sourcePath ? shortPath(sourcePath, 38) : "等待 SD 卡"}</div>
          <div className="episode-list">
            {scan?.episodes.length ? (
              scan.episodes.map((episode) => (
                <button
                  type="button"
                  className={`episode-item${selectedEpisode?.root === episode.root ? " selected" : ""}`}
                  key={episode.root}
                  onClick={() => {
                    setSelectedEpisode(episode);
                    resetLoadedData();
                  }}
                >
                  <span className="episode-item-top">
                    <Images size={16} />
                    <strong>{episode.name}</strong>
                    <ChevronRight size={15} />
                  </span>
                  <span className="episode-item-meta">
                    {episode.stateCount} states · {formatBytes(episode.totalBytes)}
                  </span>
                  <span className="stream-dots">
                    {episode.streams.map((stream) => (
                      <i className={stream.frameCount ? "dot-ok" : "dot-error"} key={stream.name} title={stream.label} />
                    ))}
                  </span>
                </button>
              ))
            ) : (
              <div className="sidebar-empty">
                <HardDrive size={23} />
                <span>未加载记录</span>
              </div>
            )}
          </div>
          <div className="sidebar-footer">
            <div><span>文件</span><strong>{selectedEpisode?.totalFiles ?? "—"}</strong></div>
            <div><span>容量</span><strong>{selectedEpisode ? formatBytes(selectedEpisode.totalBytes) : "—"}</strong></div>
          </div>
        </aside>

        <main className="main-content">
          {data ? (
            <>
              <nav className="view-tabs" aria-label="工作区视图">
                <button type="button" className={view === "review" ? "active" : ""} onClick={() => setView("review")}>
                  <Images size={17} />回放
                </button>
                <button type="button" className={view === "checks" ? "active" : ""} onClick={() => setView("checks")}>
                  <ShieldCheck size={17} />检查
                  {report?.status === "warning" ? <span className="tab-alert" /> : null}
                </button>
                <button type="button" className={view === "export" ? "active" : ""} onClick={() => setView("export")}>
                  <PackageOpen size={17} />导出
                </button>
                <span className="view-tab-spacer" />
                <span className="loaded-label"><span className="source-dot" />{shortPath(data.summary.root, 52)}</span>
              </nav>

              {view === "review" ? (
                <div className="review-view">
                  <section className="camera-section">
                    <div className="section-heading compact-heading">
                      <div>
                        <span className="section-kicker">SYNCHRONIZED FRAMES</span>
                        <h2>多路回放</h2>
                      </div>
                      <span className="frame-counter">帧 {currentFrame} / {maxFrame}</span>
                    </div>
                    <div className="camera-grid">
                      {data.summary.streams.map((stream, index) => (
                        <FramePanel
                          key={stream.name}
                          root={data.summary.root}
                          stream={stream}
                          frameId={currentFrame}
                          className={`camera-${index}`}
                        />
                      ))}
                    </div>
                    <div className="timeline-controls">
                      <div className="transport-buttons">
                        <button className="icon-button" type="button" onClick={() => moveFrame(-1)} title="上一帧" aria-label="上一帧"><SkipBack size={17} /></button>
                        <button className="play-button" type="button" onClick={() => setPlaying((value) => !value)} title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"}>
                          {playing ? <Pause size={17} /> : <Play size={17} />}
                        </button>
                        <button className="icon-button" type="button" onClick={() => moveFrame(1)} title="下一帧" aria-label="下一帧"><SkipForward size={17} /></button>
                      </div>
                      <input
                        className="timeline-slider"
                        type="range"
                        min={0}
                        max={maxFrame}
                        value={currentFrame}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          frameRef.current = next;
                          setCurrentFrame(next);
                        }}
                        aria-label="播放帧位置"
                      />
                      <span className="time-readout">{currentState ? formatStateTime(data, currentState.captureTimeNs) : "—"}</span>
                      <label className="speed-control">
                        <Gauge size={16} />
                        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))} aria-label="播放速度">
                          <option value={0.25}>0.25×</option>
                          <option value={0.5}>0.5×</option>
                          <option value={1}>1×</option>
                          <option value={2}>2×</option>
                        </select>
                      </label>
                    </div>
                  </section>

                  <section className="telemetry-section">
                    <div className="section-heading compact-heading">
                      <div>
                        <span className="section-kicker">STATE TELEMETRY</span>
                        <h2>状态数据</h2>
                      </div>
                      <div className="metric-switcher" role="tablist" aria-label="状态数据类型">
                        {METRICS.map((item) => (
                          <button key={item.key} type="button" className={metric === item.key ? "active" : ""} onClick={() => setMetric(item.key)}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <TelemetryChart states={data.states} metric={metric} frameId={currentFrame} />
                  </section>
                </div>
              ) : view === "checks" ? (
                <ChecksPanel data={data} report={report} />
              ) : (
                <ExportPanel
                  data={data}
                  report={report}
                  selectedFormat={exportFormat}
                  result={exportResult}
                  busy={busy}
                  onSelectFormat={(format) => {
                    setExportFormat(format);
                    setExportResult(null);
                  }}
                  onExport={() => void runExport()}
                />
              )}
            </>
          ) : (
            <EmptyWorkspace
              selectedEpisode={selectedEpisode}
              busy={busy}
              onChoose={chooseSource}
              onLoad={() => void loadSelectedEpisode()}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyWorkspace({
  selectedEpisode,
  busy,
  onChoose,
  onLoad,
}: {
  selectedEpisode: EpisodeSummary | null;
  busy: boolean;
  onChoose: () => Promise<void>;
  onLoad: () => void;
}) {
  return (
    <div className="empty-workspace">
      <div className="empty-header">
        <span className="section-kicker">IMPORT QUEUE</span>
        <h2>从 SD 卡载入记录</h2>
        <p>选择记录后，复制到本地并运行完整性检查。</p>
      </div>
      {selectedEpisode ? (
        <div className="selected-episode-line">
          <div className="selected-episode-icon"><FileSearch size={20} /></div>
          <div>
            <strong>{selectedEpisode.name}</strong>
            <span>{selectedEpisode.stateCount} 条状态 · {formatBytes(selectedEpisode.totalBytes)} · {selectedEpisode.streams.length} 路流</span>
          </div>
          <button className="button button-primary" type="button" onClick={onLoad} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
            导入并检查
          </button>
        </div>
      ) : (
        <button className="empty-action" type="button" onClick={() => void onChoose()} disabled={busy}>
          <HardDrive size={30} />
          <span>选择 SD 卡目录</span>
          <small>支持包含一个或多个记录目录的卷</small>
        </button>
      )}
      <div className="empty-facts">
        <span><ShieldCheck size={16} />大小 + BLAKE3 校验</span>
        <span><Activity size={16} />状态与帧序列检查</span>
        <span><Images size={16} />多路同步回放</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "ok" | "warning" | "error" | "idle" }) {
  const labels = { ok: "检查通过", warning: "有警告", error: "检查失败", idle: "未载入" };
  return <span className={`top-status top-status-${status}`}><span />{labels[status]}</span>;
}

function getMaxFrame(data: EpisodeData): number {
  const streamMax = Math.max(...data.summary.streams.map((stream) => stream.lastFrame ?? 0), 0);
  return Math.max(streamMax, data.states.at(-1)?.frameId ?? 0);
}

function formatStateTime(data: EpisodeData, captureTimeNs: string): string {
  try {
    const first = data.states[0]?.captureTimeNs;
    if (!first) return "—";
    const deltaNs = BigInt(captureTimeNs) - BigInt(first);
    return `${(Number(deltaNs) / 1_000_000).toFixed(1)} ms`;
  } catch {
    return "—";
  }
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function exportFormatLabel(format: ExportFormat): string {
  return format === "mcap" ? "MCAP" : format === "hdf5" ? "HDF5" : "LeRobot v2.1";
}

export default App;
