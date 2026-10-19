<script setup lang="ts">
/*
 * A keyboard drawn on the page, for when the real one cannot be used: a phone
 * or tablet with no keys, a browser or an operating system that swallows a
 * combination (Ctrl+Alt+Delete, F11, the Windows key), or a layout that has no
 * key for what the target wants. It is never the main way in - the real
 * keyboard is, once the picture is engaged - so it stays closed until asked for.
 *
 * Keys are sent as positions, not characters: the same HID usages a real
 * keyboard would send, so the target's own layout decides what appears. Typing
 * a paragraph in another layout is what Paste text is for.
 *
 * Modifiers latch rather than needing two hands: one press arms a modifier for
 * the next key, a second press locks it until pressed again.
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";

import {
  HID_MOD_LALT,
  HID_MOD_LCTRL,
  HID_MOD_LGUI,
  HID_MOD_LSHIFT,
  HID_MOD_RALT,
  HID_MOD_RSHIFT,
  usageForCode,
} from "../input/keymap";
import type { Control } from "../input/control";
import { MEDIA_KEYS } from "../input/mediaKeys";
import { useFloating } from "../ui/floating";
import { haptic } from "../ui/haptic";
import Icon from "./Icon.vue";

const props = defineProps<{ control: Control; leds: number }>();
const emit = defineEmits<{ close: [] }>();

/*
 * Two shapes, because the two uses are different. Docked under the picture is
 * for working: the picture shrinks and nothing overlaps it. Floating is for the
 * one key that is in the way - it sits over the page and can be dragged off
 * whatever it covers. Compact drops the letters and keeps what a browser or an
 * operating system tends to swallow.
 */
const remembered = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
/* Skins: plain, or one that tints every key that is not a character, so the
   modifiers, the function row and the navigation block can be found without
   reading them. */
const SKINS = ["plain", "tinted"] as const;
const skin = ref(
  (SKINS as readonly string[]).includes(remembered("espkvm.osk.skin", "tinted"))
    ? remembered("espkvm.osk.skin", "tinted")
    : "tinted",
);

const floating = ref(remembered("espkvm.osk.floating", "0") === "1");
/* A phone gets the compact shape first: the full one fits, but its keys are
   narrow, and what a phone is usually missing is Esc, the F-row and arrows. */
const compact = ref(
  remembered("espkvm.osk.compact", window.innerWidth < 700 ? "1" : "0") === "1",
);
/* The ready-made combinations are a strip of their own, and on a small screen
   a whole row of the keyboard's height. They stay folded until asked for. */
const combosOpen = ref(remembered("espkvm.osk.combos", "0") === "1");
const panel = ref<HTMLElement | null>(null);
/* Floating, it is dragged by its header and kept whole on the screen. */
const { pos, dragStart, dragMove, dragEnd, fit } = useFloating({
  key: "espkvm.osk",
  el: panel,
  initial: () => ({ x: 24, y: 80 }),
  active: () => floating.value,
});
watch(floating, () => void nextTick(fit));
watch([floating, compact, skin, combosOpen], () => {
  try {
    localStorage.setItem("espkvm.osk.floating", floating.value ? "1" : "0");
    localStorage.setItem("espkvm.osk.compact", compact.value ? "1" : "0");
    localStorage.setItem("espkvm.osk.skin", skin.value);
    localStorage.setItem("espkvm.osk.combos", combosOpen.value ? "1" : "0");
  } catch {
    /* a private window; it just will not be remembered */
  }
});

interface Key {
  /** KeyboardEvent.code, which the keymap turns into a HID usage. */
  code: string;
  /** What is printed on it; two lines for a key with a shifted character. */
  text: string;
  shifted?: string;
  /** Width in units of one letter key. */
  w?: number;
  /** A modifier latches instead of being sent. */
  mod?: number;
  /** Lights up with a lock LED from the target: 1 Num, 2 Caps, 4 Scroll. */
  led?: number;
  /** Sent with Shift held, for the character printed above a key. */
  shift?: boolean;
}

