import { useState } from "react";
import type { MachineAnnotation } from "../types";

export function MachineIdentityNotice({ username, root, result }: {
  username: string; root: string; result: MachineAnnotation;
}) {
  const storageKey = `delta.machine-identity.ignored.v1:${JSON.stringify([username, root, result.sourceName ?? ""])}`;
  const signature = JSON.stringify([result.sourceHash, result.identityWarning, result.identityVerified]);
  const [ignored, setIgnored] = useState(() => {
    try { return localStorage.getItem(storageKey) === signature; } catch { return false; }
  });
  function toggle(next: boolean) {
    setIgnored(next);
    try {
      if (next) localStorage.setItem(storageKey, signature);
      else localStorage.removeItem(storageKey);
    } catch { /* The choice still applies for this open record. */ }
  }
  if (ignored) return <button type="button" className="text-button machine-identity-restore" onClick={() => toggle(false)}>查看已忽略的编号提示</button>;
  return <div className="machine-boundary-warning" role="region" aria-label="机标编号核对提示">
    <strong>{result.identityVerified ? "目录与机标编号不同，来源核验已通过" : "目录与机标编号不同，已兼容读取，请核对内容"}</strong>
    <p>{result.identityWarning}</p>
    <button type="button" className="text-button machine-identity-ignore" onClick={() => toggle(true)}>忽略本条提示</button>
  </div>;
}
