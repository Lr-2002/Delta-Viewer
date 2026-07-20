export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled >= 10 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatRate(bytes: number, milliseconds: number): string {
  if (!milliseconds) return "0 B/s";
  return `${formatBytes((bytes * 1000) / milliseconds)}/s`;
}

export function shortPath(path: string, maxLength = 48): string {
  if (path.length <= maxLength) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(separator);
  const tail = parts.slice(-3).join(separator);
  if (tail.length < maxLength - 2) return `…${separator}${tail}`;
  return `…${path.slice(-(maxLength - 1))}`;
}
