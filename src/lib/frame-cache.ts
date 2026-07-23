export const FRAME_CACHE_MAX_PER_STREAM = 8;
export const FRAME_CACHE_MAX_ENTRIES = 40;
export const FRAME_READ_AHEAD_FRAMES = 2;
export const FRAME_MAX_IN_FLIGHT_PER_STREAM = 1;
export const FRAME_MAX_QUEUED_PER_STREAM = 1 + FRAME_READ_AHEAD_FRAMES;
export const FRAME_MAX_PENDING_PER_STREAM = FRAME_MAX_IN_FLIGHT_PER_STREAM + FRAME_MAX_QUEUED_PER_STREAM;

export interface FrameRequest {
  root: string;
  stream: string;
  frameId: number;
}

export interface ReadAheadRequest extends FrameRequest {
  endFrame: number;
}

export interface CachedFrame extends FrameRequest {
  key: string;
  streamKey: string;
  source: string;
}

type FrameLoader = (request: FrameRequest) => Promise<string>;
type RequestPriority = "current" | "prefetch";

interface ScheduledFrame {
  key: string;
  priority: RequestPriority;
  request: FrameRequest;
  resolve: (frame: CachedFrame) => void;
  reject: (reason?: unknown) => void;
  streamKey: string;
  promise: Promise<CachedFrame>;
}

export class FrameRequestSupersededError extends Error {
  constructor() {
    super("Frame request superseded by a newer playback target");
    this.name = "FrameRequestSupersededError";
  }
}

export function frameStreamKey(root: string, stream: string): string {
  return `${root}\0${stream}`;
}

export function frameRequestKey({ root, stream, frameId }: FrameRequest): string {
  return `${frameStreamKey(root, stream)}\0${frameId}`;
}

export class FrameCache {
  private readonly activeByStream = new Map<string, ScheduledFrame>();
  private readonly ready = new Map<string, CachedFrame>();
  private readonly pending = new Map<string, ScheduledFrame>();
  private readonly queuedByStream = new Map<string, ScheduledFrame[]>();
  private readonly load: FrameLoader;

  constructor(load: FrameLoader) {
    this.load = load;
  }

  requestCurrent(request: FrameRequest): Promise<CachedFrame> {
    const key = frameRequestKey(request);
    const streamKey = frameStreamKey(request.root, request.stream);
    // A cache hit still represents a new playback target, so it must clear stale queued reads.
    this.discardQueuedExcept(streamKey, key);
    const cached = this.ready.get(key);
    if (cached) {
      this.touch(cached);
      return Promise.resolve(cached);
    }

    const pending = this.pending.get(key);
    if (pending) {
      this.promoteCurrent(pending);
      return pending.promise;
    }

    const scheduled = this.enqueue(request, "current");
    this.drain(streamKey);
    return scheduled.promise;
  }

  scheduleReadAhead({ endFrame, ...request }: ReadAheadRequest): void {
    const readAheadEnd = Math.min(endFrame, request.frameId + FRAME_READ_AHEAD_FRAMES);
    for (let frameId = request.frameId + 1; frameId <= readAheadEnd; frameId += 1) {
      this.enqueuePrefetch({ ...request, frameId });
    }
  }

  discardReadAhead(root: string, stream: string): void {
    const streamKey = frameStreamKey(root, stream);
    const queue = this.queuedByStream.get(streamKey);
    if (!queue?.length) return;

    const retained = queue.filter((scheduled) => {
      if (scheduled.priority !== "prefetch") return true;
      this.pending.delete(scheduled.key);
      scheduled.reject(new FrameRequestSupersededError());
      return false;
    });
    this.replaceQueue(streamKey, retained);
  }

  get cachedFrameCount(): number {
    return this.ready.size;
  }

  get pendingWorkCount(): number {
    return this.pending.size;
  }

  pendingWorkCountForStream(root: string, stream: string): number {
    const streamKey = frameStreamKey(root, stream);
    let count = 0;
    for (const scheduled of this.pending.values()) {
      if (scheduled.streamKey === streamKey) count += 1;
    }
    return count;
  }