const ROWS: Key[][] = [
  [
    { code: "Escape", text: "Esc" },
    { code: "F1", text: "F1" },
    { code: "F2", text: "F2" },
    { code: "F3", text: "F3" },
    { code: "F4", text: "F4" },
    { code: "F5", text: "F5" },
    { code: "F6", text: "F6" },
    { code: "F7", text: "F7" },
    { code: "F8", text: "F8" },
    { code: "F9", text: "F9" },
    { code: "F10", text: "F10" },
    { code: "F11", text: "F11" },
    { code: "F12", text: "F12" },
    { code: "Delete", text: "Del" },
  ],
  [
    { code: "Backquote", text: "`", shifted: "~" },
    { code: "Digit1", text: "1", shifted: "!" },
    { code: "Digit2", text: "2", shifted: "@" },
    { code: "Digit3", text: "3", shifted: "#" },
    { code: "Digit4", text: "4", shifted: "$" },
    { code: "Digit5", text: "5", shifted: "%" },
    { code: "Digit6", text: "6", shifted: "^" },
    { code: "Digit7", text: "7", shifted: "&" },
    { code: "Digit8", text: "8", shifted: "*" },
    { code: "Digit9", text: "9", shifted: "(" },
    { code: "Digit0", text: "0", shifted: ")" },
    { code: "Minus", text: "-", shifted: "_" },
    { code: "Equal", text: "=", shifted: "+" },
    { code: "Backspace", text: "Bksp", w: 2 },
  ],
  [
    { code: "Tab", text: "Tab", w: 1.5 },
    { code: "KeyQ", text: "Q" },
    { code: "KeyW", text: "W" },
    { code: "KeyE", text: "E" },
    { code: "KeyR", text: "R" },
    { code: "KeyT", text: "T" },
    { code: "KeyY", text: "Y" },
    { code: "KeyU", text: "U" },
    { code: "KeyI", text: "I" },
    { code: "KeyO", text: "O" },
    { code: "KeyP", text: "P" },
    { code: "BracketLeft", text: "[", shifted: "{" },
    { code: "BracketRight", text: "]", shifted: "}" },
    { code: "Backslash", text: "\\", shifted: "|", w: 1.5 },
  ],
  [
    { code: "CapsLock", text: "Caps", w: 1.75, led: 2 },
    { code: "KeyA", text: "A" },
    { code: "KeyS", text: "S" },
    { code: "KeyD", text: "D" },
    { code: "KeyF", text: "F" },
    { code: "KeyG", text: "G" },
    { code: "KeyH", text: "H" },
    { code: "KeyJ", text: "J" },
    { code: "KeyK", text: "K" },
    { code: "KeyL", text: "L" },
    { code: "Semicolon", text: ";", shifted: ":" },
    { code: "Quote", text: "'", shifted: '"' },
    { code: "Enter", text: "Enter", w: 2.25 },
  ],
  [
    { code: "ShiftLeft", text: "Shift", w: 2.25, mod: HID_MOD_LSHIFT },
    { code: "KeyZ", text: "Z" },
    { code: "KeyX", text: "X" },
    { code: "KeyC", text: "C" },
    { code: "KeyV", text: "V" },
    { code: "KeyB", text: "B" },
    { code: "KeyN", text: "N" },
    { code: "KeyM", text: "M" },
    { code: "Comma", text: ",", shifted: "<" },
    { code: "Period", text: ".", shifted: ">" },
    { code: "Slash", text: "/", shifted: "?" },
    { code: "ArrowUp", text: "↑" },
    { code: "ShiftRight", text: "Shift", w: 1.75, mod: HID_MOD_RSHIFT },
  ],
  [
    { code: "ControlLeft", text: "Ctrl", w: 1.5, mod: HID_MOD_LCTRL },
    { code: "MetaLeft", text: "Win", w: 1.25, mod: HID_MOD_LGUI },
    { code: "AltLeft", text: "Alt", w: 1.25, mod: HID_MOD_LALT },
    { code: "Space", text: "Space", w: 5 },
    { code: "AltRight", text: "AltGr", w: 1.25, mod: HID_MOD_RALT },
    { code: "ArrowLeft", text: "←" },
    { code: "ArrowDown", text: "↓" },
    { code: "ArrowRight", text: "→" },
  ],
];

/*
 * The block that stands beside the keys. What goes in it depends on what the
 * rows already have, so no key is drawn twice: the full rows carry the arrows
 * and Delete, so its block is only the editing and system keys.
 */
const EDIT_KEYS: Key[] = [
  { code: "Insert", text: "Ins" },
  { code: "Home", text: "Home" },
  { code: "PageUp", text: "PgUp" },
  { code: "PrintScreen", text: "PrtSc" },
  { code: "End", text: "End" },
  { code: "PageDown", text: "PgDn" },
  { code: "ScrollLock", text: "ScrLk", led: 4 },
  { code: "Pause", text: "Pause" },
];

