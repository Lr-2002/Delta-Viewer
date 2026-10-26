import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION, pollClientVersions } from "../lib/backend";
import type { ClientPoll, UpdateReminder } from "../types";
import { UpdateToast } from "./UpdateToast";

function installationId() {
  const key=`delta.client-installation.v1:${APP_VERSION}`;
  try { const id=localStorage.getItem(key); if (id && /^[a-f0-9-]{36}$/.test(id)) return id;
    const next=crypto.randomUUID(); localStorage.setItem(key,next); return next;
  } catch { return crypto.randomUUID(); }
}
export function ClientPresence({ owner, poll = pollClientVersions }: {
  owner: string; poll?: (id: string, ack: string[]) => Promise<ClientPoll>;
}) {
  const [reminder,setReminder]=useState<UpdateReminder|null>(null);
  const [id]=useState(installationId);
  const [ack]=useState(()=>{
    try {const data=JSON.parse(localStorage.getItem(`delta.reminder-acks:${owner}`)??"[]");
      return new Set<string>(Array.isArray(data)?data.filter((id):id is string=>typeof id==="string").slice(-20):[]);
    } catch {return new Set<string>();}
  });
  useEffect(()=>{
    let active=true, inFlight=false;
    async function refresh() {
      if(inFlight)return;
      inFlight=true;
      const sent=[...ack];
      try {
        const next=await poll(id,sent);
        if(!active)return;
        for(const id of sent)ack.delete(id);
        try {localStorage.setItem(`delta.reminder-acks:${owner}`,JSON.stringify([...ack]));} catch { /* Retry in this session. */ }
        setReminder(next.reminder && !ack.has(next.reminder.id)?next.reminder:null);
      } catch { /* Presence failure must never block reviewing or claim fresh versions. */ }
      finally {inFlight=false;}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),15_000);
    const online=()=>void refresh();window.addEventListener("online",online);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener("online",online);};
  },[owner,id,ack,poll]);
  function dismiss() {
    if(!reminder)return;
    ack.add(reminder.id);
    try {localStorage.setItem(`delta.reminder-acks:${owner}`,JSON.stringify([...ack]));} catch { /* Memory acknowledgement remains. */ }
    setReminder(null);
  }
  return reminder?createPortal(<UpdateToast key={reminder.id} autoDismiss={false} className="admin-update-reminder" ariaLabel="管理员更新提醒"
    title="管理员提醒您更新 Delta Viewer"
    message={`@${reminder.sender} 请您检查最新版本。当前审核内容保留，您可以在合适的时间更新。`}
    primaryLabel="查看更新" secondaryLabel="稍后处理"
    onPrimary={()=>window.dispatchEvent(new Event("delta-open-update-panel"))} onDismiss={dismiss}/>,document.body):null;
}