  private enqueuePrefetch(request: FrameRequest) {
    const key = frameRequestKey(request);
    if (this.ready.has(key) || this.pending.has(key)) return;

    const streamKey = frameStreamKey(request.root, request.stream);
    const queue = this.queuedByStream.get(streamKey) ?? [];
    const prefetchCount = queue.filter((scheduled) => scheduled.priority === "prefetch").length;
    if (prefetchCount >= FRAME_READ_AHEAD_FRAMES || queue.length >= FRAME_MAX_QUEUED_PER_STREAM) return;

    const scheduled = this.enqueue(request, "prefetch");
    // Read-ahead is best-effort. A newer target may intentionally supersede it.
    void scheduled.promise.catch(() => undefined);
    this.drain(streamKey);
  }

  private enqueue(request: FrameRequest, priority: RequestPriority): ScheduledFrame {
    const key = frameRequestKey(request);
    const streamKey = frameStreamKey(request.root, request.stream);
    let resolve!: (frame: CachedFrame) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<CachedFrame>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const scheduled: ScheduledFrame = { key, priority, request, resolve, reject, streamKey, promise };
    const queue = this.queuedByStream.get(streamKey) ?? [];
    if (priority === "current") queue.unshift(scheduled);
    else queue.push(scheduled);
    this.queuedByStream.set(streamKey, queue);
    this.pending.set(key, scheduled);
    return scheduled;
  }

  private promoteCurrent(scheduled: ScheduledFrame) {
    if (scheduled.priority === "current") return;
    scheduled.priority = "current";
    const queue = this.queuedByStream.get(scheduled.streamKey);
    if (!queue) return;
    const index = queue.indexOf(scheduled);
    if (index < 0) return;
    queue.splice(index, 1);
    queue.unshift(scheduled);
  }

  private discardQueuedExcept(streamKey: string, key: string) {
    const queue = this.queuedByStream.get(streamKey);
    if (!queue?.length) return;

    const retained = queue.filter((scheduled) => {
      if (scheduled.key === key) return true;
      this.pending.delete(scheduled.key);
      scheduled.reject(new FrameRequestSupersededError());
      return false;
    });
    this.replaceQueue(streamKey, retained);
  }

  private drain(streamKey: string) {
    if (this.activeByStream.has(streamKey)) return;
    const queue = this.queuedByStream.get(streamKey);
    if (!queue?.length) {
      this.queuedByStream.delete(streamKey);
      return;
    }
    const scheduled = queue.shift();
    if (!scheduled) return;
    this.replaceQueue(streamKey, queue);
    this.activeByStream.set(streamKey, scheduled);

    void Promise.resolve()
      .then(() => this.load(scheduled.request))
      .then(
        (source) => {
          const frame: CachedFrame = {
            ...scheduled.request,
            key: scheduled.key,
            streamKey,
            source,
          };
          this.remember(frame);
          scheduled.resolve(frame);
          this.finish(scheduled);
        },
        (reason) => {
          scheduled.reject(reason);
          this.finish(scheduled);
        },
      );
  }

  private finish(scheduled: ScheduledFrame) {
    if (this.activeByStream.get(scheduled.streamKey) === scheduled) {
      this.activeByStream.delete(scheduled.streamKey);
    }
    this.pending.delete(scheduled.key);
    this.drain(scheduled.streamKey);
  }

  private replaceQueue(streamKey: string, queue: ScheduledFrame[]) {
    if (queue.length) this.queuedByStream.set(streamKey, queue);
    else this.queuedByStream.delete(streamKey);
  }

  private touch(frame: CachedFrame) {
    this.ready.delete(frame.key);
    this.ready.set(frame.key, frame);
  }

  private remember(frame: CachedFrame) {
    this.touch(frame);
    this.evictStreamOverflow(frame.streamKey);
    while (this.ready.size > FRAME_CACHE_MAX_ENTRIES) {
      const oldest = this.ready.keys().next().value as string | undefined;
      if (!oldest) break;
      this.ready.delete(oldest);
    }
  }

  private evictStreamOverflow(streamKey: string) {
    let matchingFrames = 0;
    for (const frame of this.ready.values()) {
      if (frame.streamKey === streamKey) matchingFrames += 1;
    }
    if (matchingFrames <= FRAME_CACHE_MAX_PER_STREAM) return;

    for (const [key, frame] of this.ready) {
      if (frame.streamKey !== streamKey) continue;
      this.ready.delete(key);
      matchingFrames -= 1;
      if (matchingFrames <= FRAME_CACHE_MAX_PER_STREAM) return;
    }
  }
}
