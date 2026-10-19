/*
 * Touch control: turns finger gestures on the screen into relative-mouse HID
 * reports, so a phone or tablet drives the target like a laptop trackpad
 * instead of fighting the desktop pointer mapping.
 *
 * Gestures:
 *   one finger drag        move the pointer (relative)
 *   one finger tap         left click
 *   two finger tap         right click
 *   two finger drag        scroll, or move the picture when zoomed in
 *   two finger pinch       zoom the picture
 *   long press then drag   hold left button and drag (select, drag-and-drop)
 *
 * It uses Touch events rather than Pointer events so multi-finger gestures are
 * unambiguous, and it owns the surface only while active - useInput's desktop
 * pointer handling stands down (see its touchActive option) so the two never
 * both act on one touch.
 */

import { hapticTravel, hapticTravelReset } from "../ui/haptic";
import { onScopeDispose, watchEffect, type Ref } from "vue";

import { intrinsicSize, letterbox, type FitMode } from "../video/picture";
import type { Control } from "./control";

/** The picture's zoom: scale, and how far its centre is moved, in CSS pixels. */
export interface Zoom {
  z: number;
  x: number;
  y: number;
}

export const NO_ZOOM: Zoom = { z: 1, x: 0, y: 0 };

export interface TouchOptions {
  surface: Ref<HTMLElement | null>;
  control: Control;
  active: Ref<boolean>;
  invertScroll: Ref<boolean>;
  /** Pointer travel per finger travel; higher moves the cursor faster. */
  sensitivity: Ref<number>;
  zoom: Ref<Zoom>;
  fit: Ref<FitMode>;
}

const TAP_MS = 250; /* a touch shorter than this, with little movement, is a tap */
const TAP_MOVE_PX = 12; /* travel beyond this makes it a drag, not a tap */
const LONG_PRESS_MS = 500; /* hold this long without moving to begin a drag */
const SCROLL_PX_PER_CLICK = 36; /* two-finger travel per wheel click */
/* Pointer acceleration: the faster the finger travels between two moves, the
   more each pixel is worth. A small phone screen otherwise can't cross a large
   desktop without endless swiping, while a slow drag must still stay precise.
   ACCEL_PER_PX raises the gain with finger speed; ACCEL_MAX caps it so a flick
   never launches the pointer across the screen. */
const ACCEL_PER_PX = 0.06;
const ACCEL_MAX = 3.5;
/* Two fingers: a change in their distance beyond this is a pinch; moving
   together beyond TAP_MOVE_PX is a scroll, or a pan when zoomed in. */
const PINCH_PX = 24;
const ZOOM_MAX = 8;

type TwoFingers = "undecided" | "pinch" | "pan" | "scroll";

