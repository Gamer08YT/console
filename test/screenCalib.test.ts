/*
 * "Find this screen" against a made-up desktop: screens, a cursor, a stream
 * that shows a move late, buttons that light up under the pointer, a clock.
 * Time is the test's own, so a slow stream costs nothing to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ABS_MAX } from "../src/input/control.ts";
import { sweep, type Probe } from "../src/ui/screenCalib.ts";

console.debug = () => {}; /* the sweep logs every step */

type Rect = { x: number; y: number; w: number; h: number };

interface Desk {
  screens: Rect[];
  /** The screen in the picture: an index into screens. */
  shown: number;
  lagMs?: number;
  /** Extra lag on some moves, as a stream that hiccups. */
  jitterMs?: number;
  buttons?: Rect[];
  clock?: Rect;
}

function sim(d: Desk): Probe {
  const deskW = Math.max(...d.screens.map((s) => s.x + s.w));
  const deskH = Math.max(...d.screens.map((s) => s.y + s.h));
  const view = d.screens[d.shown];
  let t = 0;
  let moves = 0;
  const events: { at: number; x: number; y: number }[] = [{ at: -1e9, x: -1, y: -1 }];

  /* The OS keeps the pointer on a screen: a point off every screen goes to the nearest edge. */
  const clamp = (x: number, y: number) => {
    let best = { x, y, d: Infinity };
    for (const s of d.screens) {
      const cx = Math.min(Math.max(x, s.x), s.x + s.w - 1);
      const cy = Math.min(Math.max(y, s.y), s.y + s.h - 1);
      const dd = (cx - x) ** 2 + (cy - y) ** 2;
      if (dd < best.d) best = { x: cx, y: cy, d: dd };
    }
    return best;
  };
  const inside = (r: Rect, x: number, y: number) =>
    x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

  const background = new Uint8ClampedArray(view.w * view.h * 4);
  for (let y = 0; y < view.h; y++) {
    for (let x = 0; x < view.w; x++) {
      const i = (y * view.w + x) * 4;
      background[i] = background[i + 1] = background[i + 2] = 90 + ((x * 7 + y * 13) % 40);
      background[i + 3] = 255;
    }
  }

  return {
    width: view.w,
    height: view.h,
    move(ax, ay) {
      const p = clamp(Math.round((ax / ABS_MAX) * deskW), Math.round((ay / ABS_MAX) * deskH));
      const late = (d.lagMs ?? 100) + (moves++ % 3 === 1 ? (d.jitterMs ?? 0) : 0);
      events.push({ at: t + late, x: p.x, y: p.y });
    },
    snap() {
      const shownAt = events.filter((e) => e.at <= t).at(-1)!;
      const px = background.slice();
      const fill = (r: Rect, v: number) => {
        for (let y = Math.max(0, r.y - view.y); y < Math.min(view.h, r.y - view.y + r.h); y++) {
          for (let x = Math.max(0, r.x - view.x); x < Math.min(view.w, r.x - view.x + r.w); x++) {
            const i = (y * view.w + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = v;
          }
        }
      };
      for (const b of d.buttons ?? []) if (inside(b, shownAt.x, shownAt.y)) fill(b, 230);
      if (d.clock) fill(d.clock, Math.floor(t / 1000) % 2 ? 250 : 10);
      /* The arrow: a black outline round a white body, tip at the pointer. */
      fill({ x: shownAt.x, y: shownAt.y, w: 12, h: 18 }, 0);
      fill({ x: shownAt.x + 1, y: shownAt.y + 1, w: 10, h: 16 }, 255);
      return px;
    },
    wait: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
}

const close = (a: number, b: number, by = 4) => Math.abs(a - b) <= by;

function assertWindow(
  got: { deskW: number; deskH: number; x: number; y: number } | null,
  want: [number, number, number, number],
) {
  assert.ok(got, "expected a window, got the only screen");
  const [w, h, x, y] = want;
  assert.ok(
    close(got.deskW, w) && close(got.deskH, h) && close(got.x, x) && close(got.y, y),
    `got ${JSON.stringify(got)}, want ${want}`,
  );
}

const LEFT = { x: 0, y: 0, w: 640, h: 360 };
const RIGHT = { x: 640, y: 0, w: 640, h: 360 };

test("one screen: nothing to correct", async () => {
  assert.equal(await sweep(sim({ screens: [LEFT], shown: 0 })), null);
});

test("the right one of two screens", async () => {
  assertWindow(await sweep(sim({ screens: [LEFT, RIGHT], shown: 1 })), [1280, 360, 640, 0]);
});

test("a slow stream: every move shows 700 ms late, some 1.5 s", async () => {
  const got = await sweep(sim({ screens: [LEFT, RIGHT], shown: 1, lagMs: 700, jitterMs: 800 }));
  assertWindow(got, [1280, 360, 640, 0]);
});

test("buttons that light up under the pointer, and a clock", async () => {
  /* A button at most of the sweep's points on this screen. */
  const buttons = [0.5, 0.15, 0.85].flatMap((fy) =>
    Array.from({ length: 6 }, (_, i) => ({
      x: 640 + Math.round(((i + 6.5) / 12) * 1280) - 640 - 10,
      y: Math.round(fy * 360) - 10,
      w: 40,
      h: 30,
    })),
  );
  const clock = { x: 1240, y: 340, w: 30, h: 14 };
  const got = await sweep(sim({ screens: [LEFT, RIGHT], shown: 1, lagMs: 300, buttons, clock }));
  assertWindow(got, [1280, 360, 640, 0]);
});

test("a taller screen beside a shorter one", async () => {
  const tall = { x: 0, y: 0, w: 640, h: 480 };
  const short = { x: 640, y: 0, w: 640, h: 360 };
  assertWindow(
    await sweep(sim({ screens: [tall, short], shown: 0, lagMs: 400 })),
    [1280, 480, 0, 0],
  );
  assertWindow(
    await sweep(sim({ screens: [tall, short], shown: 1, lagMs: 400 })),
    [1280, 480, 640, 0],
  );
});
