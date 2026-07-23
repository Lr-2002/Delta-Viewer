export const FRAME_CACHE_MAX_PER_STREAM = 8;
export const FRAME_CACHE_MAX_ENTRIES = 40;
export const FRAME_READ_AHEAD_FRAMES = 2;

export interface FrameRequest {
  root: string;
  stream: string;
  frameId: number;
}

export interface CachedFrame extends FrameRequest {
  key: string;
  streamKey: string;
  source: string;
}

type FrameLoader = (request: FrameRequest) => Promise<string>;

export function frameStreamKey(root: string, stream: string): string {
  return `${root}\0${stream}`;
}

export function frameRequestKey({ root, stream, frameId }: FrameRequest): string {
  return `${frameStreamKey(root, stream)}\0${frameId}`;
}

export class FrameCache {
  private readonly ready = new Map<string, CachedFrame>();
  private readonly inFlight = new Map<string, Promise<CachedFrame>>();
  private readonly load: FrameLoader;

  constructor(load: FrameLoader) {
    this.load = load;
  }

  request(request: FrameRequest): Promise<CachedFrame> {
    const key = frameRequestKey(request);
    const cached = this.ready.get(key);
    if (cached) {
      this.touch(cached);
      return Promise.resolve(cached);
    }

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const loading = this.load(request).then((source) => {
      const frame: CachedFrame = {
        ...request,
        key,
        streamKey: frameStreamKey(request.root, request.stream),
        source,
      };
      this.remember(frame);
      return frame;
    });
    this.inFlight.set(key, loading);
    void loading.then(
      () => this.clearInFlight(key, loading),
      () => this.clearInFlight(key, loading),
    );
    return loading;
  }

  prefetch(request: FrameRequest): void {
    void this.request(request).catch(() => undefined);
  }

  get cachedFrameCount(): number {
    return this.ready.size;
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

  private clearInFlight(key: string, loading: Promise<CachedFrame>) {
    if (this.inFlight.get(key) === loading) this.inFlight.delete(key);
  }
}
