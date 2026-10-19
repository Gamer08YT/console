/*
 * Receives the H.264 picture over WebRTC and hands each frame to the caller the
 * same way VideoStream does, so the canvas, the pointer and the text layer do
 * not care which way it came.
 *
 * Video, and the target's sound when the device has it: keys, the mouse and
 * the status stay on their WebSocket. The
 * device is ICE-lite and answers the offer over the REST API in one go (no
 * trickle), so the browser's own candidates are not needed and the offer goes
 * out at once. The browser decodes, NACKs lost packets and asks for a keyframe
 * itself; nothing here has to.
 *
 * Anything that goes wrong before the first frame, or a connection that fails
 * later, is reported through onFallback: the caller then goes back to the
 * WebSocket, which carries the same frames. See components/kvm_webrtc.
 */

import { Unauthorized, webrtcClose, webrtcOffer, webrtcSound } from "../state/device";
import { playWhenAllowed } from "./sound";
import { browserLag, type Handlers, transport } from "./stream";

/** ICE, DTLS and the first keyframe: about 0.3 s on a LAN. */
const FIRST_FRAME_TIMEOUT_MS = 5000;
const STATS_MS = 2000;

export interface RtcHandlers extends Handlers {
  /** Ask for the sound too; it plays once setSound(true) is called. */
  audio?: boolean;
  /**
   * The stream ended. @p worked says whether frames came first: a stream that
   * worked and then broke (a phone put to sleep, a network change) is worth
   * starting again; one that never worked goes to the WebSocket.
   */
  onFallback(reason: string, worked: boolean): void;
}

/**
 * Whether this browser has what the stream needs. WebCodecs is not on the
 * list: the browser decodes into a video element, which works on a plain HTTP
 * page too - the one way to watch H.264 there, as on the setup hotspot.
 */
export function rtcSupported(): boolean {
  return (
    typeof RTCPeerConnection !== "undefined" &&
    "requestVideoFrameCallback" in HTMLVideoElement.prototype
  );
}

export class RtcStream {
  #handlers: RtcHandlers;
  #pc: RTCPeerConnection | null = null;
  #video: HTMLVideoElement;
  #id: number | null = null;
  #stopped = false;
  #gotFrame = false;
  #firstFrameTimer: number | null = null;
  #statsTimer: number | null = null;
  #lastBuffer = { delay: 0, count: 0 };
  /* A copy for the canvas is being made (createImageBitmap, without WebCodecs). */
  #copying = false;
  #audio: HTMLAudioElement | null = null;
  #soundOn = false;
  #cancelPlay: () => void = () => undefined;

