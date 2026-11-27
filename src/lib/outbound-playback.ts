export interface OutboundPlaybackState {
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
}

const STALL_TIMEOUT_MS = 12_000;

/** One transport owns all cameras. Media events never become new seek commands. */
export class OutboundPlayback {
  private players = new Map<number, HTMLVideoElement>();
  private listeners = new Map<number, () => void>();
  private decodeGaps = new Map<number, ReturnType<typeof setTimeout>>();
  private intent = false;
  private held = false;
  private starting: object | null = null;
  private priming = false;
  private primingUntil = 0;
  private recoveryUntil = 0;
  private preparedUntil = 0;
  private progressAt = 0;
  private progressPosition = 0;
  private generation = 0;
  private speed = 1;
  private browsing = false;
  private browsePosition: number | null = null;
  private browseTarget: number | null = null;
  private browseAt = 0;
  private boundary: { at: number; reached: () => void } | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  private masterId: number | null = null;
  private timer: ReturnType<typeof setInterval>;

  constructor(private report: (state: OutboundPlaybackState) => void, private failed: () => void, private finished: () => void = () => {}, private stalled: (position: number) => void = () => {}) {
    this.timer = setInterval(() => this.tick(), 160);
  }

  attach(id: number, player: HTMLVideoElement | null) {
    if (this.players.get(id) === player) return;
    this.clearDecodeGap(id);
    this.listeners.get(id)?.();
    this.listeners.delete(id);
    this.players.delete(id);
    if (player) {
      this.players.set(id, player);
      player.defaultPlaybackRate = this.speed;
      player.playbackRate = this.speed;
      const waiting = () => {
        if (this.sampled()) return;
        // WebView2 may deliver an old waiting event after decoding recovered.
        // Treating it as a fresh stall flushes all seven healthy decoders.
        if (!this.intent || this.held || player.ended || player.seeking || player.readyState >= 3) return;
        // Starting a predecoded group can briefly exhaust decoder output
        // even when the source bytes for the next frames are already local.
        const prepared = performance.now() < this.preparedUntil;
        if (prepared && this.hasBuffer(player, Math.min(this.speed * .25, Math.max(0, player.duration - player.currentTime - .04)))) {
          const master = this.master();
          if (master && Math.abs(master.currentTime - player.currentTime) < .12) return;
        }
        if (!this.hasBuffer(player, this.speed * .25)) {
          this.hold(true);
          return;
        }
        if (this.decodeGaps.has(id)) return;
        const generation = this.generation;
        // Coalesce sub-frame decode gaps only when compressed media is ahead.
        // A sustained stall still holds peers within .12 media seconds; no
        // grace applies to missing data or active seeks.
        this.decodeGaps.set(id, setTimeout(() => {
          this.decodeGaps.delete(id);
          if (generation === this.generation && this.intent && this.players.get(id) === player
            && !player.ended && !player.seeking && player.readyState < 3) this.hold();
        }, Math.min(this.speed < 3 ? 60 : 30, 120 / this.speed)));
      };
      const canplay = () => {
        if (player.readyState >= 3) this.clearDecodeGap(id);
        if (!this.intent || this.held || this.sampled()) this.tick();
      };
      const ended = () => this.tick();
      player.addEventListener("waiting", waiting);
      player.addEventListener("canplay", canplay);
      player.addEventListener("seeked", canplay);
      player.addEventListener("ended", ended);
      this.listeners.set(id, () => {
        player.removeEventListener("waiting", waiting);
        player.removeEventListener("canplay", canplay);
        player.removeEventListener("seeked", canplay);
        player.removeEventListener("ended", ended);
        player.pause();
      });
    }
    this.publish();
  }

