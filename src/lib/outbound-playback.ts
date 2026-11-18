export interface OutboundPlaybackState {
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
}

/** One transport owns all cameras. Media events never become new seek commands. */
export class OutboundPlayback {
  private players = new Map<number, HTMLVideoElement>();
  private listeners = new Map<number, () => void>();
  private intent = false;
  private held = false;
  private starting: number | null = null;
  private priming = false;
  private primingUntil = 0;
  private generation = 0;
  private speed = 1;
  private masterId: number | null = null;
  private timer: ReturnType<typeof setInterval>;

  constructor(private report: (state: OutboundPlaybackState) => void, private failed: () => void) {
    this.timer = setInterval(() => this.tick(), 160);
  }

  attach(id: number, player: HTMLVideoElement | null) {
    if (this.players.get(id) === player) return;
    this.listeners.get(id)?.();
    this.listeners.delete(id);
    this.players.delete(id);
    if (player) {
      this.players.set(id, player);
      player.playbackRate = this.speed;
      const waiting = () => {
        if (this.intent && !player.ended) this.hold();
      };
      const canplay = () => this.tick();
      const ended = () => { if (this.intent) this.pause(); };
      player.addEventListener("waiting", waiting);
      player.addEventListener("canplay", canplay);
      player.addEventListener("ended", ended);
      this.listeners.set(id, () => {
        player.removeEventListener("waiting", waiting);
        player.removeEventListener("canplay", canplay);
        player.removeEventListener("ended", ended);
        player.pause();
      });
    }
    this.publish();
  }

  private master() {
    return this.masterId === null ? this.players.get(Math.min(...this.players.keys())) : this.players.get(this.masterId);
  }

  setMaster(id: number | null) { this.masterId = id; this.publish(); }

  private publish() {
    const master = this.master();
    const durations = [...this.players.values()].map(v => v.duration).filter(v => Number.isFinite(v) && v > 0);
    this.report({ playing: this.intent, buffering: this.intent && this.held,
      position: master?.currentTime ?? 0, duration: durations.length ? Math.min(...durations) : 0 });
  }

  private hold() {
    this.held = true;
    // Keep the starved decoder trying to play. Pausing it at HAVE_CURRENT_DATA
    // can leave WebView2 waiting for canplay even after network bytes arrive.
    // Healthy peers wait here; canplay resumes them without a polling delay.
    for (const player of this.players.values())
      if (player.readyState >= 3) player.pause();
    this.publish();
  }

  play() {
    if (!this.players.size) return;
    this.intent = true;
    this.prime();
    this.generation++;
    const master = this.master()!;
    // A user start/seek may align once. Continuous playback never seeks peers.
    for (const player of this.players.values()) {
      if (player !== master && player.readyState >= 1 && Math.abs(player.currentTime - master.currentTime) > .12)
        player.currentTime = master.currentTime;
    }
    this.held = true;
    this.tick();
  }

  pause() {
    this.intent = false;
    this.held = false;
    this.priming = false;
    this.generation++;
    for (const player of this.players.values()) {
      player.pause();
      player.playbackRate = this.speed;
    }
    this.publish();
  }

  seek(time: number) {
    this.generation++;
    for (const player of this.players.values()) {
      player.pause();
      if (player.readyState >= 1)
        player.currentTime = Math.max(0, Math.min(time, Number.isFinite(player.duration) ? player.duration : time));
    }
    this.held = this.intent;
    if (this.intent) this.prime();
    this.publish();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    for (const player of this.players.values()) player.playbackRate = speed;
    this.publish();
  }

  refresh() { this.publish(); }

  private prime() {
    this.priming = true;
    this.primingUntil = performance.now() + 2000;
  }

  private hasStartupBuffer(player: HTMLVideoElement) {
    const needed = Math.min(1.25 * this.speed, Math.max(0, player.duration - player.currentTime - .04));
    for (let i = 0; i < player.buffered.length; i++) {
      if (player.buffered.start(i) <= player.currentTime + .02
        && player.buffered.end(i) - player.currentTime >= needed) return true;
    }
    return false;
  }

  private tick() {
    const master = this.master();
    if (this.intent && master) {
      if (master.ended) { this.pause(); return; }
      if (this.held) {
        // A decoded first frame may represent only .25 seconds of high-rate
        // video. Reserve a small lead once at start/seek, capped at two seconds;
        // ongoing recovery keeps the hungry decoder running as before.
        if (this.starting !== this.generation && [...this.players.values()].every(v => v.readyState >= 3 && !v.seeking
          && (!this.priming || performance.now() >= this.primingUntil || this.hasStartupBuffer(v)))) {
          const generation = this.generation;
          this.held = false;
          this.priming = false;
          this.starting = generation;
          void Promise.all([...this.players.values()].map(player => player.play())).catch(error => {
            // Our pause/seek can abort an in-flight play promise.
            if (generation === this.generation && this.intent && !this.held && error?.name !== "AbortError") {
              this.pause(); this.failed();
            }
          }).finally(() => { if (this.starting === generation) this.starting = null; });
        }
      } else {
        for (const player of this.players.values()) {
          if (player === master || player.seeking || player.readyState < 3) continue;
          // Small clock drift is corrected without discarding decoded frames.
          const drift = player.currentTime - master.currentTime;
          const rate = this.speed * (Math.abs(drift) < .08 ? 1 : Math.max(.92, Math.min(1.08, 1 - drift * .2)));
          if (Math.abs(player.playbackRate - rate) > .005) player.playbackRate = rate;
        }
      }
    }
    this.publish();
  }

  dispose() {
    this.intent = false;
    this.generation++;
    clearInterval(this.timer);
    for (const remove of this.listeners.values()) remove();
    this.listeners.clear();
    this.players.clear();
  }
}