  /**
   * Sound on or off. The device sends nothing until it is on, so a muted
   * console costs it no encoding.
   */
  setSound(on: boolean) {
    this.#soundOn = on;
    if (this.#id !== null) webrtcSound(this.#id, on);
    this.#unmute();
  }

  #unmute() {
    const a = this.#audio;
    if (!a) return;
    a.muted = !this.#soundOn;
    this.#cancelPlay();
    if (this.#soundOn) this.#cancelPlay = playWhenAllowed(() => a.play());
  }

  constructor(handlers: RtcHandlers) {
    this.#handlers = handlers;
    /*
     * The decoded picture lands in a video element and is copied to the
     * canvas from there. It must be in the document for the browser to keep
     * presenting frames, but nobody needs to see it.
     */
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute("aria-hidden", "true");
    v.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(v);
    this.#video = v;
    void this.#start();
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#firstFrameTimer !== null) clearTimeout(this.#firstFrameTimer);
    if (this.#statsTimer !== null) clearInterval(this.#statsTimer);
    if (this.#id !== null) webrtcClose(this.#id);
    this.#pc?.close();
    this.#pc = null;
    this.#video.srcObject = null;
    this.#video.remove();
    if (this.#audio) {
      this.#audio.srcObject = null;
      this.#audio.remove();
      this.#audio = null;
      this.#cancelPlay();
    }
  }

  #fail(reason: string) {
    if (this.#stopped) return;
    this.stop();
    this.#handlers.onFallback(reason, this.#gotFrame);
  }

  async #start() {
    /* No STUN or TURN server: the device lists every address it has, and a
       console that reaches the device over HTTPS reaches one of them. */
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.#pc = pc;
    const tr = pc.addTransceiver("video", { direction: "recvonly" });
    /* Offer only H.264, the one codec the device sends, so the answer cannot
       pick anything else. */
    const caps = RTCRtpReceiver.getCapabilities?.("video");
    const h264 = caps?.codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264") ?? [];
    if (h264.length && tr.setCodecPreferences) tr.setCodecPreferences(h264);
    if (this.#handlers.audio) pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      if (ev.track.kind === "audio") {
        /* Its own element: the video one stays muted so it may autoplay. */
        const a = document.createElement("audio");
        a.autoplay = true;
        a.srcObject = new MediaStream([ev.track]);
        document.body.appendChild(a);
        this.#audio = a;
        this.#unmute();
        return;
      }
      /*
       * A remote screen is not a film: a frame shown late is worse than one
       * shown a little unevenly. By default the browser holds frames to smooth
       * out jitter; ask it to hold them as little as it can.
       */
      if ("jitterBufferTarget" in ev.receiver) ev.receiver.jitterBufferTarget = 0;
      this.#video.srcObject = new MediaStream([ev.track]);
      void this.#video.play().catch(() => undefined);
      this.#video.requestVideoFrameCallback(this.#onFrame);
    };
    pc.onconnectionstatechange = () => {
      /* "disconnected" can recover by itself; "failed" does not. */
      if (pc.connectionState === "failed") this.#fail("the WebRTC connection failed");
    };

    let answer;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("the browser made no offer");
      answer = await webrtcOffer(sdp);
    } catch (err) {
      if (err instanceof Unauthorized) {
        this.#fail("signed out");
      } else {
        this.#fail((err as Error).message);
      }
      return;
    }
    if (this.#stopped) {
      webrtcClose(answer.id);
      return;
    }
    this.#id = answer.id;
    if (this.#soundOn) webrtcSound(answer.id, true);
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (err) {
      this.#fail(`the browser refused the device's answer: ${(err as Error).message}`);
      return;
    }
    this.#firstFrameTimer = window.setTimeout(() => {
      if (!this.#gotFrame) this.#fail("no frames arrived over WebRTC");
    }, FIRST_FRAME_TIMEOUT_MS);
    this.#statsTimer = window.setInterval(() => void this.#readStats(), STATS_MS);
  }

  async #readStats() {
    const pc = this.#pc;
    if (!pc) return;
    const report = await pc.getStats().catch(() => null);
    report?.forEach((s) => {
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
        const rtt = s.currentRoundTripTime as number | undefined;
        if (rtt !== undefined) transport.rttMs = rtt * 1000;
        return;
      }
      if (s.type !== "inbound-rtp" || s.kind !== "video") return;
      /* The totals grow for the whole session; the readout wants now. */
      const delay = (s.jitterBufferDelay as number | undefined) ?? 0;
      const count = (s.jitterBufferEmittedCount as number | undefined) ?? 0;
      const dc = count - this.#lastBuffer.count;
      if (dc > 0) transport.bufferMs = ((delay - this.#lastBuffer.delay) / dc) * 1000;
      this.#lastBuffer = { delay, count };
      transport.lost = (s.packetsLost as number | undefined) ?? 0;
      transport.nacks = (s.nackCount as number | undefined) ?? 0;
    });
  }

  #onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (this.#stopped) return;
    const v = this.#video;
    v.requestVideoFrameCallback(this.#onFrame);
    if (!v.videoWidth || !v.videoHeight) return;
    if (typeof VideoFrame !== "undefined") {
      let frame: VideoFrame | null = null;
      try {
        frame = new VideoFrame(v, {
          timestamp: Math.round(meta.mediaTime * 1e6),
        });
      } catch {
        /* Not ready yet; the next one will be. */
      }
      if (frame) this.#deliver(frame, meta.presentedFrames);
      return;
    }
    /* No WebCodecs (a plain HTTP page): copy the picture out instead. A copy
       still being made means this frame is skipped, not queued. */
    if (this.#copying) return;
    this.#copying = true;
    createImageBitmap(v)
      .then((bitmap) => {
        if (this.#stopped) bitmap.close();
        else this.#deliver(bitmap, meta.presentedFrames);
      })
      .catch(() => undefined)
      .finally(() => (this.#copying = false));
  };

  #deliver(image: VideoFrame | ImageBitmap, sequence: number) {
    if (!this.#gotFrame) {
      this.#gotFrame = true;
      if (this.#firstFrameTimer !== null) clearTimeout(this.#firstFrameTimer);
      this.#firstFrameTimer = null;
    }
    transport.via = "WebRTC";
    browserLag.ms = 0; /* a WebSocket figure; the buffer line stands in for it */
    this.#handlers.onFrame({
      image,
      width: this.#video.videoWidth,
      height: this.#video.videoHeight,
      sequence,
      pts: 0,
    });
  }
}