function mid(e: TouchEvent) {
  const [a, b] = [e.touches[0], e.touches[1]];
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function spread(e: TouchEvent) {
  const [a, b] = [e.touches[0], e.touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function useTouch(opts: TouchOptions) {
  let startT = 0;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let moved = false;
  let maxFingers = 0;
  let button = 0; /* left button currently held by a drag */
  let scrollAccum = 0;
  /* Sub-pixel remainder carried between moves. Rounding each delta on its own
     threw away everything below half a unit, so slow, careful drags produced no
     motion at all - the pointer felt stuck and jumpy. Accumulating the fraction
     makes every bit of finger travel count. */
  let accX = 0;
  let accY = 0;
  let longPress: ReturnType<typeof setTimeout> | null = null;
  /* The two-finger gesture, from where it began. */
  let two: TwoFingers = "undecided";
  let spread0 = 0;
  let mid0 = { x: 0, y: 0 };
  let zoom0 = NO_ZOOM;
  let origin = { x: 0, y: 0 }; /* the picture's centre at zoom 1, client px */

  /* Keep the zoomed picture over the whole view: no black beyond its edges. */
  function clampZoom(z: number, x: number, y: number): Zoom {
    const el = opts.surface.value;
    if (!el || z <= 1) return NO_ZOOM;
    const W = el.offsetWidth;
    const H = el.offsetHeight;
    const pic = letterbox(
      { width: W, height: H },
      intrinsicSize(el) ?? { w: W, h: H },
      opts.fit.value === "stretch",
    );
    const mx = Math.max(0, (z * pic.width - W) / 2);
    const my = Math.max(0, (z * pic.height - H) / 2);
    return { z, x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  }

  function twoBegin(e: TouchEvent, el: HTMLElement) {
    two = "undecided";
    spread0 = spread(e);
    mid0 = mid(e);
    zoom0 = opts.zoom.value;
    /* The picture is scaled about its centre, so the box's centre now is that
       centre moved by the pan. */
    const r = (el.parentElement ?? el).getBoundingClientRect();
    origin = { x: r.left + r.width / 2 - zoom0.x, y: r.top + r.height / 2 - zoom0.y };
  }

  function clearLongPress() {
    if (longPress !== null) {
      clearTimeout(longPress);
      longPress = null;
    }
  }

  function releaseButton() {
    if (button) {
      button = 0;
      opts.control.mouseRelative(0, 0, 0);
    }
  }

  function reset() {
    clearLongPress();
    moved = false;
    maxFingers = 0;
    scrollAccum = 0;
    accX = 0;
    accY = 0;
  }

  watchEffect((onCleanup) => {
    const el = opts.surface.value;
    if (!el || !opts.active.value) return;

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      maxFingers = Math.max(maxFingers, e.touches.length);
      const t = e.touches[0];
      lastX = t.clientX;
      lastY = t.clientY;

      if (e.touches.length === 1) {
        hapticTravelReset();
        startT = performance.now();
        startX = t.clientX;
        startY = t.clientY;
        moved = false;
        scrollAccum = 0;
        /* Hold still for a moment to pick up the left button, then drag. */
        clearLongPress();
        longPress = setTimeout(() => {
          if (!moved && !button) {
            button = 1;
            opts.control.mouseRelative(1, 0, 0);
          }
        }, LONG_PRESS_MS);
      } else {
        /* A second finger cancels a pending press-to-drag. */
        clearLongPress();
        if (e.touches.length === 2) twoBegin(e, el);
      }
    };

    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length >= 2) {
        const m = mid(e);
        if (two === "undecided") {
          if (Math.abs(spread(e) - spread0) > PINCH_PX) two = "pinch";
          else if (Math.hypot(m.x - mid0.x, m.y - mid0.y) > TAP_MOVE_PX) {
            two = zoom0.z > 1 ? "pan" : "scroll";
          } else return;
          moved = true;
          clearLongPress();
        }
        if (two === "pinch") {
          /* The target's pixel under the fingers stays under them. */
          const z = Math.min(ZOOM_MAX, Math.max(1, (zoom0.z * spread(e)) / spread0));
          const qx = (mid0.x - origin.x - zoom0.x) / zoom0.z;
          const qy = (mid0.y - origin.y - zoom0.y) / zoom0.z;
          opts.zoom.value = clampZoom(z, m.x - origin.x - z * qx, m.y - origin.y - z * qy);
          return;
        }
        if (two === "pan") {
          opts.zoom.value = clampZoom(zoom0.z, zoom0.x + m.x - mid0.x, zoom0.y + m.y - mid0.y);
          return;
        }
        /* Vertical travel scrolls. */
        const y = e.touches[0].clientY;
        scrollAccum += lastY - y;
        lastY = y;
        lastX = e.touches[0].clientX;
        let clicks = (scrollAccum / SCROLL_PX_PER_CLICK) | 0;
        if (clicks !== 0) {
          scrollAccum -= clicks * SCROLL_PX_PER_CLICK;
          if (opts.invertScroll.value) clicks = -clicks;
          opts.control.mouseRelative(0, 0, 0, clicks);
        }
        return;
      }

      const t = e.touches[0];
      const rawDx = t.clientX - lastX;
      const rawDy = t.clientY - lastY;
      hapticTravel(Math.hypot(rawDx, rawDy));
      lastX = t.clientX;
      lastY = t.clientY;
      if (!moved && Math.hypot(t.clientX - startX, t.clientY - startY) > TAP_MOVE_PX) {
        moved = true;
        clearLongPress();
      }
      /* Gain = base sensitivity scaled up with finger speed (acceleration),
         applied to the raw travel and accumulated so no fraction is lost. */
      const speed = Math.hypot(rawDx, rawDy);
      /* Zoomed in, the cursor follows the finger over the bigger picture. */
      const gain =
        (opts.sensitivity.value * Math.min(1 + speed * ACCEL_PER_PX, ACCEL_MAX)) /
        opts.zoom.value.z;
      accX += rawDx * gain;
      accY += rawDy * gain;
      const dx = Math.trunc(accX);
      const dy = Math.trunc(accY);
      accX -= dx;
      accY -= dy;
      if (dx !== 0 || dy !== 0) {
        opts.control.mouseRelative(button, dx, dy);
      }
    };

    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      clearLongPress();
      if (e.touches.length > 0) {
        /* One of several fingers lifted: keep going, but this is no longer a
           tap, and re-baseline on the finger that remains. */
        if (e.touches.length === 2) twoBegin(e, el);
        moved = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        return;
      }

      if (button) {
        releaseButton();
      } else if (!moved && performance.now() - startT < TAP_MS) {
        const b = maxFingers >= 2 ? 2 : 1; /* two-finger tap = right click */
        opts.control.mouseRelative(b, 0, 0);
        opts.control.mouseRelative(0, 0, 0);
      }
      reset();
    };

    const onCancel = (e: TouchEvent) => {
      e.preventDefault();
      releaseButton();
      reset();
    };

    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onCancel, { passive: false });

    onCleanup(() => {
      releaseButton();
      reset();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    });
  });

  onScopeDispose(releaseButton);
}
