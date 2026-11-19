export type ShortcutScope = "data" | "review" | "outbound";
export interface ShortcutDefinition { id: string; label: string; group: string; scopes: ShortcutScope[]; defaultKey: string }
const all: ShortcutScope[] = ["data", "review", "outbound"];
export const SHORTCUT_LABEL_LIMIT = 80;
export const SHORTCUTS: ShortcutDefinition[] = [
  {id:"previousRecording",label:"上一条数据",group:"数据导航",scopes:all,defaultKey:"PageUp"},
  {id:"nextRecording",label:"下一条数据",group:"数据导航",scopes:all,defaultKey:"PageDown"},
  {id:"togglePlayback",label:"播放／暂停",group:"视频回放",scopes:all,defaultKey:"Space"},
  {id:"previousFrame",label:"上一帧／边界向前一帧",group:"视频回放",scopes:all,defaultKey:"ArrowLeft"},
  {id:"nextFrame",label:"下一帧／边界向后一帧",group:"视频回放",scopes:all,defaultKey:"ArrowRight"},
  {id:"previousSegment",label:"上一片段",group:"视频回放",scopes:["review","outbound"],defaultKey:"ArrowUp"},
  {id:"nextSegment",label:"下一片段",group:"视频回放",scopes:["review","outbound"],defaultKey:"ArrowDown"},
  {id:"rangeStart",label:"跳到播放范围开头",group:"视频回放",scopes:all,defaultKey:"Home"},
  {id:"rangeEnd",label:"跳到播放范围结尾",group:"视频回放",scopes:all,defaultKey:"End"},
  {id:"slower",label:"降低播放速度",group:"视频回放",scopes:["data","outbound"],defaultKey:"Minus"},
  {id:"faster",label:"提高播放速度",group:"视频回放",scopes:["data","outbound"],defaultKey:"Equal"},
  {id:"mute",label:"主相机静音／恢复声音",group:"视频回放",scopes:["outbound"],defaultKey:"KeyM"},
  {id:"clipStart",label:"将当前帧设为裁剪起点",group:"标注与校对",scopes:["data"],defaultKey:"BracketLeft"},
  {id:"clipEnd",label:"将当前帧设为裁剪终点",group:"标注与校对",scopes:["data"],defaultKey:"BracketRight"},
  {id:"splitSegment",label:"在当前帧分割片段",group:"标注与校对",scopes:["review"],defaultKey:"KeyX"},
  {id:"approveReview",label:"审核通过（本地／云端校对）",group:"标注与校对",scopes:["review"],defaultKey:"Enter"},
  ...Array.from({length:SHORTCUT_LABEL_LIMIT},(_,i)=>({id:`label${i+1}`,label:`常用标签 ${i+1}`,group:"常用标签序号",scopes:["review"] as ShortcutScope[],defaultKey:String(i+1).split("").map(n=>`Digit${n}`).join(" ")})),
];
export type ShortcutBindings = Record<string,string>;
export const DEFAULT_SHORTCUTS: ShortcutBindings = Object.fromEntries(SHORTCUTS.map(s=>[s.id,s.defaultKey]));
const codes = /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|PageUp|PageDown|Home|End|BracketLeft|BracketRight|Comma|Period|Minus|Equal|Slash|Backslash|Semicolon|Quote|Enter|F([1-9]|1[0-2]))$/;
const modifiers = ["Ctrl","Alt","Shift","Meta"];
export function shortcutChord(event: Pick<KeyboardEvent,"code"|"key"|"ctrlKey"|"altKey"|"shiftKey"|"metaKey"|"isComposing">): string | null {
  if(event.isComposing)return null;
  const aliases:Record<string,string>={" ":"Space","[":"BracketLeft","]":"BracketRight","-":"Minus","=":"Equal",",":"Comma",".":"Period","/":"Slash","\\":"Backslash",";":"Semicolon","'":"Quote"};
  const code=event.code||aliases[event.key]||(/^[a-z]$/i.test(event.key)?`Key${event.key.toUpperCase()}`:/^[0-9]$/.test(event.key)?`Digit${event.key}`:event.key);
  if(!codes.test(code))return null;
  return [...[event.ctrlKey,event.altKey,event.shiftKey,event.metaKey].flatMap((on,i)=>on?[modifiers[i]]:[]),code].join("+");
}
export function validShortcut(value:string):boolean {
  if(value==="")return true;
  const parts=value.split("+");const code=parts.pop()!;
  if(!codes.test(code)||parts.some((p,i)=>!modifiers.includes(p)||parts.indexOf(p)!==i)||parts.join("+")!==modifiers.filter(p=>parts.includes(p)).join("+"))return false;
  // Keep application/window lifecycle and browser reload keys available.
  return !["F5","F11","F12","Alt+F4","Ctrl+KeyW","Meta+KeyW","Ctrl+KeyR","Meta+KeyR","Ctrl+Shift+KeyR","Meta+Shift+KeyR","Ctrl+KeyN","Meta+KeyN","Ctrl+KeyT","Meta+KeyT","Ctrl+Shift+KeyT","Meta+Shift+KeyT"].includes(value);
}
export function shortcutConflicts(bindings:ShortcutBindings):[string,string][] {
  const conflicts:[string,string][]=[];
  for(let i=0;i<SHORTCUTS.length;i++)for(const b of SHORTCUTS.slice(i+1)){
    const a=SHORTCUTS[i],left=bindings[a.id],right=bindings[b.id];
    // Data navigation remains mounted while the local/cloud review editor is open.
    const overlaps=a.scopes.some(scope=>b.scopes.includes(scope)||scope==="data"&&b.scopes.includes("review")||scope==="review"&&b.scopes.includes("data"));
    if(!left||!right||!overlaps)continue;
    const numbered=a.id.startsWith("label")&&b.id.startsWith("label")&&left===a.defaultKey&&right===b.defaultKey;
    if(left===right||!numbered&&(left.startsWith(right+" ")||right.startsWith(left+" ")))conflicts.push([a.id,b.id]);
  }
  return conflicts;
}
export function normalizeShortcuts(value:unknown):ShortcutBindings {
  const result={...DEFAULT_SHORTCUTS};
  if(!value||typeof value!=="object"||Array.isArray(value))return result;
  for(const item of SHORTCUTS){const key=(value as ShortcutBindings)[item.id];if(typeof key==="string"&&(validShortcut(key)||item.id.startsWith("label")&&key===item.defaultKey))result[item.id]=key;}
  return shortcutConflicts(result).length?{...DEFAULT_SHORTCUTS}:result;
}
export function matchShortcut(event:KeyboardEvent,bindings:ShortcutBindings,scope:ShortcutScope,actions:string[]):string|undefined {
  if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
  const chord=shortcutChord(event);if(!chord)return;
  return SHORTCUTS.find(s=>actions.includes(s.id)&&s.scopes.includes(scope)&&bindings[s.id]===chord)?.id;
}
export function shortcutBlocked(event:KeyboardEvent,allowReviewControls=false):boolean {
  if(event.defaultPrevented||event.isComposing||event.keyCode===229||document.querySelector("dialog[open], [role='dialog']"))return true;
  const target=event.target instanceof Element?event.target:null;
  return Boolean(target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")||target?.closest("button, a")&&["Enter"," "].includes(event.key)&&!(allowReviewControls&&target.closest(".machine-segment-description, .review-span, .review-edge")));
}
export function formatShortcut(key:string):string {
  const names:Record<string,string>={Space:"Space",ArrowLeft:"←",ArrowRight:"→",ArrowUp:"↑",ArrowDown:"↓",BracketLeft:"[",BracketRight:"]",Minus:"−",Equal:"=",Comma:",",Period:".",Slash:"/",Backslash:"\\",Semicolon:";",Quote:"'",Meta:"Cmd"};
  return key.split(" ").map(stroke=>stroke.split("+").map(code=>names[code]??code.replace(/^Key|^Digit/,"")).join(" + ")).join(" → ");
}
export function labelShortcutCandidates(bindings:ShortcutBindings,digits:string,count:number):number[] {
  return Array.from({length:Math.min(count,SHORTCUT_LABEL_LIMIT)},(_,i)=>i+1).filter(n=>String(n).startsWith(digits)&&bindings[`label${n}`]===DEFAULT_SHORTCUTS[`label${n}`]);
}