/*
 * The compact shape: what a browser or an operating system takes for itself,
 * and the keys a phone keyboard has none of. No letters - type those with the
 * device's own keyboard, or with Paste text.
 */
const COMPACT_ROWS: Key[][] = [
  ROWS[0],
  [
    { code: "ControlLeft", text: "Ctrl", w: 1.4, mod: HID_MOD_LCTRL },
    { code: "AltLeft", text: "Alt", w: 1.2, mod: HID_MOD_LALT },
    { code: "ShiftLeft", text: "Shift", w: 1.4, mod: HID_MOD_LSHIFT },
    { code: "MetaLeft", text: "Win", w: 1.2, mod: HID_MOD_LGUI },
    { code: "Tab", text: "Tab" },
    { code: "Enter", text: "Enter", w: 1.4 },
    { code: "Backspace", text: "Bksp", w: 1.4 },
    { code: "Space", text: "Space", w: 2 },
  ],
];

/* The navigation block, laid out as it is on a keyboard: the arrows in their
   inverted T, the six editing keys beside them. Areas, not a flat row, because
   arrows scattered along a line are read one at a time. */
const NAV_GRID: (Key & { area: string })[] = [
  { code: "Insert", text: "Ins", area: "ins" },
  { code: "Home", text: "Home", area: "home" },
  { code: "PageUp", text: "PgUp", area: "pgup" },
  { code: "End", text: "End", area: "end" },
  { code: "PageDown", text: "PgDn", area: "pgdn" },
  { code: "ArrowUp", text: "\u2191", area: "up" },
  { code: "ArrowLeft", text: "\u2190", area: "left" },
  { code: "ArrowDown", text: "\u2193", area: "down" },
  { code: "ArrowRight", text: "\u2192", area: "right" },
];

/*
 * The symbols layout: every character that lives above a number or a
 * punctuation key, one press each, plus the number pad. Hunting for the right
 * bracket while holding Shift with a mouse is exactly the job this panel exists
 * for.
 */
const sym = (code: string, text: string, shift = true): Key => ({ code, text, shift });

const SYMBOL_ROWS: Key[][] = [
  /* What is printed above the numbers, in the order the numbers are in. */
  [
    sym("Digit1", "!"),
    sym("Digit2", "@"),
    sym("Digit3", "#"),
    sym("Digit4", "$"),
    sym("Digit5", "%"),
    sym("Digit6", "^"),
    sym("Digit7", "&"),
    sym("Digit8", "*"),
    sym("Digit9", "("),
    sym("Digit0", ")"),
  ],
  /* The punctuation keys as they are printed, then the same keys with Shift. */
  [
    sym("Backquote", "`", false),
    sym("Minus", "-", false),
    sym("Equal", "=", false),
    sym("BracketLeft", "[", false),
    sym("BracketRight", "]", false),
    sym("Backslash", "\\", false),
    sym("Semicolon", ";", false),
    sym("Quote", "'", false),
    sym("Comma", ",", false),
    sym("Period", ".", false),
    sym("Slash", "/", false),
  ],
  [
    sym("Backquote", "~"),
    sym("Minus", "_"),
    sym("Equal", "+"),
    sym("BracketLeft", "{"),
    sym("BracketRight", "}"),
    sym("Backslash", "|"),
    sym("Semicolon", ":"),
    sym("Quote", "\""),
    sym("Comma", "<"),
    sym("Period", ">"),
    sym("Slash", "?"),
  ],
];

/* The number pad, in the shape it has on a keyboard. */
const PAD_GRID: (Key & { area: string })[] = [
  { code: "NumLock", text: "Num", led: 1, area: "num" },
  { code: "NumpadDivide", text: "\u00f7", area: "div" },
  { code: "NumpadMultiply", text: "\u00d7", area: "mul" },
  { code: "NumpadSubtract", text: "\u2212", area: "sub" },
  { code: "Numpad7", text: "7", area: "n7" },
  { code: "Numpad8", text: "8", area: "n8" },
  { code: "Numpad9", text: "9", area: "n9" },
  { code: "NumpadAdd", text: "+", area: "add" },
  { code: "Numpad4", text: "4", area: "n4" },
  { code: "Numpad5", text: "5", area: "n5" },
  { code: "Numpad6", text: "6", area: "n6" },
  { code: "Numpad1", text: "1", area: "n1" },
  { code: "Numpad2", text: "2", area: "n2" },
  { code: "Numpad3", text: "3", area: "n3" },
  { code: "NumpadEnter", text: "Enter", area: "enter" },
  { code: "Numpad0", text: "0", area: "n0" },
  { code: "NumpadDecimal", text: ".", area: "dot" },
];

