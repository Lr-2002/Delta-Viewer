import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, Plus, Tag, X } from "lucide-react";
import type { SpecialTag, StreamSummary } from "../types";

export function EpisodeSpecialTags({ tags, streams, disabled, onChange, embedded = false }: {
  tags: SpecialTag[];
  streams: StreamSummary[];
  disabled: boolean;
  onChange: (tags: SpecialTag[]) => void;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [camera, setCamera] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const names = new Map(streams.map(stream => [stream.name, stream.label || stream.name]));
  const reset = () => { setOpen(false); setCamera(""); setDescription(""); setEditing(null); setError(""); };
  const save = () => {
    const text = description.trim();
    if (!text || [...text].length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) { setError("请填写 1–200 字的异常说明，不可包含换行或控制字符。"); return; }
    if (tags.some((tag, i) => i !== editing && tag.camera === camera && tag.description === text)) { setError("这个相机已有相同标签。"); return; }
    if (editing === null && tags.length >= 20) { setError("每条数据最多添加 20 个特殊标签。"); return; }
    onChange(editing === null ? [...tags, { camera, description: text }] : tags.map((tag, i) => i === editing ? { camera, description: text } : tag));
    reset();
  };
  const content = <section className="episode-special-tags" aria-label="数据特殊标签">
    <header>
      <div><Tag size={15} /><strong>特殊标签</strong><span>整条数据 · 可记录相机异常</span></div>
      <button type="button" className="special-tag-add" disabled={disabled || tags.length >= 20} onClick={() => { reset(); setOpen(true); }}><Plus size={14} />添加标签</button>
    </header>
    {tags.length > 0 && <ul aria-label="已添加的特殊标签">{tags.map((tag, index) => <li key={index}>
      <span className="special-tag-camera">{tag.camera ? names.get(tag.camera) ?? tag.camera : "整条数据"}</span><span className="special-tag-text">{tag.description}</span>
      <button type="button" disabled={disabled} title="修改标签" aria-label={`修改特殊标签 ${index + 1}`} onClick={() => { setCamera(tag.camera); setDescription(tag.description); setEditing(index); setError(""); setOpen(true); }}><Pencil size={13} /></button>
      <button type="button" disabled={disabled} title="删除标签" aria-label={`删除特殊标签 ${index + 1}`} onClick={() => { onChange(tags.filter((_, i) => i !== index)); reset(); }}><X size={14} /></button>
    </li>)}</ul>}
    {open && <div className="special-tag-form" role="group" aria-label="填写特殊标签">
      <label><span>对应相机</span><select aria-label="特殊标签相机" disabled={disabled} value={camera} onChange={event => setCamera(event.target.value)}>
        <option value="">整条数据</option>{[...names].map(([name, label]) => <option key={name} value={name}>{label}</option>)}
        {camera && !names.has(camera) && <option value={camera}>{camera}（当前未接入）</option>}
      </select></label>
      <label className="special-tag-description"><span>异常说明</span><input autoFocus aria-label="特殊标签说明" disabled={disabled} value={description} maxLength={400} placeholder="例如：画面左侧有两根设备线入镜" onChange={event => setDescription(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); save(); } if (event.key === "Escape") { event.stopPropagation(); reset(); } }} /></label>
      <button type="button" className="button button-primary" disabled={disabled} onClick={save}><Check size={14} />{editing === null ? "添加" : "保存"}</button>
      <button type="button" className="button button-secondary" onClick={reset}>取消</button>
      {error && <p role="alert">{error}</p>}
    </div>}
    {open && <p className="special-tag-hint">加入后随人工结果保存，未提交审核时只保留在本机。</p>}
  </section>;
  const target = embedded ? document.getElementById("episode-special-tags") : null;
  return target ? createPortal(content, target) : content;
}