  private master() {
    const preferred = this.masterId === null ? this.players.get(Math.min(...this.players.keys())) : this.players.get(this.masterId);
    // A shorter camera freezes its last frame; it must not truncate another
    // camera's tail or advance the whole recording prematurely.
    const longest = [...this.players.values()].filter(p=>Number.isFinite(p.duration)&&p.duration>0)
      .sort((a,b)=>b.duration-a.duration)[0];
    return longest && (!preferred || longest.duration > preferred.duration+.05) ? longest : preferred;
  }

  setMaster(id: number | null) { this.masterId = id; this.publish(); }

  private publish() {
    const master = this.master();
    const durations = [...this.players.values()].map(v => v.duration).filter(v => Number.isFinite(v) && v > 0);
    this.report({ playing: this.intent, buffering: this.intent && this.held,
      position: this.sampled() ? this.browsePosition ?? master?.currentTime ?? 0 : master?.currentTime ?? 0,
      duration: durations.length ? Math.max(...durations) : 0 });
  }

  private sampled() { return this.browsing && this.speed > 3; }

  setBrowsing(enabled: boolean) {
    if (this.browsing === enabled) return;
    const resume = this.intent;
    this.pause();
    this.browsing = enabled;
    this.browsePosition = this.master()?.currentTime ?? 0;
    if (resume) this.play();
    else this.publish();
  }

  private browseTick() {
    const now = performance.now();
    // A single seek per camera may be in flight. Never queue skipped samples
    // behind a slow network or decoder, or report time that wasn't displayed.
    if ([...this.players.values()].some(v => v.seeking || v.readyState < 2 || v.error)) {
      this.held = now - this.browseAt >= 500;
      return;
    }
    this.held = false;
    if (this.browseTarget !== null) {
      this.browsePosition = this.browseTarget;
      this.browseTarget = null;
    }
    const end = Math.max(...[...this.players.values()].map(v => Number.isFinite(v.duration) ? v.duration : 0));
    if ((this.browsePosition ?? 0) >= end) { this.pause(); this.finished(); return; }
    if (now - this.browseAt < 250) return;
    const target = Math.min(end, (this.browsePosition ?? 0) + Math.min(500, now - this.browseAt) * this.speed / 1000);
    this.browseAt = now;
    this.browseTarget = target;
    this.held = false;
    for (const player of this.players.values()) {
      player.pause();
      player.currentTime = Math.min(target, player.duration);
    }
  }

  private hold(bytesStarved = false) {
    this.clearDecodeGaps();
    if (!this.held) this.recoveryUntil = performance.now() + (this.speed > 3 ? 2500 : bytesStarved ? 1800 : 0);
    // Pausing peers supersedes their outstanding play promises. A WebView
    // promise that never settles must not block the next coordinated start.
    this.starting = null;
    this.held = true;
    // Keep the starved decoder trying to play. Pausing it at HAVE_CURRENT_DATA
    // can leave WebView2 waiting for canplay even after network bytes arrive.
    // Healthy peers wait here; canplay resumes them without a polling delay.
    for (const player of this.players.values()) {
      if (player.readyState >= 3) {
        if (!player.paused) player.pause();
      }
      // A decoder with data can recover at a modest rate while its peers wait.
      // The requested rate is restored before the group resumes; this is not
      // a hidden change to the user's playback speed or source quality.
      else player.playbackRate = Math.min(this.speed, 2);
    }
    this.publish();
  }

  setBoundary(at?: number, reached?: () => void) {
    this.boundary = at === undefined || !reached ? null : { at, reached };
    this.scheduleBoundary();
  }

  private scheduleBoundary() {
    clearTimeout(this.boundaryTimer);
    const boundary = this.boundary;
    const master = this.master();
    if (!this.intent || this.held || !boundary || !master || master.seeking || master.paused || this.sampled()) return;
    const delay = (boundary.at - master.currentTime) * 1000 / this.speed;
    if (delay <= 4) {
      this.boundary = null;
      boundary.reached();
    } else if (delay <= 220) {
      this.boundaryTimer = setTimeout(() => this.scheduleBoundary(), Math.max(8, delay));
    }
  }

