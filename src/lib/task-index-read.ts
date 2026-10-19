import type { TaskIndexResult } from "./task-center";

export async function taskIndexDeadline<T>(request: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("TASK_INDEX_TIMEOUT: 读取服务器统计超时，已保留上次结果。请重试；若持续超时，请检查共享目录访问或联系管理员。")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// SMB calls can outlive their UI deadline. Reuse the outstanding native read
// until it settles, so polling and retries cannot accumulate blocked workers.
export function createTaskIndexReader(
  read: (sourceRoot: string, relativePath: string, refreshId?: string) => Promise<TaskIndexResult>,
  timeoutMs = 20_000,
) {
  const pending = new Map<string, Promise<TaskIndexResult>>();
  return async (sourceRoot: string, relativePath = "", refreshId?: string): Promise<TaskIndexResult> => {
    const key = JSON.stringify([sourceRoot, relativePath, refreshId]);
    let request = pending.get(key);
    if (!request) {
      request = Promise.resolve().then(() => read(sourceRoot, relativePath, refreshId));
      pending.set(key, request);
      const clear = () => { if (pending.get(key) === request) pending.delete(key); };
      void request.then(clear, clear);
    }
    return taskIndexDeadline(request, timeoutMs);
  };
}
