/*
 * Plays a .ts recording from the card in the browser, without downloading it
 * first: the file is fetched as it plays, split into frames by TsDemuxer and
 * decoded by WebCodecs, the same decoder the live picture uses. A browser's
 * <video> cannot take MPEG-TS, and the device has no time to convert long
 * recordings to MP4.
 *
 * Seeking asks the device for the file from a byte offset (an HTTP Range) and
 * starts at the next keyframe, so it lands within a couple of seconds of the
 * spot. Times shown are the stream's own, so subtitles line up.
 *
 * Sound, when the recording has it, is decoded as it is read and played on an
 * AudioContext against the picture's clock: each piece is queued a moment
 * before it is due, so a pause or a seek only has to stop what is queued.
 */
import { codecFromSps, inspectAnnexB } from "./stream";
import { TS_PACKET, TsDemuxer, lastPts, opusPacket, type AccessUnit } from "./tsDemux";

/*
 * A sound unit, ready for the decoder: Opus as the recorder writes it now
 * (48 kHz stereo, 20 ms packets), or AAC with its ADTS header, which says the
 * rate and channels and goes to the decoder as it is.
 */
function soundOf(
  d: Uint8Array,
): { format: string; config: AudioDecoderConfig; data: Uint8Array } | null {
  const opus = opusPacket(d);
  if (opus) {
    return {
      format: "opus",
      config: { codec: "opus", sampleRate: 48000, numberOfChannels: 2 },
      data: opus,
    };
  }
  if (d.length < 7 || d[0] !== 0xff) return null;
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
  ];
  const rate = rates[(d[2] >> 2) & 0x0f];
  const channels = ((d[2] & 1) << 2) | (d[3] >> 6);
  if (!rate || !channels) return null;
  return {
    format: `aac/${rate}/${channels}`,
    config: { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: channels },
    data: d,
  };
}

export interface PlayerEvents {
  /** Seconds from the start of the recording. */
  onTime(seconds: number): void;
  onDuration(seconds: number): void;
  onPlaying(playing: boolean): void;
  /** Frames are late: the card or the network is slower than the video. */
  onWaiting(waiting: boolean): void;
  onEnded(): void;
  onError(message: string): void;
}

/* How far ahead of the picture to read and decode. */
const AHEAD_US = 2_000_000;
const DECODED_MAX = 12;
/* After a dropped connection, read again from this far back, so the frame that
   was cut in half arrives whole. */
const RESUME_BACK = 2 * 1024 * 1024;
/* Sound is handed to the AudioContext this far ahead of the picture's clock. */
const AUDIO_LEAD_US = 300_000;
/* Pieces that follow each other in the file are played back to back. The
   picture's clock moves in uneven steps, and placing each 21 ms piece by it
   left gaps and overlaps the ear hears as a tremble. Only when the sound has
   drifted this far from the picture is it placed by the clock again. */
const AUDIO_DRIFT_S = 0.05;
/* Closer than this to where the last piece ended, the next one follows it. */
const AUDIO_JOIN_US = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usOf = (pts90k: number) => Math.round((pts90k * 1000) / 90);

export class TsPlayer {
  readonly #url: string;
  readonly #size: number;
  readonly #canvas: HTMLCanvasElement;
  readonly #ev: PlayerEvents;

  #gen = 0; /* bumped by a seek or close: stale loops and outputs stop */
  #abort: AbortController | null = null;
  #decoder: VideoDecoder | null = null;
  #codec = "";
  #needKey = true;
  #frames: VideoFrame[] = [];
  #submittedUs = -1; /* newest frame handed to the decoder */
  #eof = false;

  #ctx: AudioContext | null = null;
  #audioDecoder: AudioDecoder | null = null;
  #audioFormat = ""; /* rate and channels the decoder was set up for */
  #audioSubmittedUs = -1;
  #sound: Array<{ us: number; buf: AudioBuffer }> = []; /* decoded, not yet queued */
  #playing: Array<{ us: number; buf: AudioBuffer; src: AudioBufferSourceNode }> = [];
  #soundEndUs = -1; /* where the last queued piece ends, in media time; -1 = none */
  #soundEndAt = 0; /* and in AudioContext time */