  play(prepared = false) {
    if (!this.players.size) return;
    this.clearDecodeGaps();
    this.intent = true;
    this.preparedUntil = prepared ? performance.now() + 750 : 0;
    if (prepared) { this.priming = false; this.recoveryUntil = 0; }
    else this.prime();
    this.starting = null;
    this.generation++;
    const master = this.master()!;
    this.progressAt = performance.now();
    this.progressPosition = master.currentTime;
    if (this.sampled()) {
      this.browsePosition = master.currentTime;
      this.browseTarget = null;
      this.browseAt = performance.now();
      this.priming = false;
      this.held = false;
      for (const player of this.players.values()) { player.pause(); player.playbackRate = 1; }
      this.publish();
      return;
    }
    // A user start/seek may align once. Continuous playback never seeks peers.
    for (const player of this.players.values()) {
      if (player !== master && player.readyState >= 1 && Math.abs(player.currentTime - master.currentTime) > .12)
        player.currentTime = master.currentTime;
    }
    this.held = true;
    this.tick();
  }

  pause() {
    clearTimeout(this.boundaryTimer);
    this.clearDecodeGaps();
    this.intent = false;
    this.preparedUntil = 0;
    this.held = false;
    this.priming = false;
    this.starting = null;
    this.generation++;
    this.browsePosition = this.browseTarget ?? this.browsePosition;
    this.browseTarget = null;
    for (const player of this.players.values()) {
      player.pause();
      player.playbackRate = this.speed;
    }
    this.publish();
  }

  seek(time: number) {
    clearTimeout(this.boundaryTimer);
    this.clearDecodeGaps();
    this.starting = null;
    this.generation++;
    this.preparedUntil = 0;
    this.browsePosition = time;
    this.browseTarget = null;
    this.browseAt = performance.now();
    this.progressAt = this.browseAt;
    this.progressPosition = time;
    for (const player of this.players.values()) {
      player.pause();
      if (player.readyState >= 1) {
        const target = Math.max(0, Math.min(time, Number.isFinite(player.duration) ? player.duration : time));
        if (player.seeking || Math.abs(target - player.currentTime) > .001) player.currentTime = target;
      }
    }
    this.held = this.intent;
    if (this.intent) this.prime();
    this.publish();
  }

  setSpeed(speed: number) {
    const wasSampled = this.sampled();
    this.clearDecodeGaps();
    const increased = speed > this.speed;
    this.speed = speed;
    if (wasSampled || this.sampled()) {
      const resume = this.intent;
      this.pause();
      this.browsePosition = this.master()?.currentTime ?? 0;
      if (resume) this.play();
      else this.publish();
      return;
    }
    if (speed <= 3) this.recoveryUntil = 0;
    for (const player of this.players.values()) {
      player.defaultPlaybackRate = speed;
      player.playbackRate = speed;
    }
    if (this.intent && increased && speed > 3) { this.prime(); this.hold(); this.tick(); }
    this.publish();
  }

  refresh() { this.publish(); }

  private prime() {
    this.priming = true;
    this.primingUntil = performance.now() + (this.speed > 3 ? 4000 : 2000);
  }

  private hasStartupBuffer(player: HTMLVideoElement, recovery = false) {
    if (recovery && this.speed <= 3 && player.networkState !== 2) return true;
    // At ordinary rates, refill only after an actual shortage. Resuming on
    // the first decoded frame can consume a burst before more bytes arrive.
    const seconds = this.speed > 3 ? recovery ? 1.5 : 3 : recovery ? 1.25 : this.speed >= 2 ? 2 : 1.25;
    const needed = Math.min(seconds * this.speed, Math.max(0, player.duration - player.currentTime - .04));
    return this.hasBuffer(player, needed);
  }

