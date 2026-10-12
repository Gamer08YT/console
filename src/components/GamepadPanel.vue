<script setup lang="ts">
/*
 * A gamepad for a console, as a small window floating over the page - the same
 * kind as the HDMI-CEC remote. It drives the pad the device shows over USB when
 * Settings -> Input -> Gamepad is on: a HORI Pokken pad, which a Switch and
 * Steam on a Steam Deck both take as a controller.
 *
 * Three ways in, all at once: press the buttons here (held while the pointer is
 * down; drag a stick), the computer keyboard while this window has focus, or a
 * real controller plugged into this computer, read through the browser's
 * Gamepad API. The state goes out only when it changes.
 *
 * Two looks: the floating window, or an overlay drawn over the picture the way
 * phone emulators do it - see-through controls at the edges, one finger per
 * control, the picture still visible and touchable between them.
 */
import { haptic } from "../ui/haptic";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

import type { Control } from "../input/control";
import {
  CENTER,
  FACE,
  fromGamepad,
  hatFrom,
  IDLE,
  keyFaces,
  KEY_BUTTONS,
  LABELS,
  type LabelStyle,
  KEY_HAT,
  KEY_STICK,
  PAD,
  sameState,
  type PadButton,
  type PadState,
} from "../input/gamepad";
import { useFloating } from "../ui/floating";
import Icon from "./Icon.vue";

const props = defineProps<{ control: Control; kind: "switch" | "xinput" | "xbox" }>();
const emit = defineEmits<{ close: []; look: ["window" | "overlay"] }>();

const popup = ref<HTMLElement | null>(null);

/* What each source holds. */
const ptrButtons = ref(0);
const ptrDirs = ref(new Set<string>());
const keyButtons = ref(0);
const keyDirs = ref(new Set<string>());
const keyStick = ref({ lx: 0, ly: 0, rx: 0, ry: 0 });
/* One per stick, so two thumbs can hold both at once. */
const dragStick = ref<Record<"l" | "r", { x: number; y: number } | null>>({ l: null, r: null });

/* Names on the buttons: the target's by default, or the operator's pick. */
const STYLES: LabelStyle[] = ["nintendo", "xbox", "playstation"];
const STYLE_NAMES: Record<LabelStyle, string> = {
  nintendo: "Nintendo",
  xbox: "Xbox",
  playstation: "PlayStation",
};
const styleChoice = ref<LabelStyle | "">(
  (() => {
    try {
      const v = localStorage.getItem("espkvm.gp.labels") as LabelStyle | null;
      return v && STYLES.includes(v) ? v : "";
    } catch {
      return "";
    }
  })(),
);
const style = computed<LabelStyle>(
  () => styleChoice.value || (props.kind === "switch" ? "nintendo" : "xbox"),
);
const labels = computed(() => LABELS[style.value]);
const keyFace = computed(() => keyFaces(style.value));
function nextStyle() {
  const i = STYLES.indexOf(style.value);
  styleChoice.value = STYLES[(i + 1) % STYLES.length];
  try {
    localStorage.setItem("espkvm.gp.labels", styleChoice.value);
  } catch {
    /* not remembered, no harm */
  }
}
const faces = computed(() =>
  (["north", "west", "east", "south"] as const).map((pos) => ({
    b: FACE[pos],
    area: { north: "u", west: "l", east: "r", south: "d" }[pos],
    label: labels.value[pos],
  })),
);
const shoulderLabel = (b: "l" | "r" | "zl" | "zr") => labels.value[b];
const sysButtons = computed(() => {
  const l = labels.value;
  const out: { b: PadButton; label: string; title: string }[] = [
    { b: "minus", label: l.minus, title: l.minus === "\u2212" ? "Minus" : l.minus },
  ];
  if (l.capture) out.push({ b: "capture", label: l.capture, title: "Capture" });
  out.push({ b: "home", label: l.home, title: l.home === "\u2302" ? "Home" : l.home });
  out.push({ b: "plus", label: l.plus, title: l.plus === "+" ? "Plus" : l.plus });
  return out;
});