  #firstUs = 0;
  #durationS = 0;
  #paused = false;
  #clockUs = -1; /* media time at #clockAt; -1 = start from the next frame */
  #clockAt = 0;
  #shownUs = -1;
  #waiting = false;
  #ended = false;
  #raf = 0;

  constructor(url: string, size: number, canvas: HTMLCanvasElement, events: PlayerEvents) {
    this.#url = url;
    this.#size = size;
    this.#canvas = canvas;
    this.#ev = events;
  }

  get duration(): number {
    return this.#durationS;
  }

  async open(): Promise<void> {
    if (typeof VideoDecoder === "undefined") {
      this.#ev.onError("this browser has no WebCodecs; download the file and open it in VLC");
      return;
    }
    try {
      const head = await this.#range(0, 256 * 1024 - 1);
      const d = new TsDemuxer();
      const first = [...d.push(head), ...d.flush()].find((au) => !au.audio);
      if (!first) throw new Error("no video in this file");
      this.#firstUs = usOf(first.pts);
      let last = lastPts(await this.#range(-256 * 1024));
      if (last === null) last = lastPts(await this.#range(-2 * 1024 * 1024));
      this.#durationS = last === null ? 0 : Math.max(0, (usOf(last) - this.#firstUs) / 1e6);
      this.#ev.onDuration(this.#durationS);
    } catch (err) {
      this.#ev.onError(err instanceof Error ? err.message : String(err));
      return;
    }
    this.#raf = requestAnimationFrame(this.#tick);
    void this.#pump(this.#gen, 0);
    this.#ev.onPlaying(true);
  }

  play(): void {
    this.#paused = false;
    if (this.#ended) {
      this.seek(0);
    } else {
      this.#clockUs = this.#shownUs;
      this.#clockAt = performance.now();
    }
    this.#ev.onPlaying(true);
  }

  pause(): void {
    this.#paused = true;
    this.#silence(true);
    this.#ev.onPlaying(false);
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Jump near @p seconds: the byte offset is a guess from the file size. */
  seek(seconds: number): void {
    this.#restart();
    const fraction = this.#durationS ? Math.min(Math.max(seconds / this.#durationS, 0), 1) : 0;
    const offset = Math.floor((fraction * this.#size) / TS_PACKET) * TS_PACKET;
    void this.#pump(this.#gen, Math.min(offset, Math.max(0, this.#size - TS_PACKET)));
  }

  close(): void {
    this.#restart();
    this.#gen++;
    cancelAnimationFrame(this.#raf);
    this.#decoder?.close();
    this.#decoder = null;
    void this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
  }

  #restart(): void {
    this.#gen++;
    this.#abort?.abort();
    this.#abort = null;
    for (const f of this.#frames) f.close();
    this.#frames = [];
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    this.#decoder = null;
    this.#codec = "";
    this.#needKey = true;
    this.#submittedUs = -1;
    this.#silence(false);
    this.#sound = [];
    if (this.#audioDecoder && this.#audioDecoder.state !== "closed") this.#audioDecoder.close();
    this.#audioDecoder = null;
    this.#audioFormat = "";
    this.#audioSubmittedUs = -1;
    this.#eof = false;
    this.#ended = false;
    this.#clockUs = -1;
    this.#shownUs = -1;
  }

  /* A Range fetch, retried while the device's two download slots are busy
     (a seek's old connection takes a moment to close). Negative = the tail. */
  async #fetch(range: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.#url, { headers: { Range: range }, signal, cache: "no-store" });
      if (res.status === 503 && attempt < 15) {
        await res.body?.cancel();
        await sleep(300);
        continue;
      }
      if (!res.ok) throw new Error(`the device answered ${res.status}`);
      return res;
    }
  }

  async #range(first: number, last?: number): Promise<Uint8Array> {
    const spec = first < 0 ? `bytes=${first}` : `bytes=${first}-${last ?? ""}`;
    const res = await this.#fetch(spec);
    return new Uint8Array(await res.arrayBuffer());
  }

  async #pump(gen: number, offset: number): Promise<void> {
    const demux = new TsDemuxer();
    /* Frames read but not yet decoded. A chunk of a quiet screen holds a hundred
       tiny frames, and decoding them all at once would hold a hundred pictures. */
    const pending: AccessUnit[] = [];
    let pos = offset;
    let done = false;
    while (gen === this.#gen) {
      const abort = new AbortController();
      this.#abort = abort;
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        const res = await this.#fetch(`bytes=${pos}-`, abort.signal);
        if (!res.body) throw new Error("no body");
        reader = res.body.getReader();
      } catch (err) {
        if (gen === this.#gen) this.#ev.onError(err instanceof Error ? err.message : String(err));
        return;
      }
      demux.reset();
      try {
        for (;;) {
          while (gen === this.#gen && pending.length && !this.#busy()) {
            const au = pending.shift() as AccessUnit;
            if (au.audio) this.#decodeAudio(au);
            else this.#decode(au);
          }
          if (gen !== this.#gen) {
            void reader.cancel();
            return;
          }
          if (pending.length) {
            await sleep(20);
            continue;
          }
          if (done) {
            void reader.cancel();
            this.#eof = true;
            return;
          }
          const chunk = await reader.read();
          if (gen !== this.#gen) return;
          if (chunk.done) {
            pending.push(...demux.flush());
            done = true;
            continue;
          }
          pos += chunk.value.length;
          pending.push(...demux.push(chunk.value));
        }
      } catch {
        /* The device drops a connection that waits too long - a long pause. Read
           again from a little before where it broke; frames already decoded are
           skipped by time. */
        if (gen !== this.#gen) return;
        pending.length = 0;
        pos = Math.floor(Math.max(0, pos - RESUME_BACK) / TS_PACKET) * TS_PACKET;
      }
    }
  }

  #busy(): boolean {
    const queued = this.#frames.length + (this.#decoder?.decodeQueueSize ?? 0);
    if (queued >= DECODED_MAX) return true;
    const now = this.#shownUs < 0 ? -1 : this.#shownUs;
    return now >= 0 && this.#submittedUs - now > AHEAD_US;
  }

  #decode(au: AccessUnit): void {
    const us = usOf(au.pts);
    if (us <= this.#submittedUs) return; /* read twice after a reconnect */
    const { keyframe, sps } = inspectAnnexB(au.data);
    if (this.#needKey && !keyframe) return;
    if (keyframe && sps) {
      const codec = codecFromSps(sps);
      if (codec && codec !== this.#codec) this.#configure(codec);
    }
    const decoder = this.#decoder;
    if (!decoder || decoder.state !== "configured") return;
    this.#needKey = false;
    this.#submittedUs = us;
    decoder.decode(
      new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp: us, data: au.data }),
    );
  }

  #decodeAudio(au: AccessUnit): void {
    if (typeof AudioDecoder === "undefined") return;
    const us = usOf(au.pts);
    if (us <= this.#audioSubmittedUs) return;
    const sound = soundOf(au.data);
    if (!sound) return;
    const old = this.#audioDecoder;
    if (sound.format !== this.#audioFormat || !old || old.state === "closed") {
      if (old && old.state !== "closed") old.close();
      this.#audioDecoder = null;
      this.#audioFormat = sound.format;
      const gen = this.#gen;
      try {
        const decoder = new AudioDecoder({
          output: (data) => this.#onSound(gen, data),
          error: () => undefined, /* the picture plays on without it */
        });
        decoder.configure(sound.config);
        this.#audioDecoder = decoder;
      } catch {
        return;
      }
    }
    const decoder = this.#audioDecoder;
    if (!decoder) return;
    this.#audioSubmittedUs = us;
    decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: us, data: sound.data }));
  }

  #onSound(gen: number, data: AudioData): void {
    if (gen !== this.#gen) {
      data.close();
      return;
    }
    this.#ctx ??= new AudioContext({ latencyHint: "playback" });
    const buf = this.#ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let c = 0; c < data.numberOfChannels; c++) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      buf.copyToChannel(plane, c);
    }
    this.#sound.push({ us: data.timestamp, buf });
    data.close();
  }

  /* Stop what is queued; on a pause, keep what has not played for later. */
  #silence(keep: boolean): void {
    const media = this.#shownUs;
    for (const p of this.#playing) {
      p.src.onended = null;
      p.src.stop();
    }
    if (keep) {
      const back = this.#playing.filter((p) => p.us >= media).map(({ us, buf }) => ({ us, buf }));
      this.#sound = [...back, ...this.#sound];
    }
    this.#playing = [];
    this.#soundEndUs = -1;
  }

  /* Hand the AudioContext what falls due soon, at the picture's clock. */
  #queueSound(media: number): void {
    const ctx = this.#ctx;
    if (!ctx || this.#paused || media < 0) return;
    if (ctx.state === "suspended") void ctx.resume();
    while (this.#sound.length && this.#sound[0].us <= media + AUDIO_LEAD_US) {
      const { us, buf } = this.#sound.shift() as { us: number; buf: AudioBuffer };
      const now = ctx.currentTime;
      let at = now + (us - media) / 1e6;
      if (
        this.#soundEndUs >= 0 &&
        Math.abs(us - this.#soundEndUs) < AUDIO_JOIN_US &&
        Math.abs(this.#soundEndAt - at) < AUDIO_DRIFT_S
      ) {
        at = this.#soundEndAt;
      }
      if (at + buf.duration <= now) continue; /* already past */
      this.#soundEndUs = us + buf.duration * 1e6;
      this.#soundEndAt = at + buf.duration;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(Math.max(at, now), at < now ? now - at : 0);
      const entry = { us, buf, src };
      src.onended = () => {
        this.#playing = this.#playing.filter((p) => p !== entry);
      };
      this.#playing.push(entry);
    }
  }

  #configure(codec: string): void {
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    const gen = this.#gen;
    try {
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (gen !== this.#gen) {
            frame.close();
            return;
          }
          this.#frames.push(frame);
        },
        error: (err) => {
          if (gen === this.#gen) this.#ev.onError(`the H.264 decoder failed: ${err.message}`);
        },
      });
      decoder.configure({ codec, optimizeForLatency: true });
      this.#decoder = decoder;
      this.#codec = codec;
    } catch (err) {
      this.#ev.onError(`this browser cannot decode ${codec}: ${(err as Error).message}`);
    }
  }

  #tick = (now: number): void => {
    this.#raf = requestAnimationFrame(this.#tick);
    const frames = this.#frames;
    if (this.#clockUs < 0 && frames.length) {
      this.#clockUs = frames[0].timestamp;
      this.#clockAt = now;
    }
    const media = this.#paused || this.#clockUs < 0 ? this.#clockUs : this.#clockUs + (now - this.#clockAt) * 1000;

    this.#queueSound(media);

    let show: VideoFrame | null = null;
    while (frames.length && frames[0].timestamp <= media) {
      show?.close();
      show = frames.shift() ?? null;
    }
    if (show) {
      const c = this.#canvas;
      if (c.width !== show.displayWidth || c.height !== show.displayHeight) {
        c.width = show.displayWidth;
        c.height = show.displayHeight;
      }
      c.getContext("2d")?.drawImage(show, 0, 0);
      this.#shownUs = show.timestamp;
      show.close();
      this.#ev.onTime(Math.max(0, (this.#shownUs - this.#firstUs) / 1e6));
      if (this.#paused) this.#clockUs = this.#shownUs;
    }

    const drained = !frames.length && !(this.#decoder?.decodeQueueSize ?? 0);
    if (this.#eof && drained && !this.#ended && this.#clockUs >= 0) {
      this.#ended = true;
      this.#paused = true;
      this.#ev.onPlaying(false);
      this.#ev.onEnded();
    }
    /* Starved: hold the clock, so playback resumes where the picture stopped
       rather than skipping ahead to catch up. */
    const starved = !this.#paused && !this.#eof && drained && this.#clockUs >= 0 && media - this.#shownUs > 250_000;
    if (starved) {
      this.#clockUs = -1;
      this.#silence(true);
    }
    const waiting = starved || (!this.#paused && this.#clockUs < 0 && !this.#ended);
    if (waiting !== this.#waiting) {
      this.#waiting = waiting;
      this.#ev.onWaiting(waiting);
    }
  };
}
