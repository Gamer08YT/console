import { test } from "node:test";
import assert from "node:assert/strict";

import { padButtons, StickMouse, tilt } from "../src/input/padMouse.ts";

test("a resting stick does not move, full tilt does", () => {
  assert.deepEqual(tilt(0.1, -0.1), [0, 0]);
  assert.deepEqual(tilt(Number.NaN, 0), [0, 0]);
  const [x, y] = tilt(1, 0);
  assert.equal(x, 1);
  assert.equal(y, 0);
  /* half tilt is well under half speed: fine moves stay fine */
  assert.ok(tilt(0.5, 0)[0] < 0.25);
});

test("travel adds up across frames, fractions kept", () => {
  const s = new StickMouse();
  let sum = 0;
  for (let i = 0; i < 60; i++) sum += s.move(0.4, 0, 1000 / 60, 1)[0];
  /* one second at this tilt: 900 px/s * ((0.4-0.15)/0.85)^2 = ~78 */
  assert.ok(sum >= 77 && sum <= 78, String(sum));
  assert.deepEqual(new StickMouse().move(-1, 0, 10, 1), [-9, 0]);
});

test("a long frame gap does not throw the pointer across the screen", () => {
  const s = new StickMouse();
  assert.deepEqual(s.move(1, 0, 5000, 1), [90, 0]);
});

test("stick up scrolls up, unless inverted", () => {
  const s = new StickMouse();
  assert.deepEqual(s.scroll(0, -1, 100), [1, 0]);
  assert.deepEqual(s.scroll(0, -1, 100, true), [-1, 0]);
});

const btn = (pressed: boolean) => ({ pressed, value: pressed ? 1 : 0 });

test("buttons by position: clicks, keys, slow", () => {
  const buttons = Array.from({ length: 17 }, () => btn(false));
  buttons[0] = btn(true);
  buttons[12] = btn(true);
  buttons[9] = btn(true);
  buttons[5] = btn(true);
  const r = padButtons({ id: "x", mapping: "standard", buttons, axes: [0, 0, 0, 0] });
  assert.equal(r.mouse, 1);
  assert.deepEqual(r.keys, [0x52, 0x28]);
  assert.equal(r.slow, true);
});