type Look = "window" | "overlay";
const look = ref<Look>(
  (() => {
    try {
      return localStorage.getItem("espkvm.gp.look") === "overlay" ? "overlay" : "window";
    } catch {
      return "window";
    }
  })(),
);
function setLook(v: Look) {
  look.value = v;
  emit("look", v);
  try {
    localStorage.setItem("espkvm.gp.look", v);
  } catch {
    /* not remembered, no harm */
  }
  void nextTick(() => popup.value?.focus());
}
const pad = ref<PadState | null>(null);
const padName = ref("");

function stickByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(CENTER + v * 127)));
}

const state = computed<PadState>(() => {
  const dirs = new Set([...ptrDirs.value, ...keyDirs.value]);
  const g = pad.value ?? IDLE;
  const hat = dirs.size
    ? hatFrom(dirs.has("up"), dirs.has("down"), dirs.has("left"), dirs.has("right"))
    : g.hat;
  const s: PadState = {
    buttons: ptrButtons.value | keyButtons.value | g.buttons,
    hat,
    lx: g.lx,
    ly: g.ly,
    rx: g.rx,
    ry: g.ry,
  };
  const k = keyStick.value;
  if (k.lx || k.ly) {
    s.lx = stickByte(k.lx);
    s.ly = stickByte(k.ly);
  }
  if (k.rx || k.ry) {
    s.rx = stickByte(k.rx);
    s.ry = stickByte(k.ry);
  }
  const dl = dragStick.value.l;
  if (dl) {
    s.lx = stickByte(dl.x);
    s.ly = stickByte(dl.y);
  }
  const dr = dragStick.value.r;
  if (dr) {
    s.rx = stickByte(dr.x);
    s.ry = stickByte(dr.y);
  }
  return s;
});

let sent: PadState = { ...IDLE };
function flush() {
  const s = state.value;
  if (sameState(s, sent)) return;
  sent = { ...s };
  props.control.pad(s.buttons, s.hat, s.lx, s.ly, s.rx, s.ry);
}

/* A real controller: polled every frame while the window is open. */
let raf = 0;
/* What the browser reports, so the panel can say why a controller does
   nothing: none seen yet, or one whose layout it does not know. */
const padUnreadable = ref("");
function poll() {
  raf = requestAnimationFrame(poll);
  const pads = navigator.getGamepads?.() ?? [];
  let found: PadState | null = null;
  let name = "";
  let other = "";
  for (const gp of pads) {
    if (!gp) continue;
    const s = fromGamepad(gp);
    if (s) {
      found = s;
      name = gp.id;
      break;
    }
    other = `${gp.id} (layout "${gp.mapping}", ${gp.buttons.length} buttons, ${gp.axes.length} axes)`;
  }
  pad.value = found;
  if (padName.value !== name) padName.value = name;
  if (padUnreadable.value !== other) padUnreadable.value = found ? "" : other;
  flush();
}
function onPadConnected(e: GamepadEvent) {
  console.info("[gamepad] connected:", e.gamepad.id, "mapping:", JSON.stringify(e.gamepad.mapping),
    e.gamepad.buttons.length, "buttons", e.gamepad.axes.length, "axes");
}

onMounted(async () => {
  window.addEventListener("gamepadconnected", onPadConnected);
  emit("look", look.value);
  await nextTick();
  popup.value?.focus();
  raf = requestAnimationFrame(poll);
});
onUnmounted(() => {
  window.removeEventListener("gamepadconnected", onPadConnected);
  cancelAnimationFrame(raf);
  /* Nothing may stay held after the window goes. */
  props.control.pad(IDLE.buttons, IDLE.hat, IDLE.lx, IDLE.ly, IDLE.rx, IDLE.ry);
});