/*
 * The function keys on their own, for a BIOS or a boot menu: F1-F12, Esc and
 * Enter, with the arrows beside them. The media keys are a row under them
 * (see mediaKeys.ts); they are not key positions, so they are drawn apart.
 */
const fkey = (n: number): Key => ({ code: `F${n}`, text: `F${n}` });
const FN_ROWS: Key[][] = [
  [{ code: "Escape", text: "Esc" }, ...[1, 2, 3, 4, 5, 6].map(fkey)],
  [...[7, 8, 9, 10, 11, 12].map(fkey), { code: "Enter", text: "Enter" }],
];

/* Which layout is on show: everything, the short one, the symbols, or the
   function and media keys. */
const LAYOUTS = ["full", "compact", "symbols", "fn"] as const;
type Layout = (typeof LAYOUTS)[number];
const layout = ref<Layout>(compact.value ? "compact" : "full");
watch(layout, (l) => (compact.value = l === "compact"));

function cycleLayout() {
  layout.value = LAYOUTS[(LAYOUTS.indexOf(layout.value) + 1) % LAYOUTS.length];
}

const rows = computed(() =>
  layout.value === "compact"
    ? COMPACT_ROWS
    : layout.value === "symbols"
      ? SYMBOL_ROWS
      : layout.value === "fn"
        ? FN_ROWS
        : ROWS,
);

/*
 * The block beside the keys: the number pad with the symbols, the arrows and
 * editing keys with the compact rows, and only the editing keys with the full
 * ones - which already have arrows of their own.
 */
const side = computed(() =>
  layout.value === "symbols"
    ? { kind: "pad", keys: PAD_GRID as Key[] }
    : layout.value === "compact" || layout.value === "fn"
      ? { kind: "nav", keys: NAV_GRID as Key[] }
      : { kind: "edit", keys: EDIT_KEYS },
);

const SIDE_NAMES: Record<string, string> = {
  pad: "the number pad",
  nav: "the arrows and editing keys",
  edit: "the editing keys",
};

/* A narrow screen has no room for both, so it shows one at a time. A wide one
   puts the block beside the keys rather than under them, where it would push
   the keyboard up over the picture. */
const narrow = ref(false);
const pane = ref<"keys" | "side">("keys");
const mq = window.matchMedia ? window.matchMedia("(max-width: 760px)") : null;
if (mq) {
  narrow.value = mq.matches;
  mq.addEventListener("change", onMediaQuery);
}

function onMediaQuery(e: MediaQueryListEvent) {
  narrow.value = e.matches;
  if (!e.matches) pane.value = "keys";
}

/* The combinations an operating system or a browser takes for itself. */
const COMBOS: { label: string; mods: number; code: string }[] = [
  { label: "Ctrl+Alt+Del", mods: HID_MOD_LCTRL | HID_MOD_LALT, code: "Delete" },
  { label: "Alt+F4", mods: HID_MOD_LALT, code: "F4" },
  { label: "Alt+Tab", mods: HID_MOD_LALT, code: "Tab" },
  { label: "Ctrl+Alt+F2", mods: HID_MOD_LCTRL | HID_MOD_LALT, code: "F2" },
];

/* Armed for the next key; locked until pressed again. */
const armed = ref(0);
const locked = ref(0);
const mods = computed(() => armed.value | locked.value);
const shifted = computed(() => (mods.value & (HID_MOD_LSHIFT | HID_MOD_RSHIFT)) !== 0);

function pressMod(bit: number) {
  if (locked.value & bit) {
    locked.value &= ~bit;
  } else if (armed.value & bit) {
    armed.value &= ~bit;
    locked.value |= bit;
  } else {
    armed.value |= bit;
  }
}

function sendKey(code: string, extraMods = 0) {
  const usage = usageForCode(code);
  if (!usage) return;
  props.control.keyboard(mods.value | extraMods, [usage]);
  props.control.keyboard(locked.value, []);
  armed.value = 0;
}

/* Held down, a key repeats, the way it would on a real keyboard. */
const REPEAT_DELAY_MS = 400;
const REPEAT_MS = 90;
let delayTimer = 0;
let repeatTimer = 0;

