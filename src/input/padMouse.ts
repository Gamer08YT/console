/*
 * A stick as a mouse: the tilt sets how fast the pointer moves, not where it
 * is, so a held stick keeps the pointer travelling. Two sources use it, both
 * off until asked for: a real controller on this computer (usePadMouse) and
 * one-finger drags in touch mode (useTouch).
 *
 * Controller layout (the browser's "standard" one, see gamepad.ts):
 *   left stick      move the pointer
 *   right stick     scroll (up/down, left/right)
 *   bottom button   left click, held = drag
 *   right button    right click
 *   left button     middle click
 *   right shoulder  held = slow and precise
 *   cross           arrow keys; Start = Enter, Back = Esc
 */
import { onScopeDispose, ref, watch, type Ref } from "vue";

import type { Control } from "./control";
import { readable } from "./gamepad";
import { usageForCode } from "./keymap";

const DEAD = 0.15; /* a resting stick reads this far off centre */
const MOVE_PX_S = 900; /* full tilt at 100% sensitivity */
const SCROLL_CLICKS_S = 12; /* wheel clicks a second at full tilt */
const SLOW = 0.3; /* the precise-move factor */
const MAX_STEP_MS = 100; /* a frame gap longer than this (a hidden tab) counts as this */

/** Radial dead zone, then a square curve: fine at a light tilt, fast at full. */
export function tilt(x: number, y: number, dead = DEAD): [number, number] {
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len <= dead) return [0, 0];
  const m = Math.min(1, (len - dead) / (1 - dead));
  const k = (m * m) / len;
  return [x * k, y * k];
}

/** Turns stick tilt over time into whole pointer and wheel steps; keeps the fractions. */
export class StickMouse {
  #x = 0;
  #y = 0;
  #w = 0;
  #p = 0;

  /** Pointer travel for a tilt held `ms` long; `speed` 1 = 100%. */
  move(x: number, y: number, ms: number, speed: number): [number, number] {
    const [tx, ty] = tilt(x, y);
    const px = (MOVE_PX_S * speed * Math.min(ms, MAX_STEP_MS)) / 1000;
    this.#x += tx * px;
    this.#y += ty * px;
    const dx = Math.trunc(this.#x);
    const dy = Math.trunc(this.#y);
    this.#x -= dx;
    this.#y -= dy;
    return [dx, dy];
  }

  /** Wheel and pan clicks; stick up scrolls up. */
  scroll(x: number, y: number, ms: number, invert = false): [number, number] {
    const [tx, ty] = tilt(x, y);
    const clicks = (SCROLL_CLICKS_S * Math.min(ms, MAX_STEP_MS)) / 1000;
    this.#w += (invert ? ty : -ty) * clicks;
    this.#p += tx * clicks;
    const w = Math.trunc(this.#w);
    const p = Math.trunc(this.#p);
    this.#w -= w;
    this.#p -= p;
    return [w, p];
  }

  reset() {
    this.#x = this.#y = this.#w = this.#p = 0;
  }
}

/* Standard-layout button index -> mouse button bit. */
const MOUSE_BUTTONS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 4],
];
const SLOW_BUTTON = 5;
/* Standard-layout button index -> key. */
const KEYS: [number, string][] = [
  [12, "ArrowUp"],
  [13, "ArrowDown"],
  [14, "ArrowLeft"],
  [15, "ArrowRight"],
  [9, "Enter"],
  [8, "Escape"],
];

type PadLike = {
  id: string;
  mapping: string;
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
};

/** What one controller holds, in mouse and keyboard terms. */
export function padButtons(gp: PadLike): { mouse: number; keys: number[]; slow: boolean } {
  const down = (i: number) => {
    const b = gp.buttons[i];
    return !!b && (b.pressed || b.value > 0.5);
  };
  let mouse = 0;
  for (const [i, bit] of MOUSE_BUTTONS) if (down(i)) mouse |= bit;
  const keys: number[] = [];
  for (const [i, code] of KEYS) if (down(i)) keys.push(usageForCode(code));
  return { mouse, keys: keys.slice(0, 6), slow: down(SLOW_BUTTON) };
}

function firstPad(): PadLike | null {
  for (const gp of navigator.getGamepads?.() ?? []) if (gp && readable(gp)) return gp;
  return null;
}

export interface PadMouseOptions {
  control: Control;
  /** The operator's switch and every reason to stand down, folded into one. */
  active: Ref<boolean>;
  /** 1 = 100%, the "Relative sensitivity" setting. */
  speed: Ref<number>;
  invertScroll: Ref<boolean>;
}

/**
 * A real controller drives the mouse while `active`. `connected` names a
 * controller the browser can read, so the console offers the switch only when
 * there is something to switch on.
 */
export function usePadMouse(o: PadMouseOptions) {
  const connected = ref("");
  const refresh = () => {
    connected.value = firstPad()?.id ?? "";
  };
  window.addEventListener("gamepadconnected", refresh);
  window.addEventListener("gamepaddisconnected", refresh);
  refresh();

  const stick = new StickMouse();
  let raf = 0;
  let last = 0;
  let mouse = 0;
  let keys = "";

  function release() {
    if (mouse) o.control.mouseRelative(0, 0, 0);
    if (keys) o.control.keyboard(0, []);
    mouse = 0;
    keys = "";
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const ms = last ? now - last : 0;
    last = now;
    const gp = firstPad();
    if (!gp || document.visibilityState !== "visible") {
      release();
      return;
    }
    const b = padButtons(gp);
    const speed = o.speed.value * (b.slow ? SLOW : 1);
    const [dx, dy] = stick.move(gp.axes[0] ?? 0, gp.axes[1] ?? 0, ms, speed);
    const [w, p] = stick.scroll(gp.axes[2] ?? 0, gp.axes[3] ?? 0, ms, o.invertScroll.value);
    if (dx || dy || w || p || b.mouse !== mouse) o.control.mouseRelative(b.mouse, dx, dy, w, p);
    mouse = b.mouse;
    const k = b.keys.join(",");
    if (k !== keys) o.control.keyboard(0, b.keys);
    keys = k;
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    stick.reset();
    /* Nothing may stay held after the controller lets go of the mouse. */
    release();
  }

  watch(
    o.active,
    (on) => {
      if (on && !raf) raf = requestAnimationFrame(frame);
      else if (!on) stop();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    window.removeEventListener("gamepadconnected", refresh);
    window.removeEventListener("gamepaddisconnected", refresh);
    stop();
  });

  return { connected };
}
