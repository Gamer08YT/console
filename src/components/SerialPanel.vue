<script setup lang="ts">
/*
 * The target's serial console, over the picture's area: for a box with no
 * screen there is no picture to hide, and a BIOS redirected to serial wants
 * the room. It opens a /serial WebSocket, replays what the device kept since
 * boot, and from then on prints what the target sends. With the terminal
 * focused, keys go to the target as a VT100 sends them; a paste goes as text.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

import { keyBytes, Terminal } from "../input/terminal";
import { toast } from "../state/toasts";
import Icon from "./Icon.vue";

const emit = defineEmits<{ close: [] }>();

const SUBSCRIBE = 0x01;
const INPUT = 0x02;

const term = new Terminal(80, 25, 2000);
const tick = ref(0); /* bumped to redraw: the terminal itself is not reactive */
const state = ref<"connecting" | "open" | "closed">("connecting");
const info = ref<{ running: boolean; usb?: boolean; baud: number; tx: number; rx: number } | null>(null);
const box = ref<HTMLElement | null>(null);
let ws: WebSocket | null = null;
let stopped = false;
let retry = 0;
let drawQueued = false;
let infoTimer = 0;

function redraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const el = box.value;
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    tick.value++;
    if (atBottom) void nextTick(() => el && (el.scrollTop = el.scrollHeight));
  });
}

function connect() {
  if (stopped) return;
  state.value = "connecting";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  try {
    ws = new WebSocket(`${proto}://${location.host}/serial`);
  } catch {
    state.value = "closed";
    return;
  }
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    retry = 0;
    state.value = "open";
    /* The device replays its ring from the start; begin from a clean screen. */
    term.reset();
    ws?.send(new Uint8Array([SUBSCRIBE]));
    redraw();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(ev.data));
      redraw();
    }
  };
  ws.onclose = () => {
    state.value = "closed";
    if (stopped) return;
    retry = Math.min(retry + 1, 5);
    window.setTimeout(connect, 1000 * retry);
  };
}

async function readInfo() {
  try {
    const r = await fetch("/api/v1/serial", { credentials: "same-origin" });
    if (r.ok) info.value = await r.json();
  } catch {
    /* the next reading will do */
  }
}

function send(text: string) {
  if (ws?.readyState !== WebSocket.OPEN || !text) return;
  const bytes = new TextEncoder().encode(text);
  const msg = new Uint8Array(bytes.length + 1);
  msg[0] = INPUT;
  msg.set(bytes, 1);
  ws.send(msg);
}

function onKeydown(e: KeyboardEvent) {
  /* Ctrl+Shift+C / V stay with the browser, the way terminals keep them. */
  if (e.ctrlKey && e.shiftKey) return;
  const b = keyBytes(e);
  if (b === null) return;
  e.preventDefault();
  e.stopPropagation();
  send(b);
}

function onPaste(e: ClipboardEvent) {
  const t = e.clipboardData?.getData("text/plain");
  if (!t) return;
  e.preventDefault();
  send(t.replace(/\r?\n/g, "\r"));
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(term.text());
    toast.info("Copied");
  } catch {
    toast.error("Could not copy - select and copy it manually");
  }
}

function clearScreen() {
  term.reset();
  redraw();
}