/* Keep a finger's moves and its lift on the control it landed on. A capture
   that fails (a pointer already gone) must not swallow the press itself. */
function capture(e: PointerEvent) {
  try {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  } catch {
    /* the press still counts */
  }
}

/* Buttons on screen: held while the pointer is down on them. */
function btnDown(e: PointerEvent, name: PadButton) {
  haptic();
  capture(e);
  ptrButtons.value |= PAD[name];
  flush();
}
function btnUp(name: PadButton) {
  ptrButtons.value &= ~PAD[name];
  flush();
}
function dirDown(e: PointerEvent, dir: string) {
  haptic();
  capture(e);
  ptrDirs.value = new Set([...ptrDirs.value, dir]);
  flush();
}
function dirUp(dir: string) {
  const next = new Set(ptrDirs.value);
  next.delete(dir);
  ptrDirs.value = next;
  flush();
}

/* Sticks on screen: drag from the centre; the thumb springs back on release. */
function stickMove(e: PointerEvent, stick: "l" | "r") {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  const half = r.width / 2;
  let x = (e.clientX - r.left - half) / half;
  let y = (e.clientY - r.top - half) / half;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  dragStick.value = { ...dragStick.value, [stick]: { x, y } };
  flush();
}
function stickDown(e: PointerEvent, stick: "l" | "r") {
  capture(e);
  stickMove(e, stick);
}
function stickDrag(e: PointerEvent, stick: "l" | "r") {
  if (dragStick.value[stick]) stickMove(e, stick);
}
function stickUp(stick: "l" | "r") {
  dragStick.value = { ...dragStick.value, [stick]: null };
  flush();
}

/* The overlay's cross is one disc: the direction follows the finger as it
   slides, eight ways, with a dead spot in the middle. */
function crossMove(e: PointerEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  const dirs = new Set<string>();
  if (Math.hypot(x, y) > 0.12) {
    const a = (Math.atan2(y, x) * 180) / Math.PI; /* 0 right, 90 down */
    if (a > -67.5 && a < 67.5) dirs.add("right");
    if (a > 22.5 && a < 157.5) dirs.add("down");
    if (a > 112.5 || a < -112.5) dirs.add("left");
    if (a > -157.5 && a < -22.5) dirs.add("up");
  }
  ptrDirs.value = dirs;
  flush();
}
let crossPointer: number | null = null;
function crossDown(e: PointerEvent) {
  haptic();
  capture(e);
  crossPointer = e.pointerId;
  crossMove(e);
}
function crossDrag(e: PointerEvent) {
  if (crossPointer === e.pointerId) crossMove(e);
}
function crossUp() {
  crossPointer = null;
  ptrDirs.value = new Set();
  flush();
}
function thumb(stick: "l" | "r") {
  const s = state.value;
  const x = ((stick === "l" ? s.lx : s.rx) - CENTER) / 127;
  const y = ((stick === "l" ? s.ly : s.ry) - CENTER) / 127;
  /* The thumb travels a third of the pad's width either way. */
  return { transform: `translate(${x * 75}%, ${y * 75}%)` };
}
const held = (name: PadButton) => (state.value.buttons & PAD[name]) !== 0;
const dirHeld = (dir: string) => {
  const h = state.value.hat;
  const map: Record<string, number[]> = {
    up: [7, 0, 1],
    right: [1, 2, 3],
    down: [3, 4, 5],
    left: [5, 6, 7],
  };
  return map[dir].includes(h);
};

