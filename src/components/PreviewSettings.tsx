import { useEffect, useState } from "react";
import { FolderOpen, Settings2, X } from "lucide-react";
import { chooseDirectory, getPreviewLocation, setPreviewLocation } from "../lib/backend";

export function PreviewSettings() {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState({ sourceRoot: "", previewRoot: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void getPreviewLocation().then((value) => { if (active) setLocation(value); }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [open]);
  async function choose(key: "sourceRoot" | "previewRoot") {
    try { const path = await chooseDirectory(key === "sourceRoot" ? "选择原始数据根目录" : "选择预览根目录"); if (path) setLocation((value) => ({ ...value, [key]: path })); }
    catch (reason) { setError(String(reason)); }
  }
  async function save() {
    setBusy(true); setError("");
    try { await setPreviewLocation(location); window.dispatchEvent(new Event("delta-preview-location")); setOpen(false); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <button className="icon-button" title="预览设置（开发）" aria-label="预览设置（开发）" onClick={() => { setError(""); setOpen(true); }}><Settings2 size={17} /></button>
    {open && <div className="modal-backdrop"><section className="preview-settings" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <header><h2 id="preview-title">开发预览设置</h2><button className="icon-button" aria-label="关闭预览设置" disabled={busy} onClick={() => setOpen(false)}><X size={18} /></button></header>
      {(["sourceRoot", "previewRoot"] as const).map((key) => <label key={key}>
        <span>{key === "sourceRoot" ? "原始数据根目录" : "预览根目录"}</span>
        <div className="preview-path"><input value={location[key]} disabled={busy} onChange={(event) => setLocation({ ...location, [key]: event.target.value })} /><button className="icon-button" type="button" disabled={busy} title="选择目录" aria-label={key === "sourceRoot" ? "选择原始数据根目录" : "选择预览根目录"} onClick={() => void choose(key)}><FolderOpen size={17} /></button></div>
      </label>)}
      {error && <p role="alert">{error}</p>}
      <footer><button className="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { await setPreviewLocation({ sourceRoot: "", previewRoot: "" }); window.dispatchEvent(new Event("delta-preview-location")); setOpen(false); }
        catch (reason) { setError(String(reason)); }
        finally { setBusy(false); }
      }}>恢复自动</button><button className="button" disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="button button-primary" disabled={busy || !location.sourceRoot || !location.previewRoot} onClick={() => void save()}>{busy ? "保存中" : "保存"}</button></footer>
    </section></div>}
  </>;
}
