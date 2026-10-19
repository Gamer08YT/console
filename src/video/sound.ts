/*
 * The target's sound for a console whose picture comes over the WebSocket.
 * Over WebRTC the sound rides with the video and the browser plays it; this
 * is for the rest: MJPEG, or a browser where WebRTC did not connect.
 *
 * The device sends one Opus packet a message on /audio (20 ms, 48 kHz
 * stereo; the layout is in components/kvm_web/audio_api.c). WebCodecs decodes
 * them and each one is queued on an AudioContext a little ahead of now. A
 * queue that has fallen far behind - a stalled tab, a slow link that then
 * delivered in a burst - is dropped and started again, so the sound never
 * lags the picture by more than about a quarter of a second.
 */

import { ref } from "vue";

const MSG_SUBSCRIBE = 1;
const MSG_OPUS = 3;
const HEADER_LEN = 6;
const RATE = 48000;
/** How far ahead of now a packet is queued: room for the network's jitter. */
const LEAD_S = 0.08;
/** Further behind than this and the queue starts over. */
const MAX_QUEUE_S = 0.25;
const RETRY_MS = 2000;

/** Whether this browser can decode the stream: WebCodecs, so HTTPS only. */
export function wsSoundSupported(): boolean {
  return typeof AudioDecoder !== "undefined" && typeof AudioContext !== "undefined";
}

/**
 * The sound is on but the browser holds it back: after a page load it plays
 * nothing until the person clicks or types on the page.
 */
export const soundHeld = ref(false);

/**
 * Recording players open: the live sound stays quiet while one plays, or the
 * two would play over each other.
 */
export const playersOpen = ref(0);

/*
 * Sound waiting for the person to click or type: each entry starts it and
 * settles once it plays. Every click or key tries all of them again until
 * each one has started; one try is not enough, as the first event may not
 * count as permission (a touch, or a key the browser ignores) or come before
 * the sound has arrived.
 */
const waiting = new Set<() => Promise<unknown>>();
const GESTURES = ["pointerdown", "pointerup", "keydown", "touchend"] as const;

function tryWaiting() {
  for (const play of waiting) {
    play().then(
      () => {
        waiting.delete(play);
        settle();
      },
      (e: unknown) => console.warn("sound: the browser still holds it back:", e),
    );
  }
}

function settle() {
  soundHeld.value = waiting.size > 0;
  for (const g of GESTURES) {
    if (waiting.size) window.addEventListener(g, tryWaiting, true);
    else window.removeEventListener(g, tryWaiting, true);
  }
}

/**
 * Start @p play now, or on a click or key if the browser refuses. Returns a
 * function that stops waiting: call it when this sound is turned off or gone.
 */
export function playWhenAllowed(play: () => Promise<unknown>): () => void {
  let done = false;
  play().then(
    () => undefined,
    () => {
      if (done) return;
      waiting.add(play);
      settle();
    },
  );
  return () => {
    done = true;
    waiting.delete(play);
    settle();
  };
}

export class WsSound {
  #ws: WebSocket | null = null;
  #ctx: AudioContext;
  #decoder: AudioDecoder | null = null;
  #next = 0; /* AudioContext time the next packet starts at */
  #stopped = false;
  #retry: number | null = null;
  #cancelResume: () => void = () => undefined;

  constructor() {
    this.#ctx = new AudioContext({
      sampleRate: RATE,
      latencyHint: "interactive",
    });
    if (this.#ctx.state === "suspended") {
      /* resume() without a gesture neither starts nor fails, it just waits:
         so it counts as refused unless the context is running at once. */
      const ctx = this.#ctx;
      this.#cancelResume = playWhenAllowed(() =>
        ctx.state === "running"
          ? Promise.resolve()
          : Promise.race([
              ctx.resume(),
              new Promise((_, no) => setTimeout(() => no(new Error("not allowed yet")), 300)),
            ]),
      );
    }
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#cancelResume();
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#ws?.close();
    this.#ws = null;
    this.#closeDecoder();
    void this.#ctx.close().catch(() => undefined);
  }

  #connect() {
    if (this.#stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/audio`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => ws.send(new Uint8Array([MSG_SUBSCRIBE]));
    ws.onmessage = (ev) => this.#onMessage(ev);
    ws.onclose = () => {
      if (this.#stopped) return;
      this.#retry = window.setTimeout(() => this.#connect(), RETRY_MS);
    };
  }

  #closeDecoder() {
    if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    this.#decoder = null;
  }

  #openDecoder(): AudioDecoder {
    const d = new AudioDecoder({
      output: (data) => this.#play(data),
      error: () => this.#closeDecoder() /* the next packet makes a new one */,
    });
    d.configure({ codec: "opus", sampleRate: RATE, numberOfChannels: 2 });
    this.#decoder = d;
    return d;
  }

  #onMessage(ev: MessageEvent) {
    if (this.#stopped || !(ev.data instanceof ArrayBuffer)) return;
    if (ev.data.byteLength <= HEADER_LEN) return;
    const view = new DataView(ev.data);
    if (view.getUint8(0) !== MSG_OPUS) return;
    if (view.getUint8(1) === 1) this.#next = 0; /* a gap: start the queue over */
    const ts = view.getUint32(2, true);
    const d = this.#decoder ?? this.#openDecoder();
    d.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: Math.round((ts * 1e6) / RATE),
        data: new Uint8Array(ev.data, HEADER_LEN),
      }),
    );
  }

  #play(data: AudioData) {
    const ctx = this.#ctx;
    if (this.#stopped || ctx.state !== "running") {
      data.close();
      return;
    }
    const buf = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let c = 0; c < data.numberOfChannels; c++) {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
      buf.copyToChannel(plane, c);
    }
    data.close();
    const now = ctx.currentTime;
    if (this.#next < now || this.#next - now > MAX_QUEUE_S) this.#next = now + LEAD_S;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(this.#next);
    this.#next += buf.duration;
  }
}
