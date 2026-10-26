/*
 * The last minute of the video's figures, for the graphs in the Video readout.
 *
 * Filled from the status the console polls once a second anyway, so the graph
 * already has a minute behind it when the readout is opened.
 */
import { shallowRef } from "vue";

import type { VideoStatus } from "./device";

export interface VideoSample {
  /** ms, Date.now() */
  t: number;
  fps: number;
  kbps: number;
  busyPct: number;
}

export const HISTORY_MS = 60_000;

export const videoHistory = shallowRef<VideoSample[]>([]);

/** Add one status; samples older than a minute fall off. Null (no contact) leaves a gap. */
export function recordVideo(s: VideoStatus | null, now = Date.now()): void {
  const kept = videoHistory.value.filter((x) => now - x.t <= HISTORY_MS);
  if (s) kept.push({ t: now, fps: s.fps, kbps: s.kbps, busyPct: s.encoderBusyPct });
  videoHistory.value = kept;
}
