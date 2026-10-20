<script setup lang="ts">
/*
 * On-screen controls for touch mode: explicit mouse buttons for the taps that
 * are awkward as gestures, an on-screen keyboard, and the switch that makes a
 * one-finger drag a pointer stick (see useTouch).
 *
 * The keyboard is a hidden text field. Tapping "Keyboard" focuses it, which is
 * what makes the phone's own keyboard appear; each character it produces is
 * translated to a key position through the same layout table the paste feature
 * uses (see layouts.ts), so what the target types matches its own layout. The
 * field never keeps its text - every input is intercepted and re-sent as HID.
 */
import { onUnmounted, ref } from "vue";


import { charToHid } from "../layouts";
import { usageForCode } from "../input/keymap";
import type { Control } from "../input/control";
import { haptic } from "../ui/haptic";

const props = defineProps<{ control: Control; layout: string; stick: boolean }>();
const emit = defineEmits<{ stick: [on: boolean] }>();

/* Key positions that are not characters. */
const ENTER = 0x28;
const BACKSPACE = 0x2a;
const TAB = 0x2b;

const field = ref<HTMLInputElement | null>(null);
const oskOpen = ref(false);

function tap(button: number) {
  haptic();
  props.control.mouseRelative(button, 0, 0);
  props.control.mouseRelative(0, 0, 0);
}

function sendKey(hid: number, mod = 0) {
  props.control.keyboard(mod, [hid]);
  props.control.keyboard(0, []);
}

function sendChar(ch: string) {
  const row = charToHid(props.layout, ch) as { mod: number; hid: number } | null;
  if (row) sendKey(row.hid, row.mod);
}

/*
 * Mobile keyboards report edits through beforeinput, not reliable keydown
 * events, so the text is read from there and the field is kept empty. A word
 * can arrive as one insertText; iterate its characters.
 */
function onBeforeInput(e: InputEvent) {
  e.preventDefault();
  switch (e.inputType) {
    case "insertText":
    case "insertCompositionText":
      if (e.data) for (const ch of e.data) sendChar(ch);
      break;
    case "insertLineBreak":
    case "insertParagraph":
      sendKey(ENTER);
      break;
    case "deleteContentBackward":
      sendKey(BACKSPACE);
      break;
  }
}

/* A few control keys the phone keyboard can emit as real keydowns. */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Backspace") {
    e.preventDefault();
    sendKey(BACKSPACE);
  } else if (e.key === "Enter") {
    e.preventDefault();
    sendKey(ENTER);
  } else if (e.key === "Tab") {
    e.preventDefault();
    sendKey(TAB);
  }
}

/*
 * A pad for the keys a phone keyboard does not have.
 *
 * Arrows are the reason it exists - no soft keyboard offers them, and a BIOS
 * menu or a boot list is unusable without them - and Esc, Tab and Enter come
 * along because they are missing for the same reason and wanted in the same
 * places. Held down, a key repeats, the way it would on a real keyboard: a long
 * list is no fun one tap at a time.
 */
const PAD_REPEAT_DELAY_MS = 400;
const PAD_REPEAT_MS = 90;

/* `area` places each key in the grid below; the arrows keep the shape they have
   on a keyboard so a thumb finds them without reading. */
const PAD_KEYS = [
  { code: "Escape", text: "Esc", label: "Escape", area: "esc" },
  { code: "ArrowUp", text: "\u2191", label: "Arrow up", area: "up" },
  { code: "Tab", text: "Tab", label: "Tab", area: "tab" },
  { code: "ArrowLeft", text: "\u2190", label: "Arrow left", area: "left" },
  { code: "ArrowDown", text: "\u2193", label: "Arrow down", area: "down" },
  { code: "ArrowRight", text: "\u2192", label: "Arrow right", area: "right" },
  { code: "Enter", text: "Enter", label: "Enter", area: "enter" },
];

const padOpen = ref(false);
let repeatTimer = 0;
let repeatInterval = 0;

function padPress(code: string) {
  haptic();
  const hid = usageForCode(code);
  if (!hid) return;
  sendKey(hid);
  padRelease();
  repeatTimer = window.setTimeout(() => {
    repeatInterval = window.setInterval(() => sendKey(hid), PAD_REPEAT_MS);
  }, PAD_REPEAT_DELAY_MS);
}

function padRelease() {
  clearTimeout(repeatTimer);
  clearInterval(repeatInterval);
  repeatTimer = 0;
  repeatInterval = 0;
}

onUnmounted(padRelease);

function toggleKeyboard() {
  if (oskOpen.value) {
    field.value?.blur();
  } else {
    field.value?.focus();
  }
}
</script>

<template>
  <div class="touch-controls" role="toolbar" aria-label="Touch controls">
    <!-- The pad sits above the row so a thumb on it is nowhere near the
         buttons that open and close it. -->
    <div v-if="padOpen" class="touch-pad" role="group" aria-label="Keys">
      <button
        v-for="k in PAD_KEYS"
        :key="k.code"
        type="button"
        class="touch-btn touch-pad-btn"
        :style="{ gridArea: k.area }"
        :aria-label="k.label"
        @pointerdown.prevent="padPress(k.code)"
        @pointerup="padRelease"
        @pointercancel="padRelease"
        @pointerleave="padRelease"
      >
        {{ k.text }}
      </button>
    </div>

    <div class="touch-row">
      <button type="button" class="touch-btn" @click="tap(1)">Left</button>
      <button type="button" class="touch-btn" @click="tap(2)">Right</button>
      <button
        type="button"
        class="touch-btn"
        :class="{ 'touch-btn-on': padOpen }"
        aria-label="Arrow keys"
        @click="padOpen = !padOpen"
      >
        Keys
      </button>
      <button
        type="button"
        class="touch-btn"
        :class="{ 'touch-btn-on': stick }"
        aria-label="Pointer stick"
        title="A drag works as a stick: the pointer keeps moving while the finger is held off where it landed"
        :aria-pressed="stick"
        @click="emit('stick', !stick)"
      >
        Stick
      </button>
      <button
        type="button"
        class="touch-btn"
        :class="{ 'touch-btn-on': oskOpen }"
        @click="toggleKeyboard"
      >
        Keyboard
      </button>
    </div>

    <input
      ref="field"
      class="touch-osk"
      type="text"
      inputmode="text"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      aria-label="On-screen keyboard input"
      :value="''"
      @beforeinput="onBeforeInput"
      @keydown="onKeydown"
      @focus="oskOpen = true"
      @blur="oskOpen = false"
    />
  </div>
</template>

<style scoped>
.touch-controls {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-overlay) 88%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-pop, 0 6px 20px rgba(0, 0, 0, 0.4));
  z-index: 5;
}

.touch-row {
  display: flex;
  gap: 8px;
}

/* Arrows in the shape they have on a keyboard, with the three keys a phone
   hides around them. */
.touch-pad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-areas:
    "esc up tab"
    "left down right"
    "enter enter enter";
  gap: 6px;
}

.touch-pad-btn {
  min-width: 56px;
}

.touch-btn {
  min-width: 64px;
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}

.touch-btn-on {
  border-color: var(--accent);
  color: var(--accent);
}

/* Focusable but invisible: focus is what summons the phone's keyboard, so it
   cannot be display:none. */
.touch-osk {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
}
</style>