  private hasBuffer(player: HTMLVideoElement, needed: number) {
    for (let i = 0; i < player.buffered.length; i++) {
      if (player.buffered.start(i) <= player.currentTime + .02
        && player.buffered.end(i) - player.currentTime >= needed) return true;
    }
    return false;
  }

  private clearDecodeGap(id: number) {
    clearTimeout(this.decodeGaps.get(id));
    this.decodeGaps.delete(id);
  }

  private clearDecodeGaps() {
    for (const timer of this.decodeGaps.values()) clearTimeout(timer);
    this.decodeGaps.clear();
  }

  private tick() {
    const master = this.master();
    if (this.intent && master) {
      const sampled = this.sampled();
      if (!sampled && master.ended) { this.pause(); this.finished(); return; }
      const position = sampled ? this.browsePosition ?? master.currentTime : master.currentTime;
      const now = performance.now();
      if (Math.abs(position - this.progressPosition) >= .05 || globalThis.document?.hidden) {
        this.progressPosition = position;
        this.progressAt = now;
      } else if (now - this.progressAt >= STALL_TIMEOUT_MS) {
        this.pause();
        this.stalled(position);
        return;
      }
      if (sampled) { this.browseTick(); this.publish(); return; }
      if (this.held) {
        // A decoded first frame may represent only .25 seconds of high-rate
        // video. Reserve a rate-scaled lead at start/seek/rate increase.
        // Recovery has a separate bounded wait and keeps hungry decoders active.
        if (!this.starting && [...this.players.values()].every(v => v.ended || v.readyState >= 3 && !v.seeking
          && (!this.priming || performance.now() >= this.primingUntil || this.hasStartupBuffer(v))
          && (this.priming || performance.now() >= this.recoveryUntil || this.hasStartupBuffer(v, true)))) {
          const attempt = {};
          this.held = false;
          this.priming = false;
          for (const player of this.players.values()) player.playbackRate = this.speed;
          this.starting = attempt;
          void Promise.all([...this.players.values()].filter(player=>!player.ended).map(player => player.play())).catch(error => {
            // Our pause/seek can abort an in-flight play promise.
            if (this.starting === attempt && this.intent && !this.held && error?.name !== "AbortError") {
              this.pause(); this.failed();
            }
          }).finally(() => { if (this.starting === attempt) this.starting = null; });
        } else {
          // Once a hungry decoder has a frame again, stop it alongside its
          // peers while the reserve refills. Continuing at 2x here consumes
          // the new bytes and lets its clock run ahead during the group hold.
          for (const player of this.players.values()) {
            if (player.ended || player.seeking) continue;
            if (player.readyState >= 3) {
              if (!player.paused) player.pause();
            }
            else {
              player.playbackRate = Math.min(this.speed, 2);
              // A previously paused peer can lose readiness while held. It
              // needs to decode again too; waiting for canplay alone can hang.
              if (player.paused) {
                const generation = this.generation;
                void player.play().catch(error => {
                  if (generation === this.generation && this.intent && this.held && error?.name !== "AbortError") {
                    this.pause(); this.failed();
                  }
                });
              }
            }
          }
        }
      } else {
        for (const player of this.players.values()) {
          if (player === master || player.ended || player.seeking || player.readyState < 3) continue;
          // Small clock drift is corrected without discarding decoded frames.
          const drift = player.currentTime - master.currentTime;
          const rate = this.speed * (Math.abs(drift) < .08 ? 1 : Math.max(.92, Math.min(1.08, 1 - drift * .2)));
          if (Math.abs(player.playbackRate - rate) > .005) player.playbackRate = rate;
        }
      }
    }
    this.scheduleBoundary();
    this.publish();
  }

  dispose() {
    clearTimeout(this.boundaryTimer);
    this.clearDecodeGaps();
    this.intent = false;
    this.generation++;
    clearInterval(this.timer);
    for (const remove of this.listeners.values()) remove();
    this.listeners.clear();
    this.players.clear();
  }
}