/* The computer keyboard, while this window has focus. */
function keyName(e: KeyboardEvent) {
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}
function onKey(e: KeyboardEvent, down: boolean) {
  const k = keyName(e);
  const btn = keyFace.value[k] ?? KEY_BUTTONS[k];
  const dir = KEY_HAT[k];
  const stick = KEY_STICK[k];
  if (!btn && !dir && !stick) return;
  e.preventDefault();
  e.stopPropagation();
  if (down && e.repeat) return;
  if (btn) {
    keyButtons.value = down ? keyButtons.value | PAD[btn] : keyButtons.value & ~PAD[btn];
  } else if (dir) {
    const next = new Set(keyDirs.value);
    if (down) next.add(dir);
    else next.delete(dir);
    keyDirs.value = next;
  } else if (stick) {
    const [which, ax, sign] = stick;
    const key = `${which}${ax}` as "lx" | "ly" | "rx" | "ry";
    keyStick.value = { ...keyStick.value, [key]: down ? sign : 0 };
  }
  flush();
}
/* Keys held when focus leaves would otherwise stay held. */
function onBlur() {
  keyButtons.value = 0;
  keyDirs.value = new Set();
  keyStick.value = { lx: 0, ly: 0, rx: 0, ry: 0 };
  flush();
}

/* Where the window floats, kept between visits and kept on the screen. */
const { pos, dragStart, dragMove, dragEnd } = useFloating({
  key: "espkvm.gp",
  el: popup,
  initial: () => ({
    x: Math.max(8, window.innerWidth - 300 - 24),
    y: window.innerWidth < 700 ? Math.max(8, window.innerHeight - 420) : 80,
  }),
  active: () => look.value === "window",
});
</script>

