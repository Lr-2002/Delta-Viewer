import {createContext,useContext,useEffect,useMemo,useState,type ReactNode} from "react";
import {DEFAULT_SHORTCUTS,normalizeShortcuts,shortcutConflicts,type ShortcutBindings} from "./shortcuts";

const Context=createContext<ShortcutBindings>(DEFAULT_SHORTCUTS);
export function ShortcutProvider({bindings,children}:{bindings:ShortcutBindings;children:ReactNode}){return <Context.Provider value={bindings}>{children}</Context.Provider>;}
export const useShortcuts=()=>useContext(Context);
export const shortcutStorageKey=(owner:string)=>`d1-manager.shortcuts.v1:${encodeURIComponent(owner)}`;
function read(owner:string):ShortcutBindings {
  if(!owner)return {...DEFAULT_SHORTCUTS};
  try{return normalizeShortcuts(JSON.parse(localStorage.getItem(shortcutStorageKey(owner))??"null"));}catch{return {...DEFAULT_SHORTCUTS};}
}
export function useShortcutPreferences(owner:string){
  const [state,setState]=useState(()=>({owner,bindings:read(owner)}));
  const bindings=useMemo(()=>state.owner===owner?state.bindings:read(owner),[state,owner]);
  useEffect(()=>{const changed=(e:StorageEvent)=>{if(e.key===shortcutStorageKey(owner)||e.key===null)setState({owner,bindings:read(owner)});};window.addEventListener("storage",changed);return()=>window.removeEventListener("storage",changed);},[owner]);
  function save(next:ShortcutBindings){
    if(!owner)throw Error("请先进入工作区。");
    if(shortcutConflicts(next).length)throw Error("快捷键存在冲突，请先修改。");
    const normalized=normalizeShortcuts(next),raw=JSON.stringify(normalized),key=shortcutStorageKey(owner);
    if(Object.keys(normalized).some(id=>normalized[id]!==next[id]))throw Error("快捷键无效，请重新设置。");
    localStorage.setItem(key,raw);
    if(localStorage.getItem(key)!==raw)throw Error("无法保存快捷键，请重试。");
    setState({owner,bindings:normalized});
  }
  return {bindings,save};
}
