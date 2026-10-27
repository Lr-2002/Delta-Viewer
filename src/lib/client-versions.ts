import type { ClientVersionReport } from "../types";

const validId = (id: string | null): id is string => Boolean(id && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id));

/** Reuse the installation across upgrades, without deleting older reports or account data. */
export function clientInstallationId(storage: Storage, version: string): string {
  const key = "delta.client-installation.v2";
  try {
    const saved = storage.getItem(key);
    if (validId(saved)) return saved;
    const current = storage.getItem(`delta.client-installation.v1:${version}`);
    const oldKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((item): item is string => Boolean(item?.startsWith("delta.client-installation.v1:")))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    const id = (validId(current) ? current : oldKeys.map(item => storage.getItem(item)).find(validId)) ?? crypto.randomUUID();
    storage.setItem(key, id);
    return id;
  } catch { return crypto.randomUUID(); }
}

export function currentClientVersion(clients: ClientVersionReport[], generatedAtMs: number, now = Date.now()) {
  // A stale or failed response must never present a historical version as currently running.
  const online = clients.filter(client => client.online && now - client.lastSeenAtMs < 90_000 && now - generatedAtMs < 90_000)
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs || a.clientId.localeCompare(b.clientId));
  return { current: online[0] ?? null, otherVersions: new Set(online.slice(1).map(client => client.version).filter(version => version !== online[0]?.version)).size };
}
