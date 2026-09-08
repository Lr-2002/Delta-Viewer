import { useEffect, useMemo, useRef, useState } from "react";
import { Code, Crosshair, LoaderCircle, Play, RefreshCw, X } from "lucide-react";
import { loadMachineAnnotation } from "../lib/backend";
import { machineSegmentRange, machineTimelineMapping } from "../lib/machine-annotation";
import { FramePanel } from "./FramePanel";
import type { EpisodeAnnotation, EpisodeData, ExportRange, MachineAnnotation } from "../types";

interface Props {
  data: EpisodeData;
  annotation: EpisodeAnnotation | null;
  currentFrame: number;
  previewing: boolean;
  busy: boolean;
  onPreview: (range: ExportRange, play: boolean) => void;
  onExitPreview: () => void;
}

const COLORS = ["#087e79", "#5489a3", "#b3914b", "#797895", "#628969"];
const BODY_PARTS: Record<string, string> = { whole_body: "全身", full_body: "全身", body: "全身", left_hand: "左手", right_hand: "右手", both_hands: "双手" };
function attribute(value: unknown) {
  return value == null || value === "" ? "未记录" : typeof value === "string" ? BODY_PARTS[value] ?? value : JSON.stringify(value);
}

export function MachineAnnotationPanel({ data, annotation, currentFrame, previewing, busy, onPreview, onExitPreview }: Props) {
  const [result, setResult] = useState<MachineAnnotation | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setResult(null);
    setSelected(0);
    setShowJson(false);
    void loadMachineAnnotation(data.summary.root).then((loaded) => {
      if (active) setResult(loaded);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [data.summary.root, revision]);
  const primary = data.summary.streams.find((stream) => stream.name === "cam0");
  const mapping = useMemo(() => result ? machineTimelineMapping(result, primary) : null, [result, primary]);
  const rows = useMemo(() => result?.segments.map((segment) => ({
    ...segment, range: machineSegmentRange(segment, mapping?.offset ?? 0, mapping?.step ?? 1),
  })) ?? [], [result, mapping]);
  const current = mapping?.error ? [] : rows.filter(({ range }) => currentFrame >= range.startFrame && currentFrame <= range.endFrame);
  const activeIndex = rows[selected] && current.includes(rows[selected]) ? selected : current.length ? rows.indexOf(current[0]) : selected;
  const active = rows[activeIndex];
  const human = annotation?.segments.filter((segment) => currentFrame >= segment.startFrame && currentFrame <= segment.endFrame) ?? [];
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[activeIndex] as HTMLElement | undefined;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop;
  }, [activeIndex]);
  const choose = (index: number, play = false) => {
    setSelected(index);
    onPreview(rows[index].range, play);
  };
  const attributes = active?.attributes ?? {};
  const lastBoundary = Boolean(result && active && active.endFrame + 1 >= result.frameCount);
  const endPreviewFrame = active ? lastBoundary ? active.range.endFrame : active.range.endFrame + 1 : 0;
  return <>
    <section className="machine-annotation" aria-label="机标结果">
      <header className="machine-heading">
        <strong>动作片段</strong><span className="machine-episode">{result?.episodeId ?? data.summary.root.split(/[\\/]/).pop()}</span>
        <span className="machine-status">{result ? `${result.segments.length} 段` : ""}</span>
        <button className="icon-button" type="button" title="查看 JSON" aria-label="查看 JSON" disabled={!result} onClick={() => setShowJson(!showJson)}><Code size={15} /></button>
        <button className="icon-button" type="button" title="重新读取机标" aria-label="重新读取机标" disabled={loading || busy || previewing} onClick={() => setRevision(revision + 1)}><RefreshCw size={15} /></button>
      </header>
      {loading ? <p className="machine-message" role="status"><LoaderCircle size={15} className="spin" />正在读取机标</p>
        : error ? <p className="machine-message" role="alert">{error}</p>
          : !result ? <p className="machine-message">未发现 bailian_annotation.json</p>
            : <>
              <div className="machine-metadata"><span>模型：{result.model ?? "未记录"}</span><span>{result.validationStatus === "passed" ? "结构与规则校验通过" : "机标未通过或未校验"} · 未经人工复核</span></div>
              {result.warnings.map((warning) => <p className="machine-message" role="status" key={warning}>{warning}</p>)}
              {mapping?.error && <p className="machine-message" role="alert">{mapping.error}</p>}
              <div className="machine-action-strip" aria-label="动作分段条">
                {rows.map((segment, index) => <button key={index} type="button" title={`${index + 1}. ${segment.description || segment.label} [${segment.startFrame}, ${segment.endFrame + 1})`} aria-label={`选择机标片段 ${index + 1}`} aria-pressed={index === activeIndex} disabled={busy || Boolean(mapping?.error)} onClick={() => choose(index)} style={{ left: `${100 * segment.startFrame / result.frameCount}%`, width: `${100 * (segment.endFrame - segment.startFrame + 1) / result.frameCount}%`, background: COLORS[index % COLORS.length] }} />)}
              </div>
              <div ref={listRef} className="machine-segment-list" role="list">
                {rows.map((segment, index) => <div role="listitem" className={`machine-segment${!mapping?.error && index === activeIndex ? " active" : ""}`} key={`${index}-${segment.startFrame}`}>
                  <button type="button" className="machine-segment-description" aria-label={`定位机标片段 ${index + 1}`} aria-pressed={index === activeIndex} disabled={busy || Boolean(mapping?.error)} onClick={() => choose(index)}>
                    <strong>{index + 1}. {segment.description || segment.label}</strong>
                    <span><em>{attribute(segment.attributes.body_part)}</em> · {segment.label}</span>
                    <small>帧 [{segment.startFrame}, {segment.endFrame + 1})</small>
                  </button>
                  <button className="icon-button" type="button" title={`播放机标片段 ${index + 1}`} aria-label={`播放机标片段 ${index + 1}`} disabled={busy || Boolean(mapping?.error)} onClick={() => choose(index, true)}><Play size={15} /></button>
                </div>)}
              </div>
              {!rows.length && <p className="machine-message">机标结果为空</p>}
              <div className="machine-comparison">
                <div><span>当前帧机标</span><strong>{current.map((segment) => segment.description || segment.label).join("；") || "无对应片段"}</strong></div>
                <div><span>已保存人工标注</span><strong>{human.map((segment) => segment.note || segment.title).join("；") || "无对应片段"}</strong></div>
              </div>
              {previewing && <button className="button button-secondary" type="button" onClick={onExitPreview}><Crosshair size={14} />返回人工范围</button>}
            </>}
    </section>
    {active && primary && mapping && !mapping.error && <section className="machine-boundaries" aria-label="片段边界">
      <div className="machine-boundary-grid">
        {[{ name: "起始", frame: active.range.startFrame, label: `第 ${active.startFrame} 帧` }, { name: "结束", frame: endPreviewFrame, label: `第 ${active.endFrame + 1} 帧（不含）${lastBoundary ? ` · 显示末帧 ${active.endFrame}` : ""}` }].map((boundary) => <div key={boundary.name} data-boundary-frame={boundary.frame}>
          <FramePanel root={data.summary.root} stream={primary} frameId={boundary.frame} playbackEndFrame={primary.lastFrame ?? boundary.frame} playing={false} nativePlaybackEnabled={false} readAheadEnabled={false} className="machine-boundary-frame" />
          <p>{boundary.name} · 时间戳缺失 · {boundary.label}</p>
        </div>)}
      </div>
      <dl className="machine-attributes">
        {[["Segment", active.segmentId], ["部位", attributes.body_part], ["物体", attributes.object_name ?? attributes.object], ["颜色", attributes.color ?? attributes.object_color], ["来源", attributes.source_name ?? attributes.source], ["目标", attributes.target_name ?? attributes.target], ["边界依据", result?.boundaryMethod]].map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{attribute(value)}</dd></div>)}
      </dl>
    </section>}
    {showJson && result && <dialog className="machine-json" aria-label="机标 JSON" ref={(node) => { if (node && !node.open) node.showModal(); }} onCancel={() => setShowJson(false)}>
        <header className="machine-heading"><strong>bailian_annotation.json</strong><button autoFocus className="icon-button" type="button" title="关闭 JSON" aria-label="关闭 JSON" onClick={() => setShowJson(false)}><X size={16} /></button></header>
        <pre>{result.sourceJson ?? JSON.stringify(result, null, 2)}</pre>
    </dialog>}
  </>;
}
