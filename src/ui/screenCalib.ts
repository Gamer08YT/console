/*
 * Find where the captured screen sits on a target's desktop.
 *
 * With more than one screen, the absolute pointer spans the whole desktop, so
 * the picture is only part of it. Rather than ask for four numbers in pixels -
 * which a screen scaled to 150% makes hard to know - the pointer is sent to a
 * grid of points across the whole desktop, and the picture says where it
 * appeared each time. Two straight lines through those points give the
 * desktop's size and this screen's place in it, in the picture's pixels.
 *
 * At each point the pointer goes there and then a few pixels further right,
 * and the cursor is what changed between those two pictures: the tip of the
 * arrow is that patch's top-left. A button lit up under the pointer stays lit
 * across the nudge, so it does not get in the way. Every move is waited for -
 * first to show, then for the picture to go still - so a slow stream cannot
 * hand one step's cursor to the next. Spots that change on their own (a
 * clock, a blinking caret) are watched for before the sweep and left out.
 */
import type { Control } from "../input/control";
import { ABS_MAX } from "../input/control";
import type { Picture } from "./picture";

export interface ScreenWindow {
  deskW: number;
  deskH: number;
  x: number;
  y: number;
}

/** What the sweep needs from the world; the console's is below, a test can bring its own. */
export interface Probe {
  width: number;
  height: number;
  move(ax: number, ay: number): void;
  snap(): Uint8ClampedArray;
  wait(ms: number): Promise<void>;
  now(): number;
}

/* Every other pixel is plenty to find a cursor and halves the work. */
const STEP = 2;
const CHANGED = 40; /* summed RGB difference that counts as changed */
/* A cursor patch, in picture pixels: anything far bigger is the screen redrawing. */
const MIN_PIXELS = 8;
const MAX_SIDE = 96;
const POLL_MS = 80;
/* How long a move may take to show; after the first one, a few times what it took. */
const FIRST_WAIT_MS = 2500;
const QUIET_POLLS = 2;
/* A spot this close to where the line says the cursor is, is the cursor. */
const PREDICT_PX = 48;
/* The step right of each point, in pointer units: a few pixels on any desktop up to 8K wide. */
const NUDGE = Math.round(ABS_MAX / 300);
/* How long to watch the still screen for spots that change by themselves. */
const WATCH_MS = 1500;

export interface Patch {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  n: number;
}

/* The changed spots, grouped into patches of nearby pixels. */
export function patches(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number): Patch[] {
  const out: Patch[] = [];
  for (let y = 0; y < h; y += STEP) {
    for (let x = 0; x < w; x += STEP) {
      const i = (y * w + x) * 4;
      const d =
        Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d < CHANGED) continue;
      let p = out.find((q) => x >= q.x0 - 24 && x <= q.x1 + 24 && y >= q.y0 - 24 && y <= q.y1 + 24);
      if (!p) {
        p = { x0: x, y0: y, x1: x, y1: y, n: 0 };
        out.push(p);
      }
      p.x0 = Math.min(p.x0, x);
      p.y0 = Math.min(p.y0, y);
      p.x1 = Math.max(p.x1, x);
      p.y1 = Math.max(p.y1, y);
      p.n++;
    }
  }
  return out.filter(
    (p) => p.n >= MIN_PIXELS / STEP && p.x1 - p.x0 <= MAX_SIDE && p.y1 - p.y0 <= MAX_SIDE,
  );
}

const near = (p: Patch, at: { x: number; y: number }, by = 32) =>
  Math.abs(p.x0 - at.x) < by && Math.abs(p.y0 - at.y) < by;

/*
 * The same, but deaf to points that are not on the line. Sent where no screen
 * is - below a shorter screen, say - the cursor is held at the nearest edge,
 * and those points would bend the line; so the worst is dropped and the line
 * drawn again until every point left is within a few pixels of it.
 */