/* What the device kept, as a file: the raw bytes, not the screen. */
function download() {
  const a = document.createElement("a");
  a.href = "/api/v1/serial/log?bytes=65536";
  a.download = `serial-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  a.click();
}

onMounted(() => {
  connect();
  void readInfo();
  infoTimer = window.setInterval(() => void readInfo(), 5000);
  void nextTick(() => box.value?.focus());
});
onUnmounted(() => {
  stopped = true;
  window.clearInterval(infoTimer);
  ws?.close();
});

/* The 16 colours a VT100 asks for, the xterm way. */
const PALETTE = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

const lines = computed(() => {
  void tick.value;
  const rows = [...term.scrollback, ...term.screen];
  const cursorRow = term.scrollback.length + term.y;
  return rows.map((row, i) => ({
    runs: Terminal.runs(row).map((r) => {
      let fg = r.fg >= 0 ? PALETTE[r.fg + (r.bold && r.fg < 8 ? 8 : 0)] : undefined;
      let bg = r.bg >= 0 ? PALETTE[r.bg] : undefined;
      if (r.inv) [fg, bg] = [bg ?? "var(--term-bg)", fg ?? "var(--term-fg)"];
      return { text: r.text, style: { color: fg, background: bg, fontWeight: r.bold ? "700" : undefined } };
    }),
    cursor: i === cursorRow && term.cursorVisible ? term.x : -1,
  }));
});

const status = computed(() => {
  if (info.value && !info.value.running) return { cls: "pill-off", text: "port off" };
  if (state.value === "open") {
    const text = !info.value ? "open" : info.value.usb ? "USB" : `${info.value.baud} 8N1`;
    return { cls: "pill-on", text };
  }
  return { cls: "pill-off", text: state.value === "connecting" ? "connecting" : "reconnecting" };
});
</script>

<template>
  <Teleport to="main.stage">
    <section class="ser" aria-label="Serial console">
      <div class="ser-head">
        <h3>Serial console</h3>
        <span :class="['pill', status.cls]">{{ status.text }}</span>
        <span v-if="info && info.running && !info.usb" class="ser-pins mono">TX {{ info.tx }} / RX {{ info.rx }}</span>
        <span class="ser-gap" />
        <button type="button" class="btn btn-sm btn-quiet" title="Copy the screen and what scrolled off it" @click="copyAll">
          <Icon name="copy" :size="14" />
        </button>
        <button type="button" class="btn btn-sm btn-quiet" title="Download what the device kept (raw)" @click="download">
          <Icon name="download" :size="14" />
        </button>
        <button type="button" class="btn btn-sm btn-quiet" title="Clear this screen" @click="clearScreen">Clear</button>
        <button type="button" class="btn btn-sm btn-icon btn-quiet" aria-label="Close the serial console" title="Close" @click="emit('close')">
          <Icon name="close" :size="15" />
        </button>
      </div>
      <p v-if="info && !info.running" class="ser-note">
        The serial port is off. Turn it on and pick its pins in Settings &rarr; Power &rarr; Serial console.
      </p>
      <div
        ref="box"
        class="ser-term mono"
        tabindex="0"
        @keydown="onKeydown"
        @paste="onPaste"
      >
        <div v-for="(l, i) in lines" :key="i" class="ser-line">
          <template v-if="l.cursor < 0">
            <span v-for="(r, j) in l.runs" :key="j" :style="r.style">{{ r.text }}</span>
          </template>
          <template v-else>
            <span v-for="(r, j) in l.runs" :key="j" :style="r.style">{{ r.text }}</span>
            <span class="ser-cursor" :style="{ left: `${l.cursor}ch` }" />
          </template>
        </div>
      </div>
      <p class="ser-hint">
        Click the terminal and type; every key goes to the target, Ctrl+C too. Ctrl+Shift+C and Ctrl+Shift+V stay with the browser.
      </p>
    </section>
  </Teleport>
</template>

<style scoped>
.ser {
  --term-bg: #0c0c0c;
  --term-fg: #cccccc;
  position: absolute;
  inset: 0;
  z-index: 7; /* over the gamepad overlay, under the side panel and pop-ups */
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-sunken);
}

.ser-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.ser-head h3 {
  margin: 0;
}

.ser-gap {
  flex: 1;
}

.ser-pins,
.ser-note,
.ser-hint {
  color: var(--text-faint);
  font-size: var(--text-xs);
}

.ser-note,
.ser-hint {
  margin: 0;
}

.ser-term {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--term-bg);
  color: var(--term-fg);
  /* 80 columns across the width, within reason. */
  container-type: inline-size;
  font-size: clamp(10px, 1.7vw, 16px);
  line-height: 1.25;
  white-space: pre;
  outline: none;
}

.ser-term:focus {
  border-color: var(--accent, #3a7bd5);
}

.ser-line {
  position: relative;
  min-height: 1.25em;
}

.ser-cursor {
  position: absolute;
  top: 0;
  width: 1ch;
  height: 1.25em;
  background: rgba(204, 204, 204, 0.6);
  pointer-events: none;
}
</style>