<template>
  <Teleport to="body">
    <section
      v-if="look === 'window'"
      ref="popup"
      class="gp-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      tabindex="-1"
      aria-label="Gamepad"
      @keydown="onKey($event, true)"
      @keyup="onKey($event, false)"
      @blur="onBlur"
    >
      <div
        class="gp-head"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointercancel="dragEnd"
      >
        <h3>Gamepad</h3>
        <span v-if="padName" class="pill pill-on" :title="padName">controller</span>
        <span
          v-else-if="padUnreadable"
          class="pill pill-off"
          :title="`The browser shows ${padUnreadable}, in a layout this panel cannot read`"
        >
          controller?
        </span>
        <button
          type="button"
          class="btn btn-sm btn-quiet gp-look"
          :title="`Button names: ${STYLE_NAMES[style]}. Click for the next style.`"
          @click="nextStyle"
        >
          {{ STYLE_NAMES[style] }}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-quiet"
          title="Draw the gamepad over the picture, like a phone emulator"
          @click="setLook('overlay')"
        >
          Overlay
        </button>
        <button
          type="button"
          class="btn btn-sm btn-icon btn-quiet"
          aria-label="Close the gamepad"
          title="Close"
          @click="emit('close')"
        >
          <Icon name="close" :size="15" />
        </button>
      </div>

      <div class="gp-row">
        <button
          v-for="b in (['zl', 'l'] as const)"
          :key="b"
          type="button"
          :class="['gp-btn', 'gp-shoulder', { 'gp-held': held(b) }]"
          @pointerdown="btnDown($event, b)"
          @pointerup="btnUp(b)"
          @pointercancel="btnUp(b)"
        >
          {{ shoulderLabel(b) }}
        </button>
        <span class="gp-gap" />
        <button
          v-for="b in (['r', 'zr'] as const)"
          :key="b"
          type="button"
          :class="['gp-btn', 'gp-shoulder', { 'gp-held': held(b) }]"
          @pointerdown="btnDown($event, b)"
          @pointerup="btnUp(b)"
          @pointercancel="btnUp(b)"
        >
          {{ shoulderLabel(b) }}
        </button>
      </div>

      <div class="gp-mid">
        <div class="gp-cross">
          <button
            v-for="d in [
              { dir: 'up', area: 'u', label: '&#9650;' },
              { dir: 'left', area: 'l', label: '&#9664;' },
              { dir: 'right', area: 'r', label: '&#9654;' },
              { dir: 'down', area: 'd', label: '&#9660;' },
            ]"
            :key="d.dir"
            type="button"
            :class="['gp-btn', 'gp-dir', { 'gp-held': dirHeld(d.dir) }]"
            :style="{ gridArea: d.area }"
            :aria-label="d.dir"
            @pointerdown="dirDown($event, d.dir)"
            @pointerup="dirUp(d.dir)"
            @pointercancel="dirUp(d.dir)"
            v-html="d.label"
          />
        </div>

        <div class="gp-sys">
          <button
            v-for="sb in sysButtons"
            :key="sb.b"
            type="button"
            :class="['gp-btn', 'gp-small', { 'gp-held': held(sb.b) }]"
            :title="sb.title"
            :aria-label="sb.title"
            @pointerdown="btnDown($event, sb.b)"
            @pointerup="btnUp(sb.b)"
            @pointercancel="btnUp(sb.b)"
          >
            {{ sb.label }}
          </button>
        </div>

        <div class="gp-face">
          <button
            v-for="f in faces"
            :key="f.b"
            type="button"
            :class="['gp-btn', 'gp-round', { 'gp-held': held(f.b) }]"
            :style="{ gridArea: f.area }"
            @pointerdown="btnDown($event, f.b)"
            @pointerup="btnUp(f.b)"
            @pointercancel="btnUp(f.b)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <div class="gp-row gp-sticks">
        <div
          v-for="s in (['l', 'r'] as const)"
          :key="s"
          class="gp-stick"
          :aria-label="s === 'l' ? 'Left stick' : 'Right stick'"
          @pointerdown="stickDown($event, s)"
          @pointermove="stickDrag($event, s)"
          @pointerup="stickUp(s)"
          @pointercancel="stickUp(s)"
        >
          <span
            :class="['gp-thumb', { 'gp-held': held(s === 'l' ? 'lstick' : 'rstick') }]"
            :style="thumb(s)"
          />
        </div>
      </div>

      <p class="gp-hint">
        Keys here: arrows, Enter = confirm, Esc = back, the button letters, Q/E and 1/3 for the
        shoulders, &minus;/=, H = home, WASD and IJKL for the sticks. A controller plugged into
        this computer works too: press any button on it once, the browser only shows it after
        that.
      </p>
    </section>
  </Teleport>
  <!-- Inside the picture's area, under the page's own pop-ups and the side
       panel: it belongs to the picture, not above everything. -->
  <Teleport to="main.stage">
    <section
      v-if="look === 'overlay'"
      ref="popup"
      class="gp-ov"
      tabindex="-1"
      aria-label="Gamepad over the picture"
      @keydown="onKey($event, true)"
      @keyup="onKey($event, false)"
      @blur="onBlur"
      @contextmenu.prevent
    >
      <div class="ov-top">
        <button type="button" class="ov-chip" title="Back to the window" @click="setLook('window')">
          Window
        </button>
        <button type="button" class="ov-chip" aria-label="Close the gamepad" title="Close" @click="emit('close')">
          <Icon name="close" :size="14" />
        </button>
      </div>

      <div class="ov-shoulders ov-left">
        <button
          v-for="b in (['zl', 'l'] as const)"
          :key="b"
          type="button"
          :class="['ov-btn', 'ov-shoulder', { 'gp-held': held(b) }]"
          @pointerdown="btnDown($event, b)"
          @pointerup="btnUp(b)"
          @pointercancel="btnUp(b)"
        >
          {{ shoulderLabel(b) }}
        </button>
      </div>
      <div class="ov-shoulders ov-right">
        <button
          v-for="b in (['zr', 'r'] as const)"
          :key="b"
          type="button"
          :class="['ov-btn', 'ov-shoulder', { 'gp-held': held(b) }]"
          @pointerdown="btnDown($event, b)"
          @pointerup="btnUp(b)"
          @pointercancel="btnUp(b)"
        >
          {{ shoulderLabel(b) }}
        </button>
      </div>

      <div class="ov-cluster ov-left-cluster">
        <div
          class="ov-stick"
          aria-label="Left stick"
          @pointerdown="stickDown($event, 'l')"
          @pointermove="stickDrag($event, 'l')"
          @pointerup="stickUp('l')"
          @pointercancel="stickUp('l')"
        >
          <span :class="['gp-thumb', { 'gp-held': held('lstick') }]" :style="thumb('l')" />
        </div>
        <div
          class="ov-cross"
          aria-label="Cross"
          @pointerdown="crossDown"
          @pointermove="crossDrag"
          @pointerup="crossUp"
          @pointercancel="crossUp"
        >
          <span :class="['ov-arm', 'ov-u', { 'gp-held': dirHeld('up') }]">&#9650;</span>
          <span :class="['ov-arm', 'ov-l', { 'gp-held': dirHeld('left') }]">&#9664;</span>
          <span :class="['ov-arm', 'ov-r', { 'gp-held': dirHeld('right') }]">&#9654;</span>
          <span :class="['ov-arm', 'ov-d', { 'gp-held': dirHeld('down') }]">&#9660;</span>
        </div>
      </div>

      <div class="ov-cluster ov-right-cluster">
        <div class="ov-face">
          <button
            v-for="f in faces"
            :key="f.b"
            type="button"
            :class="['ov-btn', 'ov-round', { 'gp-held': held(f.b) }]"
            :style="{ gridArea: f.area }"
            @pointerdown="btnDown($event, f.b)"
            @pointerup="btnUp(f.b)"
            @pointercancel="btnUp(f.b)"
          >
            {{ f.label }}
          </button>
        </div>
        <div
          class="ov-stick"
          aria-label="Right stick"
          @pointerdown="stickDown($event, 'r')"
          @pointermove="stickDrag($event, 'r')"
          @pointerup="stickUp('r')"
          @pointercancel="stickUp('r')"
        >
          <span :class="['gp-thumb', { 'gp-held': held('rstick') }]" :style="thumb('r')" />
        </div>
      </div>

      <div class="ov-sys">
        <button
          v-for="sb in sysButtons"
          :key="sb.b"
          type="button"
          :class="['ov-btn', 'ov-small', { 'gp-held': held(sb.b) }]"
          :title="sb.title"
          :aria-label="sb.title"
          @pointerdown="btnDown($event, sb.b)"
          @pointerup="btnUp(sb.b)"
          @pointercancel="btnUp(sb.b)"
        >
          {{ sb.label }}
        </button>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.gp-menu {
  position: fixed;
  z-index: 56;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  overflow-x: hidden;
  width: 300px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
  outline: none;
  user-select: none;
}

