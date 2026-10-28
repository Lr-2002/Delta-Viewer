export interface MediaFailure { code: string; label: string; detail: string }

export function mediaFailure(reason: unknown): MediaFailure {
  const detail = reason instanceof Error ? reason.message : String(reason ?? "原因未知");
  // Classify stable diagnostics only. A generic decode/network error is not
  // sufficient evidence that the source file is damaged.
  const labels: Record<string, string> = {
    VIDEO_FILE_MISSING: "视频文件缺失",
    VIDEO_FILE_DAMAGED: "视频文件损坏",
    VIDEO_MANIFEST_INVALID: "视频清单异常",
    VIDEO_READ_FAILED: "视频读取失败",
  };
  const code = Object.keys(labels).find(code => detail.startsWith(`${code}:`));
  return code ? { code, label: labels[code], detail }
    : { code: "FRAME_READ_FAILED", label: "画面读取失败", detail: `画面读取失败，尚未确认是否为文件损坏。请检查共享目录连接与读取权限。原始错误：${detail}` };
}
