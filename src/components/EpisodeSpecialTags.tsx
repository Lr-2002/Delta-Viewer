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
  const [cameras, setCameras] = useState<string[]>([""]);
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<number[] | null>(null);
  const [error, setError] = useState("");
  const names = new Map(streams.map(stream => [stream.name, stream.label || stream.name]));
  const cameraOptions = new Map(names);
  for (const camera of [...tags.map(tag => tag.camera), ...cameras]) {
    if (camera && !cameraOptions.has(camera)) cameraOptions.set(camera, `${camera}（当前未接入）`);
  }
  // Keep the shared single-camera schema readable by older clients; present matching
  // descriptions as one editable group without losing any camera association.
  const groups: { cameras: string[]; description: string; indices: number[] }[] = [];
  tags.forEach((tag, index) => {
    const group = groups.find(item => item.description === tag.description && Boolean(item.cameras[0]) === Boolean(tag.camera));
    if (group) { group.cameras.push(tag.camera); group.indices.push(index); }
    else groups.push({ cameras: [tag.camera], description: tag.description, indices: [index] });
  });
  const toggleCamera = (name: string) => {
    setCameras(current => {
      if (!name) return [""];
      const next = current.includes(name) ? current.filter(value => value !== name) : [...current.filter(Boolean), name];
      return next.length ? next : [""];
    });
    setError("");
  };
  const reset = () => { setOpen(false); setCameras([""]); setDescription(""); setEditing(null); setError(""); };
  const save = () => {
    const text = description.trim();
    if (!text || [...text].length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) { setError("请填写 1–200 字的异常说明，不可包含换行或控制字符。"); return; }
    const remaining = tags.filter((_, index) => !editing?.includes(index));
    if (remaining.some(tag => cameras.includes(tag.camera) && tag.description === text)) { setError("所选相机已有相同标签，请修改说明或取消重复相机。"); return; }
    if (remaining.length + cameras.length > 20) { setError("每条数据最多保存 20 项相机与说明关联，请减少相机或删除已有标签。"); return; }
    const additions = cameras.map(camera => ({ camera, description: text }));
    const insertion = editing?.[0] ?? remaining.length;
    onChange([...remaining.slice(0, insertion), ...additions, ...remaining.slice(insertion)]);
    reset();
  };
  const content = <section className="episode-special-tags" aria-label="数据特殊标签">
    <header>
      <div><Tag size={15} /><strong>特殊标签</strong><span>整条数据 · 可记录相机异常</span></div>
      <button type="button" className="special-tag-add" disabled={disabled || tags.length >= 20} onClick={() => { reset(); setOpen(true); }}><Plus size={14} />添加标签</button>
    </header>
    {tags.length > 0 && <ul aria-label="已添加的特殊标签">{groups.map((tag, index) => <li key={index}>
      <span className="special-tag-camera">{tag.cameras.map(camera => camera ? names.get(camera) ?? camera : "整条数据").join("、")}</span><span className="special-tag-text">{tag.description}</span>
      <button type="button" disabled={disabled} title="修改标签" aria-label={`修改特殊标签 ${index + 1}`} onClick={() => { setCameras([...tag.cameras]); setDescription(tag.description); setEditing(tag.indices); setError(""); setOpen(true); }}><Pencil size={13} /></button>
      <button type="button" disabled={disabled} title="删除标签" aria-label={`删除特殊标签 ${index + 1}`} onClick={() => { onChange(tags.filter((_, i) => !tag.indices.includes(i))); reset(); }}><X size={14} /></button>
    </li>)}</ul>}
    {open && <div className="special-tag-form" role="group" aria-label="填写特殊标签">
      <fieldset className="special-tag-cameras" disabled={disabled} aria-label="特殊标签相机">
        <legend>对应相机 <span>可多选</span></legend>
        <div>{[["", "整条数据"], ...cameraOptions].map(([name, label]) =>
          <label key={name} className={cameras.includes(name) ? "is-selected" : ""}>
            <input type="checkbox" value={name} checked={cameras.includes(name)} onChange={() => toggleCamera(name)} />{label}
          </label>
        )}</div>
      </fieldset>
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
