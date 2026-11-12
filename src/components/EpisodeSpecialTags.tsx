import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, Plus, Save, Tag, X } from "lucide-react";
import type { SpecialTag, StreamSummary } from "../types";

const validDescription = (text: string) => Boolean(text) && [...text].length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(text);

export function EpisodeSpecialTags({ username, tags, streams, disabled, onChange, embedded = false }: {
  username: string;
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
  const storageKey = `dohc-viewer.special-tag-library.v1:${encodeURIComponent(username)}`;
  const [common, setCommon] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [notice, setNotice] = useState("");
  const [managing, setManaging] = useState(false);
  const readLibrary = (): string[] => {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return [];
    if (raw.length > 65536) throw Error("Invalid tag library");
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== "string" || !validDescription(value.trim()))) throw Error("Invalid tag library");
    return [...new Set((values as string[]).map(value => value.trim()))];
  };
  useEffect(() => {
    const refresh = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== null && event.key !== storageKey) return;
      if (event instanceof CustomEvent && event.detail !== storageKey) return;
      try { setCommon(readLibrary()); setLibraryError(""); }
      catch { setLibraryError("常用标签读取失败，请检查本机存储后重试。"); }
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("delta-special-tag-library", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("delta-special-tag-library", refresh);
    };
  }, [storageKey]);
  const updateLibrary = (change: (current: string[]) => string[] | null) => {
    if (disabled) return;
    try {
      const next = change(readLibrary());
      if (!next) return;
      localStorage.setItem(storageKey, JSON.stringify(next));
      setCommon(next); setLibraryError("");
      window.dispatchEvent(new CustomEvent("delta-special-tag-library", { detail: storageKey }));
    } catch { setNotice(""); setLibraryError("常用标签未保存，本机存储不可用，请稍后重试；当前数据标签不受影响。"); }
  };
  const remember = () => {
    const text = description.trim();
    if (!validDescription(text)) { setError("请填写 1–200 字的异常说明，不可包含换行或控制字符。"); return; }
    updateLibrary(current => {
      if (current.includes(text)) { setNotice("该说明已在常用标签中。"); return null; }
      if (current.length >= 20) { setLibraryError("最多保存 20 个常用标签，请先管理并移除不再使用的标签。"); return null; }
      setNotice("已保存为常用标签，后续数据可直接选用。");
      return [...current, text];
    });
  };
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
    if (disabled) return;
    if (!validDescription(text)) { setError("请填写 1–200 字的异常说明，不可包含换行或控制字符。"); return; }
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
    {common.length > 0 && <div className="special-tag-library" role="group" aria-label="常用特殊标签">
      <div className="special-tag-library-heading"><span>常用标签</span><button type="button" disabled={disabled} onClick={() => setManaging(value => !value)}>{managing ? "完成管理" : "管理"}</button></div>
      <div className="special-tag-library-options">{common.map(text => <span key={text}>
        <button type="button" disabled={disabled} aria-pressed={open && description === text} onClick={() => { if (!open) reset(); setDescription(text); setOpen(true); setError(""); setNotice(""); }}>{text}</button>
        {managing && <button type="button" disabled={disabled} aria-label={`移除常用标签 ${text}`} title="移除常用项，不影响已有数据标签" onClick={() => updateLibrary(current => current.filter(value => value !== text))}><X size={13} /></button>}
      </span>)}</div>
    </div>}
    {libraryError && <p className="special-tag-library-error" role="alert">{libraryError}</p>}
    {notice && <p className="special-tag-hint" role="status">{notice}</p>}
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
      <button type="button" className="button button-secondary" disabled={disabled || !description.trim()} onClick={remember}><Save size={14} />存为常用</button>
      <button type="button" className="button button-primary" disabled={disabled} onClick={save}><Check size={14} />{editing === null ? "添加" : "保存"}</button>
      <button type="button" className="button button-secondary" onClick={reset}>取消</button>
      {error && <p role="alert">{error}</p>}
    </div>}
    {open && <p className="special-tag-hint">加入后随人工结果保存；常用标签仅保存在当前账号的本机，可跨数据沿用。</p>}
  </section>;
  const target = embedded ? document.getElementById("episode-special-tags") : null;
  return target ? createPortal(content, target) : content;
}
