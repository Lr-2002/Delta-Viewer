/** A bounded head start for video IO; this never marks validation complete. */
export class PreviewPriority {
  private remaining: Set<string>;
  private finish!: () => void;
  private timer: ReturnType<typeof setTimeout>;
  readonly root: string;
  readonly ready: Promise<void>;
  constructor(root: string, streams: readonly string[], timeoutMs = 2500) {
    this.root = root;
    this.remaining = new Set(streams);
    this.ready = new Promise(resolve => { this.finish = resolve; });
    this.timer = setTimeout(() => this.close(), timeoutMs);
    if (!this.remaining.size) this.close();
  }
  presented(root: string, stream: string) {
    if (root !== this.root) return;
    this.remaining.delete(stream);
    if (!this.remaining.size) this.close();
  }
  close() { clearTimeout(this.timer); this.finish(); }
}
