import { strict as assert } from "node:assert";
import { test } from "node:test";

import { recordVideo, videoHistory } from "../src/state/videoHistory.ts";

const st = (fps: number) => ({ fps, kbps: 2000, encoderBusyPct: 40 }) as never;

test("the history keeps one minute and drops the rest", () => {
  videoHistory.value = [];
  for (let t = 0; t <= 90_000; t += 1000) recordVideo(st(t / 1000), t);
  assert.equal(videoHistory.value[0].t, 30_000);
  assert.equal(videoHistory.value.length, 61);
});

test("no contact adds nothing, but still lets old samples go", () => {
  videoHistory.value = [];
  recordVideo(st(25), 0);
  recordVideo(null, 61_000);
  assert.equal(videoHistory.value.length, 0);
});