.gp-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: grab;
  touch-action: none;
}

.gp-head h3 {
  margin: 0;
}

.gp-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

.gp-gap {
  flex: 1;
}

.gp-mid {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 6px;
  align-items: center;
}

.gp-cross,
.gp-face {
  display: grid;
  grid-template-areas:
    ". u ."
    "l . r"
    ". d .";
  grid-template-columns: repeat(3, 28px);
  grid-template-rows: repeat(3, 28px);
  gap: 2px;
  justify-content: center;
}

.gp-sys {
  display: grid;
  grid-template-columns: repeat(2, auto);
  gap: 4px;
}

.gp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  touch-action: none;
}

.gp-btn:hover {
  border-color: var(--border-strong);
}

.gp-held {
  background: var(--accent, #3a7bd5);
  border-color: var(--accent, #3a7bd5);
  color: #fff;
}

.gp-shoulder {
  min-width: 48px;
  font-size: var(--text-xs);
}

.gp-dir {
  padding: 0;
  font-size: 11px;
}

.gp-round {
  padding: 0;
  border-radius: 50%;
  font-weight: 600;
}

.gp-small {
  min-width: 28px;
  padding: 0 4px;
  font-size: var(--text-xs);
}

.gp-sticks {
  justify-content: space-around;
}

.gp-stick {
  position: relative;
  width: 72px;
  height: 72px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg);
  touch-action: none;
  cursor: grab;
}

.gp-thumb {
  position: absolute;
  left: 30%;
  top: 30%;
  width: 40%;
  height: 40%;
  border-radius: 50%;
  background: var(--text-faint);
  pointer-events: none;
}

.gp-look {
  margin-left: auto;
}

/* ---- overlay over the picture ---------------------------------------- */

.gp-ov {
  /* Sized from the picture's area: a phone gets smaller controls. */
  --ov-size: clamp(84px, 24cqmin, 168px);
  container-type: size;
  position: absolute;
  inset: 0;
  z-index: 6; /* above the touch controls (5), below the side panel and pop-ups */
  pointer-events: none; /* the picture stays touchable between the controls */
  outline: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.gp-ov .ov-top,
.gp-ov .ov-shoulders,
.gp-ov .ov-cluster,
.gp-ov .ov-sys {
  position: absolute;
  display: flex;
  gap: 10px;
}

.gp-ov button,
.gp-ov .ov-stick,
.gp-ov .ov-cross {
  pointer-events: auto;
  touch-action: none;
}

.ov-top {
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
}

.ov-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.ov-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid rgba(255, 255, 255, 0.45);
  background: rgba(0, 0, 0, 0.28);
  color: rgba(255, 255, 255, 0.9);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.ov-shoulders {
  top: 12px;
}

.ov-left {
  left: 16px;
}

.ov-right {
  right: 16px;
}

.ov-shoulder {
  width: calc(var(--ov-size) * 0.5);
  height: calc(var(--ov-size) * 0.3);
  border-radius: 12px;
}

.ov-cluster {
  bottom: 16px;
  align-items: flex-end;
  gap: 14px;
}

.ov-left-cluster {
  left: 16px;
  flex-direction: column;
  align-items: flex-start;
}

.ov-right-cluster {
  right: 16px;
  flex-direction: column;
  align-items: flex-end;
}

.ov-stick {
  position: relative;
  width: calc(var(--ov-size) * 0.8);
  height: calc(var(--ov-size) * 0.8);
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.22);
}

.ov-stick .gp-thumb {
  background: rgba(255, 255, 255, 0.55);
}

.ov-cross {
  position: relative;
  width: var(--ov-size);
  height: var(--ov-size);
  margin-left: calc(var(--ov-size) * 0.35);
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.22);
}