function press(key: Key) {
  haptic();
  if (key.mod) {
    pressMod(key.mod);
    return;
  }
  sendKey(key.code, key.shift ? HID_MOD_LSHIFT : 0);
  release();
  delayTimer = window.setTimeout(() => {
    repeatTimer = window.setInterval(() => {
      const usage = usageForCode(key.code);
      if (usage) {
        props.control.keyboard(locked.value, [usage]);
        props.control.keyboard(locked.value, []);
      }
    }, REPEAT_MS);
  }, REPEAT_DELAY_MS);
}

function release() {
  clearTimeout(delayTimer);
  clearInterval(repeatTimer);
  delayTimer = 0;
  repeatTimer = 0;
}

onUnmounted(() => {
  release();
  mq?.removeEventListener("change", onMediaQuery);
});

/* A media key is held while the finger is on it: the target repeats volume
   steps itself, the way it does for a real keyboard. */
let mediaHeld = false;

function mediaDown(usage: number) {
  haptic();
  mediaHeld = true;
  props.control.consumer(usage);
}

function mediaUp() {
  if (!mediaHeld) return;
  mediaHeld = false;
  props.control.consumer(0);
}

function combo(c: { mods: number; code: string }) {
  haptic();
  const usage = usageForCode(c.code);
  if (!usage) return;
  props.control.keyboard(c.mods, [usage]);
  props.control.keyboard(0, []);
  armed.value = 0;
  locked.value = 0;
}

/*
 * What sort of key this is, which the tinted skin colours by: a modifier, the
 * function row, the navigation block, a lock, one of the big editing keys, or
 * the number pad - its digits lightly, so the block reads as one, and its
 * operators. Any other key that prints a character stays plain in every skin.
 */
function kind(key: Key): string {
  if (key.mod) return "mod";
  if (key.led) return "lock";
  if (/^F\d{1,2}$/.test(key.code) || key.code === "Escape") return "fn";
  if (/^(Arrow|Home|End|Page|Insert|Delete)/.test(key.code)) return "nav";
  if (["Enter", "NumpadEnter", "Backspace", "Tab", "Space"].includes(key.code)) return "edit";
  if (/^Numpad\d$/.test(key.code)) return "pad";
  if (key.code.startsWith("Numpad")) return "op";
  if (["PrintScreen", "Pause", "ScrollLock", "NumLock"].includes(key.code)) return "sys";
  return "char";
}

/* What is being held, in the words on the keys. */
const heldNames = computed(() => {
  const names: string[] = [];
  const all: [number, string][] = [
    [HID_MOD_LCTRL, "Ctrl"],
    [HID_MOD_LALT, "Alt"],
    [HID_MOD_RALT, "AltGr"],
    [HID_MOD_LSHIFT, "Shift"],
    [HID_MOD_RSHIFT, "Shift"],
    [HID_MOD_LGUI, "Win"],
  ];
  for (const [bit, name] of all) {
    if (mods.value & bit && !names.includes(name)) names.push(name);
  }
  return names.join(" + ");
});

/* A letter key, in any layout: one character that has a case. */
function isLetter(text: string): boolean {
  return [...text].length === 1 && text.toLowerCase() !== text.toUpperCase();
}

function label(key: Key): string {
  if (isLetter(key.text)) {
    /* Shown as it would type: Shift capitalises, and so does Caps Lock when
       the target has lit its LED; both at once cancel out. */
    const caps = (props.leds & 2) !== 0;
    return shifted.value !== caps ? key.text.toUpperCase() : key.text.toLowerCase();
  }
  return shifted.value && key.shifted ? key.shifted : key.text;
}

function state(key: Key): Record<string, boolean> {
  return {
    [`vk-k-${kind(key)}`]: true,
    "vk-armed": !!key.mod && (armed.value & key.mod) !== 0,
    "vk-locked": !!key.mod && (locked.value & key.mod) !== 0,
    "vk-lit": !!key.led && (props.leds & key.led) !== 0,
  };
}
</script>

