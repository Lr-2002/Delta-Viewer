import { useEffect, useState } from "react";
import { APP_VERSION, pollClientVersions } from "../lib/backend";
import type { ClientPoll, UpdateReminder } from "../types";
import { clientInstallationId } from "../lib/client-versions";

function installationId() {
  try { return clientInstallationId(localStorage, APP_VERSION); }
  catch { return crypto.randomUUID(); }
}
function savedAcknowledgements(owner: string) {
  try {
    const data = JSON.parse(localStorage.getItem(`delta.reminder-acks:${owner}`) ?? "[]");
    return new Set<string>(Array.isArray(data) ? data.filter((id): id is string => typeof id === "string").slice(-20) : []);
  } catch { return new Set<string>(); }
}

export function useClientUpdateReminder(owner: string | null, poll: (id: string, ack: string[]) => Promise<ClientPoll> = pollClientVersions) {
  const [received, setReceived] = useState<{owner: string; reminder: UpdateReminder} | null>(null);
  const [id]=useState(installationId);
  const [acknowledgements] = useState(() => new Map<string, Set<string>>());
  const reminder = owner && received?.owner === owner ? received.reminder : null;
  useEffect(()=>{
    setReceived(previous => previous?.owner === owner ? previous : null);
    if (!owner) return;
    const currentOwner = owner;
    const ack = acknowledgements.get(currentOwner) ?? savedAcknowledgements(currentOwner);
    acknowledgements.set(currentOwner, ack);
    let active=true, inFlight=false;
    async function refresh() {
      if(inFlight)return;
      inFlight=true;
      const sent=[...ack];
      try {
        const next=await poll(id,sent);
        if(!active)return;
        for(const id of sent)ack.delete(id);
        try {localStorage.setItem(`delta.reminder-acks:${currentOwner}`,JSON.stringify([...ack]));} catch { /* Retry in this session. */ }
        const reminder = next.reminder && !ack.has(next.reminder.id) ? next.reminder : null;
        setReceived(previous => !reminder ? null
          : previous?.owner === currentOwner && previous.reminder.id === reminder.id ? previous : {owner: currentOwner, reminder});
      } catch { /* Presence failure must never block reviewing or claim fresh versions. */ }
      finally {inFlight=false;}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),15_000);
    const online=()=>void refresh();window.addEventListener("online",online);
    const visible=()=>{if(document.visibilityState === "visible")void refresh();};
    window.addEventListener("focus",online);document.addEventListener("visibilitychange",visible);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener("online",online);window.removeEventListener("focus",online);document.removeEventListener("visibilitychange",visible);};
  },[owner,id,acknowledgements,poll]);
  function dismiss() {
    if(!owner || !reminder)return;
    const ack = acknowledgements.get(owner) ?? savedAcknowledgements(owner);
    if (ack.has(reminder.id)) return;
    acknowledgements.set(owner, ack);
    ack.add(reminder.id);
    try {localStorage.setItem(`delta.reminder-acks:${owner}`,JSON.stringify([...ack]));} catch { /* Memory acknowledgement remains. */ }
    setReceived(previous => previous?.owner === owner && previous.reminder.id === reminder.id ? null : previous);
  }
  return {reminder, dismiss};
}