.ov-arm {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34%;
  height: 34%;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  pointer-events: none;
}

.ov-u {
  top: 2%;
  left: 33%;
}

.ov-d {
  bottom: 2%;
  left: 33%;
}

.ov-l {
  left: 2%;
  top: 33%;
}

.ov-r {
  right: 2%;
  top: 33%;
}

.ov-face {
  display: grid;
  grid-template-areas:
    ". u ."
    "l . r"
    ". d .";
  grid-template-columns: repeat(3, calc(var(--ov-size) * 0.36));
  grid-template-rows: repeat(3, calc(var(--ov-size) * 0.36));
  gap: 2px;
  margin-right: calc(var(--ov-size) * 0.35);
}

.ov-round {
  border-radius: 50%;
  font-size: calc(var(--ov-size) * 0.13);
}

/* Up top under the chips, where emulators keep them and clear of the
   console's own hints at the bottom of the picture. */
.ov-sys {
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
}

.ov-small {
  min-width: calc(var(--ov-size) * 0.3);
  height: calc(var(--ov-size) * 0.3);
  padding: 0 6px;
  border-radius: 999px;
  font-size: calc(var(--ov-size) * 0.08);
}

.gp-ov .gp-held {
  background: rgba(58, 123, 213, 0.75);
  border-color: rgba(255, 255, 255, 0.8);
  color: #fff;
}

.gp-hint {
  margin: 0;
  color: var(--text-faint);
  font-size: var(--text-xs);
}
</style>