<template>
  <Teleport to="body" :disabled="!floating">
    <section
      ref="panel"
      :class="['vk', `vk-skin-${skin}`, { 'vk-floating': floating }]"
      :style="floating ? { left: pos.x + 'px', top: pos.y + 'px' } : undefined"
      aria-label="On-screen keyboard"
    >
      <div
        class="vk-head"
        :class="{ 'vk-grab': floating }"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointercancel="dragEnd"
      >
        <span class="muted vk-hint">
          <template v-if="heldNames">Holding {{ heldNames }}</template>
          <template v-else>A modifier stays armed for one key, twice to lock it.</template>
        </span>
        <span class="vk-head-actions">
          <button
            v-if="narrow"
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            :class="{ 'btn-on': pane === 'side' }"
            :aria-pressed="pane === 'side'"
            :aria-label="pane === 'keys' ? `Show ${SIDE_NAMES[side.kind]}` : 'Show the keys'"
            :title="pane === 'keys' ? `Show ${SIDE_NAMES[side.kind]}` : 'Show the keys'"
            @click="pane = pane === 'keys' ? 'side' : 'keys'"
          >
            <Icon :name="pane === 'keys' ? 'pointer' : 'keyboard'" :size="15" />
          </button>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            :class="{ 'btn-on': combosOpen }"
            :aria-pressed="combosOpen"
            aria-label="Ready-made combinations"
            :title="combosOpen ? 'Hide Ctrl+Alt+Del and the rest' : 'Ctrl+Alt+Del and the rest'"
            @click="combosOpen = !combosOpen"
          >
            <Icon name="combo" :size="15" />
          </button>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            aria-label="Change how the keys are coloured"
            :title="skin === 'plain' ? 'Colour the keys that are not characters' : 'Plain keys'"
            @click="skin = skin === 'plain' ? 'tinted' : 'plain'"
          >
            <Icon name="palette" :size="15" />
          </button>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            aria-label="Change the layout"
            :title="
              layout === 'full'
                ? 'Only the keys a browser tends to swallow'
                : layout === 'compact'
                  ? 'Symbols and the number pad'
                  : layout === 'symbols'
                    ? 'Function and media keys'
                    : 'Every key'
            "
            @click="cycleLayout"
          >
            <Icon
              :name="
                layout === 'full'
                  ? 'compact'
                  : layout === 'compact'
                    ? 'symbols'
                    : layout === 'symbols'
                      ? 'fn-keys'
                      : 'keyboard'
              "
              :size="15"
            />
          </button>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            :aria-label="floating ? 'Dock it under the picture' : 'Let it float over the page'"
            :title="floating ? 'Dock it under the picture' : 'Let it float over the page, and drag it about'"
            @click="floating = !floating"
          >
            <Icon :name="floating ? 'dock' : 'float'" :size="15" />
          </button>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            aria-label="Close the keyboard"
            title="Close the keyboard"
            @click="emit('close')"
          >
            <Icon name="close" :size="15" />
          </button>
        </span>
      </div>

    <div v-if="combosOpen" class="vk-combos">
      <button
        v-for="c in COMBOS"
        :key="c.label"
        type="button"
        class="btn btn-sm"
        @click="combo(c)"
      >
        {{ c.label }}
      </button>
    </div>

    <div class="vk-body">
      <div v-if="!narrow || pane === 'keys'" class="vk-keys">
        <div v-for="(row, i) in rows" :key="i" class="vk-row">
          <button
            v-for="key in row"
            :key="key.code + key.text"
            type="button"
            class="vk-key"
            :class="state(key)"
            :style="{ flexGrow: key.w ?? 1, flexBasis: `${(key.w ?? 1) * 2.2}rem` }"
            :aria-label="key.text"
            @pointerdown.prevent="press(key)"
            @pointerup="release"
            @pointercancel="release"
            @pointerleave="release"
          >
            {{ label(key) }}
          </button>
        </div>
        <!-- Coloured like the function row they share on a laptop. -->
        <div v-if="layout === 'fn'" class="vk-row vk-media">
          <button
            v-for="m in MEDIA_KEYS"
            :key="m.usage"
            type="button"
            class="vk-key vk-k-fn"
            :aria-label="m.label"
            :title="'note' in m ? `${m.label}. ${m.note}` : m.label"
            @pointerdown.prevent="mediaDown(m.usage)"
            @pointerup="mediaUp"
            @pointercancel="mediaUp"
            @pointerleave="mediaUp"
          >
            <Icon :name="m.icon" :size="15" />
          </button>
        </div>
      </div>

      <!-- Beside the keys, not under them: the arrows, the editing keys or the
           number pad, in the shape they have on a keyboard. -->
      <div
        v-if="!narrow || pane === 'side'"
        :class="['vk-side', `vk-${side.kind}`]"
      >
        <button
          v-for="key in side.keys"
          :key="key.code"
          type="button"
          class="vk-key"
          :class="state(key)"
          :style="(key as any).area ? { gridArea: (key as any).area } : undefined"
          :aria-label="key.text"
          @pointerdown.prevent="press(key)"
          @pointerup="release"
          @pointercancel="release"
          @pointerleave="release"
        >
          {{ key.text }}
        </button>
      </div>
    </div>
    </section>
  </Teleport>
</template>