function robustFit(pairs: [number, number][]): { slope: number; offset: number } | null {
  let pts = [...pairs];
  for (;;) {
    const f = fit(pts);
    if (!f || pts.length <= 3) return f;
    let worst = 0;
    let worstAt = -1;
    pts.forEach(([a, p], i) => {
      const r = Math.abs(f.slope * a + f.offset - p);
      if (r > worst) {
        worst = r;
        worstAt = i;
      }
    });
    if (worst <= 8) return f;
    pts = pts.filter((_, i) => i !== worstAt);
  }
}

/* Least squares: picture = slope * abs + offset. */
function fit(pairs: [number, number][]): { slope: number; offset: number } | null {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, [a]) => s + a, 0) / n;
  const my = pairs.reduce((s, [, p]) => s + p, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [a, p] of pairs) {
    sxx += (a - mx) * (a - mx);
    sxy += (a - mx) * (p - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, offset: my - slope * mx };
}

/**
 * Sweep and solve. Returns null when this is the target's only screen (the
 * pointer reaches every edge of the picture at the edges of its range).
 * Throws an Error saying what to do when the pointer never showed.
 */
export async function sweep(
  p: Probe,
  onStep?: (n: number, of: number) => void,
): Promise<ScreenWindow | null> {
  const w = p.width;
  const h = p.height;
  if (w < 64 || h < 64) throw new Error("there is no picture to watch yet");

  const xs = Array.from({ length: 12 }, (_, i) => (i + 0.5) / 12);
  const ys = [0.15, 0.5, 0.85];
  const grid = ys.flatMap((fy, row) => (row % 2 ? [...xs].reverse() : xs).map((fx) => [fx, fy]));

  const xPairs: [number, number][] = [];
  const yPairs: [number, number][] = [];
  /* For the error message: what the sweep actually saw. */
  let changed = 0;
  let unsure = 0;
  /* How long a move took to show, once one has: later steps wait for a few times that. */
  let lag = -1;

  /* Let whatever was moving (the countdown, a fading tooltip) stop first. */
  let before = p.snap();
  for (let quiet = 0, t0 = p.now(); quiet < QUIET_POLLS && p.now() - t0 < FIRST_WAIT_MS;) {
    await p.wait(POLL_MS);
    const now = p.snap();
    quiet = patches(before, now, w, h).length ? 0 : quiet + 1;
    before = now;
  }
  /* Then watch it, untouched: whatever changes now does so on its own. */
  const noisy: Patch[] = [];
  for (let t0 = p.now(); p.now() - t0 < WATCH_MS;) {
    await p.wait(POLL_MS);
    const now = p.snap();
    noisy.push(...patches(before, now, w, h));
    before = now;
  }
  const overlaps = (a: Patch, b: Patch) =>
    a.x0 <= b.x1 + 8 && b.x0 <= a.x1 + 8 && a.y0 <= b.y1 + 8 && b.y0 <= a.y1 + 8;
  const look = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
    patches(a, b, w, h).filter((q) => !noisy.some((n) => overlaps(q, n)));

  /* Move, then wait for the move to show and for the picture to go still. A
     move between two points off this screen shows nothing; that is waited out
     for a few times what a move took to show so far. */
  const settle = async (ax: number, ay: number) => {
    const from = before;
    p.move(ax, ay);
    const t0 = p.now();
    const limit = lag < 0 ? FIRST_WAIT_MS : Math.min(FIRST_WAIT_MS, Math.max(400, lag * 3));
    let seenAt = -1;
    let quiet = 0;
    while (p.now() - t0 < (seenAt < 0 ? limit : FIRST_WAIT_MS) && quiet < QUIET_POLLS) {
      await p.wait(POLL_MS);
      const now = p.snap();
      if (seenAt < 0) {
        if (look(from, now).length) seenAt = p.now() - t0;
      } else {
        quiet = look(before, now).length ? 0 : quiet + 1;
      }
      before = now;
    }
    if (seenAt >= 0) lag = lag < 0 ? seenAt : Math.max(lag, seenAt);
    return seenAt >= 0;
  };

  for (let i = 0; i < grid.length; i++) {
    onStep?.(i + 1, grid.length);
    const ax = Math.round(grid[i][0] * ABS_MAX);
    const ay = Math.round(grid[i][1] * ABS_MAX);
    /* To the point, then a few pixels right of it. Between those two pictures
       only the cursor changes: a button lit up under it stays lit, and where
       the cursor was before is already in the past. The changed patch's
       top-left is the arrow's tip at the point. */
    /* Nothing changed on the way here: the cursor is on another screen. */
    if (!(await settle(ax, ay))) continue;
    const at = before;
    if (!(await settle(ax + NUDGE, ay))) continue;
    const found = look(at, before);
    if (found.length) changed++;
    let pick: Patch | null = null;
    if (found.length === 1) {
      pick = found[0];
    } else if (found.length > 1) {
      /* The nudge crossed into something that lights up: the line so far says which is the cursor. */
      const fx = xPairs.length >= 2 ? fit(xPairs) : null;
      const fy = yPairs.length >= 2 ? fit(yPairs) : null;
      if (fx && fy) {
        const want = { x: fx.slope * ax + fx.offset, y: fy.slope * ay + fy.offset };
        const close = found.filter((q) => near(q, want, PREDICT_PX));
        if (close.length === 1) pick = close[0];
      }
      if (!pick) unsure++;
    }
    console.debug("[findScreen]", ax, ay, JSON.stringify(found), pick ? "->" : "", pick ?? "");
    if (pick) {
      xPairs.push([ax, pick.x0]);
      yPairs.push([ay, pick.y0]);
    }
  }

  const fx = robustFit(xPairs);
  const fy = robustFit(yPairs);
  if (!fx || !fy || xPairs.length < 3) {
    throw new Error(
      `the pointer did not show up in the picture often enough - make it visible on the target, on a still screen, and try again ` +
        `(seen at ${xPairs.length} of ${grid.length} points; the picture changed at ${changed}, ` +
        `${unsure} too busy to tell)`,
    );
  }
  /* picture = slope * abs + offset, and abs = (x + picture) / desk * ABS_MAX. */
  const deskW = Math.round(fx.slope * ABS_MAX);
  const deskH = Math.round(fy.slope * ABS_MAX);
  const x = Math.round(-fx.offset);
  const y = Math.round(-fy.offset);
  /* Within a few pixels of the picture itself: one screen, nothing to correct. */
  if (
    Math.abs(deskW - w) < w * 0.03 &&
    Math.abs(deskH - h) < h * 0.03 &&
    Math.abs(x) < 16 &&
    Math.abs(y) < 16
  ) {
    return null;
  }
  /* The desktop must hold this whole screen. When it does not, something
     moved the pointer during the sweep - a hand on the mouse - and saving it
     would send every click to the wrong place. */
  if (x < -16 || y < -16 || x + w > deskW + 16 || y + h > deskH + 16) {
    throw new Error(
      `the figures came out impossible (desktop ${deskW}x${deskH}, this screen at ${x}, ${y}) - ` +
        "keep the mouse still and the screen still while it looks, and try again",
    );
  }
  return { deskW, deskH, x: Math.max(0, x), y: Math.max(0, y) };
}

/** The sweep on the console's own picture and pointer. */
export function findScreen(
  control: Control,
  pic: Picture,
  onStep?: (n: number, of: number) => void,
): Promise<ScreenWindow | null> {
  const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
  return sweep(
    {
      width: pic.width,
      height: pic.height,
      move: (ax, ay) => control.mouseAbsolute(0, ax, ay),
      snap: () => {
        pic.refresh();
        return pic.ctx.getImageData(0, 0, pic.width, pic.height).data;
      },
      wait: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        await frame();
      },
      now: () => performance.now(),
    },
    onStep,
  );
}
