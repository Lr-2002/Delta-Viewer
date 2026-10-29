import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { chooseDirectory, loadSkeletonModel, skeletonModelLibrary, reviewIdentityPath } from '../lib/backend';
import { MODEL_LIBRARY_ENABLED, modelCandidate, modelLibraryEnabled } from '../lib/skeleton-library';
import type { SkeletonLibraryInfo, SkeletonSeries } from '../types';
interface Props {
  root?: string;
  disabled: boolean;
  onLibrary: (info: SkeletonLibraryInfo | null) => void;
  onModel: (series: SkeletonSeries | null) => void;
  onBusy: (busy: boolean) => void;
}
export function SkeletonModelPicker({root, disabled, onLibrary, onModel, onBusy}: Props) {
  const [info,setInfo]=useState<SkeletonLibraryInfo|null>(null);
  const [selected,setSelected]=useState('old');
  const [historicalMatch,setHistoricalMatch]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const generation=useRef(0);
  const callbacks=useRef({onLibrary,onModel,onBusy}); callbacks.current={onLibrary,onModel,onBusy};
  useEffect(()=>{
    generation.current++; setSelected('old'); setError(''); callbacks.current.onModel(null);
    return ()=>{generation.current++;};
  },[root]);
  useEffect(()=>{
    let active=true;
    if(modelLibraryEnabled()) void skeletonModelLibrary().then(value=>{if(active){setInfo(value);callbacks.current.onLibrary(value);}}).catch(reason=>{if(active)setError(String(reason));});
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{
    let active=true; setHistoricalMatch(false);
    if(root&&info&&!modelCandidate(root,info)) void reviewIdentityPath(root).then(path=>{if(active)setHistoricalMatch(modelCandidate(path,info));}).catch(()=>undefined);
    return ()=>{active=false;};
  },[root,info]);
  async function configure(refresh=false) {
    setError('');setBusy(true);callbacks.current.onBusy(true); const own=++generation.current;
    try {
      const path=refresh?undefined:await chooseDirectory('选择独立骨架模型库（含 catalog.json）');
      if(path===null)return;
      const next=await skeletonModelLibrary(path);
      if(own!==generation.current)return;
      setInfo(next);callbacks.current.onLibrary(next);setSelected('old');callbacks.current.onModel(null);
      try { localStorage.setItem(MODEL_LIBRARY_ENABLED,'1'); }
      catch { setError('模型库已配置；本机偏好保存失败，下次打开需重新选择模型库。'); }
    } catch(reason){if(own===generation.current)setError(String(reason));}
    finally{setBusy(false);callbacks.current.onBusy(false);}
  }
  async function select(value:string) {
    if(value==='old'){generation.current++;setSelected('old');callbacks.current.onModel(null);setError('');return;}
    if(!root||!info)return;
    const own=++generation.current;setBusy(true);callbacks.current.onBusy(true);setError('');
    try {
      const series=await loadSkeletonModel(root,info.revision);
      if(own===generation.current){callbacks.current.onModel(series);setSelected('new');}
    }catch(reason){if(own===generation.current){setError(String(reason));setSelected('old');callbacks.current.onModel(null);}}
    finally{setBusy(false);callbacks.current.onBusy(false);}
  }
  const available=Boolean(root&&(modelCandidate(root,info)||historicalMatch));
  return <div className="skeleton-model-picker">
    <label>骨架模型<select aria-label="骨架模型" value={selected} disabled={!root||disabled||busy} onChange={e=>void select(e.target.value)}>
      <option value="old">原目录骨架（默认）</option>
      <option value="new" disabled={!available}>{info?.model?.label??'新模型 · 1080p实验'}{available?'':'（本条未列入）'}</option>
    </select></label>
    <div className="skeleton-model-actions">
      <button className="button button-secondary" type="button" disabled={disabled||busy} onClick={()=>void configure()}><FolderOpen size={14}/>骨架模型库</button>
      {info?.root&&<button className="icon-button" title={`刷新模型库：${info.root}`} aria-label="刷新骨架模型库" disabled={disabled||busy} onClick={()=>void configure(true)}><RefreshCw size={14}/></button>}
    </div>
    <div className="skeleton-model-status" aria-live="polite">
      {error ? <p role="alert" className="skeleton-model-error">{error}</p>
        : busy ? <span role="status">正在校验骨架模型…</span>
        : <span className="skeleton-model-caption">{selected==='new' ? '1080p 实验 · 处理骨架 · 单位及标定未验收'
          : available ? '新模型可选，载入时核验'
          : !root ? '加载数据后可切换骨架模型'
          : info?.root ? '本条未列入模型库，使用原目录骨架' : '可选独立模型库，默认使用原目录骨架'}</span>}
    </div>
  </div>;
}
