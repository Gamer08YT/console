<script setup lang="ts">
/*
 * The target's screen, plus every state that is not a picture.
 *
 * A blank rectangle is the worst possible answer to "why can I not see
 * anything": no signal, a target switched off, a stream the browser refused,
 * and a console still starting up all look identical. Each gets its own
 * message, and the ones the operator can act on say what to check.
 *
 * Frames normally arrive over the WebSocket channel and are drawn to a canvas.
 * If that channel produces nothing the old multipart stream is used instead -
 * being locked out of the picture because a transport changed would be worse
 * than using the older one.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { textSpans } from "../screen/textSpans";
import { drawDemoBox, type DemoBoxView } from "./demoBox";
import type { Zoom } from "../input/useTouch";
import { reconnectSource, type ScreenText, type VideoStatus } from "../state/device";
import { pictureRect } from "../video/picture";
import { RtcStream, rtcSupported } from "../video/rtcStream";
import { playersOpen, WsSound, wsSoundSupported } from "../video/sound";
import { VideoStream, type Handlers } from "../video/stream";
import Icon from "./Icon.vue";

const props = defineProps<{
  status: VideoStatus | null;
  /** The serial console is on: with no picture, it may be the way in. */
  serial?: boolean;
  engaged: boolean;
  engageMode: "click" | "hover";
  fit: "fit" | "stretch" | "actual";
  /** Why there is no video at all (no capture board, pipeline did not start). */
  videoBlocked?: string | null;
  /** Paused: nothing is read, so the device stops encoding entirely. */
  paused: boolean;
  /** Shown instead of the usual pause text when something other than the
      operator stopped the stream - currently a firmware upload. */
  pauseNote?: string;
  /** The screen read as characters, when the operator has asked to select it.
      Null means no layer: the picture behaves as usual. */
  textLayer?: ScreenText | null;
  /**
   * Show that layer instead of the picture, rather than invisibly over it.
   *
   * The text mode: what the target's screen says, as characters, at a few
   * kilobytes a screen instead of megabits a second. It is an extra way to look
   * at a machine - over a phone tether, over a link that will not carry video -
   * not a replacement for the picture, which is why it is a button and not a
   * setting.
   */
  textView?: boolean;
  /** The device lets this console take H.264 over WebRTC. */
  webrtc?: boolean;
  /** The device has the target's sound. */
  audio?: boolean;
  /** Pinch zoom in touch mode; see useTouch. */
  zoom?: Zoom;
  /** The operator wants to hear it. */
  sound?: boolean;
}>();

const emit = defineEmits<{ surface: [HTMLElement | null]; "open-serial": []; wake: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const img = ref<HTMLImageElement | null>(null);
const useWebsocket = ref(true);
const failed = ref(false);
const loaded = ref(false);
/** Why this browser cannot play the stream, when that is the problem. */
const codecError = ref<string | null>(null);
const streamUrl = ref("/stream");
/*
 * The multipart element is hidden while the WebSocket carries the picture, and
 * hidden is not the same as gone: with a src set, the browser keeps downloading
 * it. So the device was sending every frame twice, to a canvas nobody could see
 * and to a socket that was the real one - 36 Mbit/s out of a board doing 1080p,
 * which is what the console kept reconnecting over. No src, no second stream.
 */
const imgSrc = computed(() => (useWebsocket.value ? undefined : streamUrl.value));

let stream: VideoStream | RtcStream | null = null;
let wsSound: WsSound | null = null;
/* WebRTC failed on this page; the WebSocket carries the picture until the
   codec changes. Going back and forth would make the picture blink. */
let rtcFailed = false;

/** Take the picture over WebRTC: H.264 only, and only where both ends can. */
function wantRtc(): boolean {
  return !rtcFailed && Boolean(props.webrtc) && props.status?.codec === "h264" && rtcSupported();
}
let ctx: CanvasRenderingContext2D | null = null;

/* Demo build only (static site at /demo/): there is no device, so the "screen"
   is drawn here. A booting machine is drawn as the character grid the demo
   backend reports - the same grid the selection layer sits on, so Select and
   Copy work on it - and once it has booted, an abstract constellation that
   follows the cursor. Tree-shaken out of the firmware build. */
const DEMO = import.meta.env.MODE === "demo";
let demoRAF = 0;
let demoCleanup: (() => void) | null = null;

/* The demo backend hands its screen over on the window rather than through an
   import, so nothing in this component can pull the demo into a real build. */
interface DemoGrid {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  originX: number;
  originY: number;
  text: string;
  /** A blue screen has to be blue, so the demo says what to paint behind it. */
  bg?: string;
}
const demoGrid = () =>
  (window as unknown as { __espkvmDemoScreen?: () => DemoGrid | null })
    .__espkvmDemoScreen?.() ?? null;
const demoScene = () =>
  (window as unknown as { __espkvmDemoScene?: () => string }).__espkvmDemoScene?.() ?? "particles";
/* How long the machine has been in this stage. The scene's own clock has to come
   from the machine: a picture that follows a text screen would otherwise inherit
   whatever the drawing loop last remembered. */
const demoBox = () =>
  (window as unknown as { __espkvmDemoBox?: () => DemoBoxView | null }).__espkvmDemoBox?.() ?? null;
const demoSceneMs = () =>
  (window as unknown as { __espkvmDemoSceneMs?: () => number }).__espkvmDemoSceneMs?.() ?? 0;

/* A flake of six lambdas - the letter the guest is named after. It sits under
   the animation rather than on it: a wallpaper, not a badge. */
function drawLambdaFlake(c: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
  /* Six lambdas around a small hexagonal hole. Each arm is a bar out of the hole
     that forks near its end, and every end is cut square - a sharp outward point
     turns the six into a six-pointed star instead, which is not the idea. */
  const HOLE = 0.2;
  const REACH = 1.0;
  const FORK_AT = 0.46;
  const FORK_LEN = 0.66;
  const FORK = Math.PI / 3;
  c.save();
  c.globalAlpha = 0.2;
  c.lineWidth = R * 0.2;
  c.lineJoin = "miter";
  c.lineCap = "butt";
  for (let i = 0; i < 6; i++) {
    c.save();
    c.translate(cx, cy);
    c.rotate((i * Math.PI) / 3);
    c.strokeStyle = i % 2 ? "#7EBAE4" : "#5277C3";
    c.beginPath();
    c.moveTo(R * HOLE, 0);
    c.lineTo(R * REACH, 0);
    c.stroke();
    c.beginPath();
    c.moveTo(R * FORK_AT, 0);
    c.lineTo(R * FORK_AT + Math.cos(FORK) * R * FORK_LEN, Math.sin(FORK) * R * FORK_LEN);
    c.stroke();
    c.restore();
  }
  c.restore();
}

/* Windows, as remembered rather than as it was: flat hills, and sheep on them.
   One curve does both jobs - the ground is drawn from it, and the sheep walk on
   it, so their feet land where the grass is. */
const hillY = (x: number, W: number, H: number, base: number, amp: number, phase: number) =>
  H * base - Math.sin((x / W) * Math.PI + phase) * H * amp;

function fillHill(c: CanvasRenderingContext2D, W: number, H: number, base: number, amp: number, phase: number, colour: string) {
  c.fillStyle = colour;
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += 8) c.lineTo(x, hillY(x, W, H, base, amp, phase));
  c.lineTo(W, H);
  c.closePath();
  c.fill();
}

/* The flock. They graze the whole meadow, not the ridge line: `deep` is how far
   down the grass one stands, 0 at the crest and 1 at the bottom of the frame,
   and that is also its size - the near ones are bigger. One is black, and it is
   the one that ends the world. */
const SHEEP = Array.from({ length: 9 }, (_, i) => ({
  x: (i * 181) % 1280,
  y: 0,
  deep: 0.1 + ((i * 37) % 80) / 100,
  drift: (i % 2 ? 1 : -1) * (0.02 + ((i * 13) % 7) / 200),
  speed: 13 + ((i * 7) % 12),
  size: 1,
  dir: i % 3 === 0 ? -1 : 1,
  black: i === 4,
}));
/** Where the black one was last drawn, so a click can be tested against it. */
const blackSheepAt = { x: -1, y: -1, r: 34 };

function drawSheep(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  k: number,
  phase: number,
  dir: number,
  black = false,
) {
  c.save();
  c.translate(x, y);
  c.scale(dir * k, k);
  /* legs first, so the body covers where they meet it */
  c.strokeStyle = "#3b3b46";
  c.lineWidth = 3;
  c.lineCap = "round";
  for (const [i, at] of [-9, -3, 4, 10].entries()) {
    const swing = Math.sin(phase + i * 1.6) * 3;
    c.beginPath();
    c.moveTo(at, -6);
    c.lineTo(at + swing, 6);
    c.stroke();
  }
  c.fillStyle = black ? "#2f2f36" : "#f6f4ef";
  c.beginPath();
  c.ellipse(0, -12, 15, 10, 0, 0, Math.PI * 2);
  c.fill();
  /* a few bumps, so it reads as wool and not a pebble */
  for (const [bx, by, r] of [[-9, -18, 5], [-2, -21, 6], [6, -19, 5], [12, -15, 4]]) {
    c.beginPath();
    c.arc(bx, by, r, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = black ? "#15151a" : "#3b3b46";
  c.beginPath();
  c.ellipse(16, -16, 6, 4.5, 0.2, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(13, -20, 2.6, 3.4, -0.4, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/* The other guest, in three acts: the machine that smiles at you, the fruit with
   a progress bar, and a desktop. No trademarks are drawn - the joke is a pear. */
function drawBar(c: CanvasRenderingContext2D, cx: number, y: number, w: number, frac: number, back: string, fill: string) {
  const h = 10;
  c.fillStyle = back;
  c.beginPath();
  c.roundRect(cx - w / 2, y, w, h, h / 2);
  c.fill();
  c.fillStyle = fill;
  c.beginPath();
  c.roundRect(cx - w / 2, y, Math.max(h, w * frac), h, h / 2);
  c.fill();
}

function drawHappyMac(c: CanvasRenderingContext2D, W: number, H: number, k: number) {
  c.fillStyle = "#b9b9b9";
  c.fillRect(0, 0, W, H);
  const bw = 210;
  const bh = 250;
  const x = W / 2 - bw / 2;
  const y = H / 2 - bh / 2 - 30;
  c.fillStyle = "#ded3c0";
  c.beginPath();
  c.roundRect(x, y, bw, bh, 16);
  c.fill();
  /* its screen, and the face on it */
  c.fillStyle = "#e9e9e4";
  c.beginPath();
  c.roundRect(x + 26, y + 26, bw - 52, 130, 8);
  c.fill();
  c.strokeStyle = "#2c2c30";
  c.lineWidth = 6;
  c.lineCap = "round";
  for (const ex of [-30, 30]) {
    c.beginPath();
    c.moveTo(W / 2 + ex, y + 68);
    c.lineTo(W / 2 + ex, y + 84);
    c.stroke();
  }
  c.beginPath();
  c.arc(W / 2, y + 92, 26, 0.25 * Math.PI, 0.75 * Math.PI);
  c.stroke();
  /* the drive slot, because that is what it booted from */
  c.fillStyle = "#c3b8a5";
  c.fillRect(x + 40, y + 186, bw - 80, 10);
  c.fillStyle = "#2c2c30";
  c.font = "22px ui-serif, Georgia, serif";
  /* Alignment is context state that outlives the call: the text screens leave
     the baseline at the top, and a line drawn after one of those sits lower than
     it was placed. Say it here rather than inherit it. */
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  c.fillText("Welcome to Peartosh", W / 2, y + bh + 44);
  drawBar(c, W / 2, y + bh + 66, 240, k, "#a5a5a5", "#4a4a4f");
  c.textAlign = "left";
}

function drawPearBoot(c: CanvasRenderingContext2D, W: number, H: number, k: number) {
  c.fillStyle = "#0b0b0d";
  c.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2 - 40;
  c.fillStyle = "#e8e8ea";
  /* a pear: two circles for the body, a waist between them, a stem and a leaf */
  c.beginPath();
  c.moveTo(cx, cy - 46);
  c.bezierCurveTo(cx + 34, cy - 40, cx + 26, cy + 4, cx + 40, cy + 32);
  c.bezierCurveTo(cx + 52, cy + 66, cx + 26, cy + 88, cx, cy + 88);
  c.bezierCurveTo(cx - 26, cy + 88, cx - 52, cy + 66, cx - 40, cy + 32);
  c.bezierCurveTo(cx - 26, cy + 4, cx - 34, cy - 40, cx, cy - 46);
  c.fill();
  /* A bite, and from the left - the other fruit is bitten on the right. */
  c.fillStyle = "#0b0b0d";
  c.beginPath();
  c.arc(cx - 40, cy + 28, 25, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#e8e8ea";
  c.strokeStyle = "#e8e8ea";
  c.lineWidth = 6;
  c.beginPath();
  c.moveTo(cx, cy - 44);
  c.lineTo(cx + 4, cy - 76);
  c.stroke();
  c.beginPath();
  c.ellipse(cx + 26, cy - 76, 20, 9, -0.5, 0, Math.PI * 2);
  c.fill();
  drawBar(c, cx, cy + 132, 300, k, "#26262b", "#e8e8ea");
}

/* The dock, in one place: drawn from these numbers and hit-tested against them,
   so a tile that looks pressable is the one that answers. */
const DOCK = { w: 420, pad: 18, step: 66, tile: 46, high: 40, up: 14 };
function dockTile(W: number, H: number, i: number) {
  return {
    x: W / 2 - DOCK.w / 2 + DOCK.pad + i * DOCK.step,
    y: H - 64,
    w: DOCK.tile,
    h: DOCK.high,
  };
}
function dockHit(W: number, H: number, x: number, y: number): number {
  for (let i = 0; i < 6; i++) {
    const t = dockTile(W, H, i);
    if (x > t.x && x < t.x + t.w && y > t.y - DOCK.up && y < t.y + t.h) return i;
  }
  return -1;
}

function drawPearDesktop(
  c: CanvasRenderingContext2D,
  W: number,
  H: number,
  hover: { x: number; y: number } | null,
) {
  c.fillStyle = "#2f4f7a";
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#3c628f";
  c.beginPath();
  c.moveTo(0, H * 0.62);
  c.bezierCurveTo(W * 0.3, H * 0.5, W * 0.7, H * 0.78, W, H * 0.6);
  c.lineTo(W, H);
  c.lineTo(0, H);
  c.fill();
  c.fillStyle = "rgba(240,240,245,0.9)";
  c.fillRect(0, 0, W, 30);
  c.fillStyle = "#2c2c30";
  c.font = "15px ui-sans-serif, system-ui, sans-serif";
  c.textAlign = "left";
  c.textBaseline = "middle";
  c.fillText("Pear   Finder   File   Edit   View   Go   Window   Help", 44, 15);
  c.beginPath();
  c.ellipse(24, 15, 7, 8, 0, 0, Math.PI * 2);
  c.fill();
  /* a flat dock, enough of one to say what this is */
  c.fillStyle = "rgba(240,240,245,0.75)";
  c.beginPath();
  c.roundRect(W / 2 - DOCK.w / 2, H - 74, DOCK.w, 58, 16);
  c.fill();
  const over = hover ? dockHit(W, H, hover.x, hover.y) : -1;
  const colours = ["#5b8def", "#57b894", "#e6a23c", "#e26d6d", "#9b6de2", "#6dc7e2"];
  colours.forEach((col, i) => {
    const t = dockTile(W, H, i);
    /* A tile rises under the pointer. Without it the dock looks painted on, and
       nobody finds the one that does something. */
    const lift = i === over ? DOCK.up : 0;
    c.fillStyle = col;
    c.beginPath();
    c.roundRect(t.x, t.y - lift, t.w, t.h, 10);
    c.fill();
    if (lift) {
      c.fillStyle = "rgba(255,255,255,0.85)";
      c.beginPath();
      c.arc(t.x + t.w / 2, H - 12, 3, 0, Math.PI * 2);
      c.fill();
    }
  });
}

function drawMac(
  c: CanvasRenderingContext2D,
  W: number,
  H: number,
  ms: number,
  hover: { x: number; y: number } | null,
) {
  if (ms < 3200) return drawHappyMac(c, W, H, Math.min(1, ms / 2800));
  const t = ms - 3200;
  /* The bar that stops at nine tenths, which is the whole joke. */
  const k = t < 2200 ? (t / 2200) * 0.9 : t < 6200 ? 0.9 : Math.min(1, 0.9 + (t - 6200) / 900);
  if (t < 7400) return drawPearBoot(c, W, H, k);
  drawPearDesktop(c, W, H, hover);
}

/* Sheep follow a shepherd. With nobody driving they graze along the hill; once
   the visitor takes control they walk to the pointer and stand round it - which
   is also the moment the demo is quietly showing that the mouse really works. */
function moveFlock(W: number, H: number, dt: number, herd: { x: number; y: number } | null) {
  /* The hill is drawn against the full frame, so the curve is measured against
     it - but nothing grazes behind the taskbar, hence the floor. */
  const floor = H - BAR.h - 18;
  SHEEP.forEach((s, i) => {
    const top = hillY(s.x, W, H, 0.86, 0.19, 0.55) + 6;
    if (herd) {
      /* A ring around the pointer, flattened because the grass is a plane seen
         at an angle. A place each, so they stand around it instead of piling on
         the same spot. */
      const slot = (i / SHEEP.length) * Math.PI * 2;
      const wantX = herd.x + Math.cos(slot) * 150;
      const wantY = herd.y + Math.sin(slot) * 52;
      const dx = wantX - s.x;
      const dy = wantY - s.y;
      if (Math.abs(dx) > 4) s.dir = dx > 0 ? 1 : -1;
      /* Its own pace, so they arrive one after another rather than in step, and
         slow enough to watch: about ten seconds across the meadow. */
      const pace = 95 + s.speed * 2.5;
      s.x += Math.max(-pace, Math.min(pace, dx * 1.2)) * dt;
      s.y += Math.max(-pace / 2, Math.min(pace / 2, dy * 1.2)) * dt;
      s.y = Math.max(top, Math.min(floor, s.y));
      s.deep = (s.y - top) / Math.max(1, floor - top);
    } else {
      /* Grazing: along the grass and slowly up and down it, turning back at the
         crest and at the near edge. */
      s.x = (s.x + s.speed * s.dir * dt + W) % W;
      s.deep += s.drift * dt;
      if (s.deep < 0.06 || s.deep > 0.94) {
        s.drift = -s.drift;
        s.deep = Math.max(0.06, Math.min(0.94, s.deep));
      }
      s.y = top + s.deep * (floor - top);
    }
    /* Nearer is bigger, which is the only perspective this meadow needs. */
    s.size = 0.7 + s.deep * 1.0;
  });
}

/* The pointer, drawn on the screen the way a KVM draws the target's own cursor.
   Every picture guest gets it - it is the visitor's hand in the demo - and it is
   drawn only while they are actually driving. */
/* The launcher, drawn the way rofi looks: a box, the line you are typing, and
   the matches under it. */
interface Launcher {
  query: string;
  items: string[];
  sel: number;
}
const demoLauncher = () =>
  (window as unknown as { __espkvmDemoLauncher?: () => Launcher | null }).__espkvmDemoLauncher?.() ??
  null;

/* A status bar of the kind a tiling desktop wears: workspaces on the left, what
   is focused in the middle, the machine's own numbers on the right. */
function drawHalfBar(c: CanvasRenderingContext2D, W: number, quiet: boolean) {
  const h = 30;
  c.fillStyle = "rgba(10,16,24,0.82)";
  c.fillRect(0, 0, W, h);
  c.fillStyle = "#5277C3";
  c.fillRect(0, h - 2, W, 2);
  c.textBaseline = "middle";
  c.textAlign = "left";
  c.font = "14px ui-monospace, Menlo, Consolas, monospace";
  ["1", "2", "3", "4"].forEach((n, i) => {
    const x = 12 + i * 30;
    if (i === 1) {
      c.fillStyle = "#5277C3";
      c.beginPath();
      c.roundRect(x - 6, 6, 24, h - 12, 4);
      c.fill();
    }
    c.fillStyle = i === 1 ? "#fff" : "#8fa3bd";
    c.fillText(n, x, h / 2);
  });
  c.fillStyle = "#c8d6e5";
  c.textAlign = "center";
  c.fillText("halfos - the meadow is next door", W / 2, h / 2);
  c.textAlign = "right";
  c.fillStyle = "#8fa3bd";
  const now = new Date();
  c.fillText(
    `43C  ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`,
    W - 14,
    h / 2,
  );
  c.textAlign = "left";
  if (quiet) {
    /* The launcher has no button, so the desktop says how to reach it. */
    c.textAlign = "center";
    c.fillStyle = "rgba(200,214,229,0.5)";
    c.font = "15px ui-sans-serif, system-ui, sans-serif";
    c.fillText("type anything to run something", W / 2, 58);
    c.textAlign = "left";
  }
}

function drawLauncher(c: CanvasRenderingContext2D, W: number, H: number, l: Launcher) {
  const w = 620;
  const rowH = 40;
  const h = 62 + Math.max(1, Math.min(6, l.items.length)) * rowH;
  const x = (W - w) / 2;
  const y = H * 0.22;
  c.fillStyle = "rgba(12,16,22,0.94)";
  c.beginPath();
  c.roundRect(x, y, w, h, 10);
  c.fill();
  c.strokeStyle = "#5277C3";
  c.lineWidth = 2;
  c.stroke();
  c.textAlign = "left";
  c.textBaseline = "middle";
  c.font = "20px ui-monospace, Menlo, Consolas, monospace";
  c.fillStyle = "#7EBAE4";
  c.fillText("run:", x + 20, y + 32);
  c.fillStyle = "#e8eef6";
  c.fillText(l.query + (Math.floor(performance.now() / 500) % 2 ? "_" : ""), x + 76, y + 32);
  l.items.slice(0, 6).forEach((item, i) => {
    const ry = y + 62 + i * rowH;
    if (i === l.sel) {
      c.fillStyle = "#5277C3";
      c.beginPath();
      c.roundRect(x + 8, ry, w - 16, rowH - 4, 6);
      c.fill();
    }
    c.fillStyle = i === l.sel ? "#fff" : "#b9c6d6";
    c.font = "18px ui-monospace, Menlo, Consolas, monospace";
    c.fillText(item, x + 22, ry + rowH / 2 - 2);
  });
  if (!l.items.length) {
    c.fillStyle = "#7b8797";
    c.fillText("no match", x + 22, y + 82);
  }
}

function drawCursor(c: CanvasRenderingContext2D, x: number, y: number) {
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x, y + 22);
  c.lineTo(x + 6, y + 16);
  c.lineTo(x + 13, y + 24);
  c.lineTo(x + 17, y + 21);
  c.lineTo(x + 10, y + 13);
  c.lineTo(x + 18, y + 12);
  c.closePath();
  c.fillStyle = "#fff";
  c.strokeStyle = "#000";
  c.lineWidth = 1.5;
  c.fill();
  c.stroke();
}

/* The taskbar, and the button that is not called Start. Geometry in one place,
   so what looks pressable is what answers a click. */
const BAR = { h: 44, btnW: 108, menuW: 250, menuH: 200, menuTop: 28 };
let startOpen = false;

function startButton(W: number, H: number) {
  void W;
  return { x: 8, y: H - BAR.h + 6, w: BAR.btnW, h: BAR.h - 12 };
}
function startItems(H: number) {
  const labels = ["Programs", "Documents", "Settings", "Shut Down"];
  return labels.map((label, i) => ({
    label,
    x: 8,
    y: H - BAR.h - BAR.menuH + BAR.menuTop + 12 + i * 40,
    w: BAR.menuW - 16,
    h: 36,
  }));
}

function drawTaskbar(c: CanvasRenderingContext2D, W: number, H: number, hover: { x: number; y: number } | null) {
  if (startOpen) {
    const mx = 4;
    const my = H - BAR.h - BAR.menuH;
    c.fillStyle = "#f4f6fb";
    c.beginPath();
    c.roundRect(mx, my, BAR.menuW, BAR.menuH, 8);
    c.fill();
    c.fillStyle = "#245edb";
    c.beginPath();
    c.roundRect(mx, my, BAR.menuW, BAR.menuTop, [8, 8, 0, 0]);
    c.fill();
    c.fillStyle = "#fff";
    c.font = "14px ui-sans-serif, system-ui, sans-serif";
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText("shepherd", mx + 12, my + BAR.menuTop / 2);
    for (const item of startItems(H)) {
      const over = hover && hover.x > item.x && hover.x < item.x + item.w && hover.y > item.y && hover.y < item.y + item.h;
      if (over) {
        c.fillStyle = "#316ac5";
        c.beginPath();
        c.roundRect(item.x, item.y, item.w, item.h, 5);
        c.fill();
      }
      c.fillStyle = over ? "#fff" : "#1b1b22";
      c.font = "15px ui-sans-serif, system-ui, sans-serif";
      c.fillText(item.label, item.x + 12, item.y + item.h / 2);
    }
  }

  c.fillStyle = "#245edb";
  c.fillRect(0, H - BAR.h, W, BAR.h);
  const b = startButton(W, H);
  c.fillStyle = startOpen ? "#2f7f2f" : "#3ca03c";
  c.beginPath();
  c.roundRect(b.x, b.y, b.w, b.h, 8);
  c.fill();
  c.fillStyle = "#fff";
  c.font = "bold 17px ui-sans-serif, system-ui, sans-serif";
  c.textAlign = "left";
  c.textBaseline = "middle";
  c.fillText("finish", b.x + 16, b.y + b.h / 2);
  /* One window on the bar, and a clock, because a taskbar without them is a
     blue stripe. */
  c.fillStyle = "#3a72e0";
  c.beginPath();
  c.roundRect(b.x + b.w + 10, b.y, 190, b.h, 4);
  c.fill();
  c.fillStyle = "#e8eefc";
  c.font = "14px ui-sans-serif, system-ui, sans-serif";
  c.fillText("Meadow", b.x + b.w + 22, b.y + b.h / 2);
  const now = new Date();
  const clock = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  c.textAlign = "right";
  c.fillText(clock, W - 16, H - BAR.h / 2);
  c.textAlign = "left";
}

function drawHills(
  c: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  dt: number,
  herd: { x: number; y: number } | null,
) {
  c.fillStyle = "#4b8fe3";
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#ffffff";
  for (const [cx, cy, r] of [[210, 120, 26], [250, 128, 34], [292, 122, 22], [880, 90, 20], [915, 98, 28], [950, 92, 18]]) {
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
  }
  fillHill(c, W, H, 0.72, 0.16, 2.4, "#4f8f38");
  fillHill(c, W, H, 0.86, 0.19, 0.55, "#77bd4b");
  moveFlock(W, H, dt, herd);
  /* Far ones first, so a near sheep passes in front of one further up. */
  for (const s of [...SHEEP].sort((a, b) => a.y - b.y)) {
    drawSheep(c, s.x, s.y, s.size, (t / 220) * s.speed * 0.08, s.dir, s.black);
    if (s.black) {
      blackSheepAt.x = s.x;
      blackSheepAt.y = s.y;
      blackSheepAt.r = 30 * s.size;
    }
  }
  drawTaskbar(c, W, H, herd);
}

/* Characters go where the grid says, one at a time: the transparent selection
   layer is placed by the same numbers, and a drawn character that does not sit
   under its own hitbox is worse than no picture at all. */
function drawDemoGrid(c: CanvasRenderingContext2D, g: DemoGrid, W: number, H: number) {
  c.fillStyle = g.bg ?? "#05080c";
  c.fillRect(0, 0, W, H);
  c.fillStyle = g.bg ? "#eef2f8" : "#c8d6e5";
  c.textBaseline = "top";
  c.font = `${Math.round(g.cellHeight * 0.82)}px ui-monospace, Menlo, Consolas, monospace`;
  const rows = g.text.split("\n");
  for (let r = 0; r < rows.length; r++) {
    const y = g.originY + r * g.cellHeight + g.cellHeight * 0.1;
    for (let col = 0; col < rows[r].length; col++) {
      const ch = rows[r][col];
      if (ch !== " ") c.fillText(ch, g.originX + col * g.cellWidth, y);
    }
  }
}

function startDemoScreen() {
  const el = canvas.value;
  const c = el?.getContext("2d");
  if (!el || !c) return;
  const W = 1280;
  const H = 720;
  el.width = W;
  el.height = H;
  loaded.value = true;
  failed.value = false;

  const pts = Array.from({ length: 120 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
  }));
  const target = { x: W / 2, y: H / 2 };
  const cur = { x: W / 2, y: H / 2 };
  /* Where the drawn arrow is. It is not `cur`: handing control back (Esc) leaves
     the target's own pointer standing where it was, the way a real machine does,
     while the picture behind it carries on moving. */
  const pointerAt = { x: W / 2, y: H / 2 };
  /* Whether the visitor has ever driven. Before that there is no pointer to
     draw, and an arrow parked in the middle of the screen looks broken. */
  let everPointed = false;
  let hasPointer = false;
  /* When the pointer last actually moved. A hand that has gone still is not a
     shepherd, so the flock stops following it and goes back to the grass. */
  let movedAt = -1e9;
  const STILL_MS = 4000;
  let clickT = -1e9;
  const PULSE = 520;

  /* Follow the real cursor only once the visitor has engaged (clicked to take
     control), like the real KVM; otherwise the screen drifts on its own. The
     eased cursor trails slightly behind; a click sends a discharge along the
     rays. */
  /* Where a screen pixel is on the canvas. In "fit" the canvas is letterboxed
     inside its box, so the bars have to come off first - mapping against the
     whole box drifts the pointer on whichever axis is padded. The same sum the
     real input path does in mapToTarget(). */
  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const scale =
      props.fit === "stretch"
        ? Math.min(r.width / W, r.height / H)
        : Math.min(1, r.width / W, r.height / H);
    const shownW = W * scale;
    const shownH = H * scale;
    const x = ((e.clientX - r.left - (r.width - shownW) / 2) / shownW) * W;
    const y = ((e.clientY - r.top - (r.height - shownH) / 2) / shownH) * H;
    if (x < 0 || y < 0 || x > W || y > H) return null;
    return { x, y };
  };

  const onMove = (e: PointerEvent) => {
    if (!props.engaged) return;
    /* Pointer lock (relative mode) freezes the page's own cursor; the moves
       arrive as relative reports instead - see onHid below. */
    if (document.pointerLockElement) return;
    const p = toCanvas(e);
    if (!p) return;
    if (Math.hypot(p.x - target.x, p.y - target.y) > 1) movedAt = performance.now();
    target.x = p.x;
    target.y = p.y;
    hasPointer = true;
  };
  const crash = () =>
    (window as unknown as { __espkvmDemoCrash?: () => void }).__espkvmDemoCrash?.();

  const onDown = (e: PointerEvent) => {
    if (!props.engaged || document.pointerLockElement) return;
    const p = toCanvas(e);
    if (!p) return;
    pressAt(p.x, p.y);
  };

  /* The relative reports the console sends - the phone's touchpad, or pointer
     lock - moving the demo machine's own pointer, the way they move a real
     target's. Absolute ones need nothing: the page's cursor already says where. */
  let hidAt = -1e9;
  let hidButtons = 0;
  const HID_DRIVES_MS = 3000;
  const onHid = (dx: number, dy: number, buttons: number) => {
    const now = performance.now();
    hidAt = now;
    if (dx || dy) {
      target.x = Math.min(W, Math.max(0, target.x + (dx * W) / 1280));
      target.y = Math.min(H, Math.max(0, target.y + (dy * H) / 720));
      movedAt = now;
    }
    hasPointer = true;
    if (buttons & 1 && !(hidButtons & 1)) pressAt(target.x, target.y);
    hidButtons = buttons;
  };
  (window as unknown as { __espkvmDemoHid?: typeof onHid }).__espkvmDemoHid = onHid;

  const pressAt = (x: number, y: number) => {
    clickT = performance.now();
    const scene = demoScene();
    /* Petting the black sheep is a mistake, and so is the red one in the dock. */
    if (scene === "hills") {
      const b = startButton(W, H);
      const onButton = x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
      if (onButton) {
        startOpen = !startOpen;
      } else if (startOpen) {
        const item = startItems(H).find(
          (it) => x > it.x && x < it.x + it.w && y > it.y && y < it.y + it.h,
        );
        startOpen = false;
        /* Only one of them does anything, and it is the honest one. */
        if (item?.label === "Shut Down") {
          (window as unknown as { __espkvmDemoPower?: (a: string) => void }).__espkvmDemoPower?.(
            "hold",
          );
        }
      } else if (Math.hypot(x - blackSheepAt.x, y - blackSheepAt.y + 14) < blackSheepAt.r) {
        crash();
      }
    } else if (scene === "mac" && demoSceneMs() > 10600) {
      /* The red one is the one that ends it; the rest just bounce. */
      if (dockHit(W, H, x, y) === 3) crash();
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerdown", onDown);
  demoCleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerdown", onDown);
    delete (window as unknown as { __espkvmDemoHid?: typeof onHid }).__espkvmDemoHid;
  };

  const t0 = performance.now();
  let lastText = "";
  let lastFrame = 0;
  const draw = (t: number) => {
    const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
    lastFrame = t;
    /* A text screen while the machine is booting or sitting at a prompt. It
       changes rarely, so it is redrawn only when it changes. */
    const g = demoGrid();
    if (g) {
      if (g.text !== lastText) {
        lastText = g.text;
        drawDemoGrid(c, g, W, H);
      }
      demoRAF = requestAnimationFrame(draw);
      return;
    }
    lastText = "";
    /* The eased pointer is caught up here, before the branches, because every
       picture guest draws it - not just the constellation. */
    const byHid = t - hidAt < HID_DRIVES_MS;
    if (!props.engaged && !byHid) hasPointer = false;
    const driving = (props.engaged || byHid) && hasPointer;
    /* The scene's focus eases along whatever it is given - the visitor's hand
       while they drive, its own wandering when they do not. */
    cur.x += (target.x - cur.x) * 0.18;
    cur.y += (target.y - cur.y) * 0.18;
    if (driving) {
      pointerAt.x = cur.x;
      pointerAt.y = cur.y;
      everPointed = true;
    }
    /* The picture guests are redrawn every frame. */
    const scene = demoScene();
    if (scene === "off") {
      /* Powered off: the same nothing a KVM shows when the target stops
         driving the cable. The status bar says "No signal" beside it. */
      c.fillStyle = "#000";
      c.fillRect(0, 0, W, H);
      lastText = "";
      demoRAF = requestAnimationFrame(draw);
      return;
    }
    if (scene === "hills") {
      /* The flock only has a shepherd once the visitor is actually driving, and
         only while the hand keeps moving. */
      const shepherd = driving && t - movedAt < STILL_MS ? cur : null;
      drawHills(c, W, H, t, dt, shepherd);
      if (everPointed) drawCursor(c, pointerAt.x, pointerAt.y);
      demoRAF = requestAnimationFrame(draw);
      return;
    }
    if (scene === "box") {
      /* The TV box draws no pointer: it is driven by the remote, not a mouse. */
      const b = demoBox();
      if (b) drawDemoBox(c, W, H, b);
      demoRAF = requestAnimationFrame(draw);
      return;
    }
    if (scene === "mac") {
      drawMac(c, W, H, demoSceneMs(), driving ? cur : null);
      if (everPointed) drawCursor(c, pointerAt.x, pointerAt.y);
      demoRAF = requestAnimationFrame(draw);
      return;
    }
    const s = (t - t0) / 1000;
    /* Gentle autonomous motion until the visitor moves the mouse. */
    if (!hasPointer) {
      target.x = W / 2 + Math.cos(s * 0.6) * W * 0.34;
      target.y = H / 2 + Math.sin(s * 0.9) * H * 0.34;
    }
    c.fillStyle = "#0a141d";
    c.fillRect(0, 0, W, H);
    drawLambdaFlake(c, W / 2, H / 2, Math.min(W, H) * 0.36);
    const glow = c.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, 340);
    glow.addColorStop(0, "rgba(76,154,255,0.20)");
    glow.addColorStop(1, "rgba(76,154,255,0)");
    c.fillStyle = glow;
    c.fillRect(0, 0, W, H);

    const age = t - clickT;
    const pulse = age >= 0 && age < PULSE ? 1 - age / PULSE : 0;
    const ease = pulse > 0 ? 1 - Math.pow(1 - age / PULSE, 3) : 0;
    const R = 260;
    for (const p of pts) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x += W;
      else if (p.x > W) p.x -= W;
      if (p.y < 0) p.y += H;
      else if (p.y > H) p.y -= H;
      const d = Math.hypot(p.x - cur.x, p.y - cur.y);
      const near = d < R ? 1 - d / R : 0;
      c.beginPath();
      c.arc(p.x, p.y, 1 + near * 2.5 + pulse * near * 3, 0, Math.PI * 2);
      c.fillStyle = `rgba(150,190,230,${0.1 + near * 0.6 + pulse * near * 0.3})`;
      c.fill();
      if (near > 0) {
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(cur.x, cur.y);
        c.strokeStyle = `rgba(76,154,255,${near * 0.28 + pulse * near * 0.5})`;
        c.lineWidth = 1;
        c.stroke();
        if (pulse > 0) {
          const sx = cur.x + (p.x - cur.x) * ease;
          const sy = cur.y + (p.y - cur.y) * ease;
          c.beginPath();
          c.arc(sx, sy, 2 + pulse * 2.5, 0, Math.PI * 2);
          c.fillStyle = `rgba(200,225,255,${Math.min(1, pulse * (0.6 + near))})`;
          c.fill();
        }
      }
    }

    const launcher = demoLauncher();
    drawHalfBar(c, W, !launcher);
    if (launcher) drawLauncher(c, W, H, launcher);
    if (everPointed) drawCursor(c, pointerAt.x, pointerAt.y);

    demoRAF = requestAnimationFrame(draw);
  };
  demoRAF = requestAnimationFrame(draw);
}

function surfaceEl(): HTMLElement | null {
  return useWebsocket.value ? canvas.value : img.value;
}

watch([canvas, img, useWebsocket], () => emit("surface", surfaceEl()));

/** How long to leave a WebSocket that produced nothing before trying again. */
const WS_RETRY_MS = 5000;
let wsRetry: number | null = null;

function startStream() {
  if (wsRetry !== null) {
    clearTimeout(wsRetry);
    wsRetry = null;
  }
  stream?.stop();
  /* Whatever the last attempt could not play, this one has not failed yet. */
  codecError.value = null;
  const handlers: Handlers = {
    onFrame({ image, width, height }) {
      const el = canvas.value;
      if (!el) {
        image.close();
        return;
      }
      if (el.width !== width || el.height !== height) {
        el.width = width;
        el.height = height;
        ctx = el.getContext("2d");
      }
      ctx ??= el.getContext("2d");
      ctx?.drawImage(image, 0, 0);
      image.close();
      loaded.value = true;
      failed.value = false;
      codecError.value = null;
    },
    onUnavailable(reason) {
      /*
       * There is only something to fall back TO while the device is producing
       * JPEG. The multipart stream carries images and nothing else, so falling
       * back to it against an H.264 device buys a guaranteed 409 - and then a
       * loop, because the 409 sets `failed`, and the watcher below reads a
       * non-MJPEG codec and sends us straight back to the WebSocket.
       *
       * That loop is what "Stream interrupted / Reconnecting..." forever
       * actually is, and the device log shows it plainly: pairs of 409s spaced
       * exactly FIRST_FRAME_TIMEOUT_MS apart, for as long as the tab is open.
       * With no transport left, say so once instead of churning.
       */
      if (props.status && props.status.codec !== "mjpeg") {
        codecError.value = reason;
        loaded.value = false;
        /* Still worth another go - the channel may have lost a race for a
           socket rather than being broken - but at a rate that reads as
           patience rather than the 2.5 s churn above. */
        if (wsRetry !== null) clearTimeout(wsRetry);
        wsRetry = window.setTimeout(startStream, WS_RETRY_MS);
        return;
      }
      /* Fall back once and stay there: flapping between transports would make
         the picture blink for as long as the channel is unhappy. */
      if (useWebsocket.value) {
        useWebsocket.value = false;
        loaded.value = false;
        streamUrl.value = `/stream?t=${Date.now()}`;
      }
    },
    onCodecError(reason) {
      /* No transport to fall back to: the multipart stream carries images
         only, and the device is producing H.264. Say what has to change. */
      codecError.value = reason;
      loaded.value = false;
    },
  };
  if (wantRtc()) {
    stream = new RtcStream({
      ...handlers,
      audio: Boolean(props.audio),
      onFallback(reason, worked) {
        console.warn(`WebRTC video: ${reason}; ${worked ? "starting again" : "using the WebSocket"}`);
        if (!worked) rtcFailed = true;
        startStream();
      },
    });
  } else {
    stream = new VideoStream(handlers);
  }
  applySound();
}

/*
 * The sound comes with the picture when that is over WebRTC, and over a
 * socket of its own otherwise - MJPEG, the WebSocket, or text mode with no
 * picture at all. Quiet while a recording plays.
 */
function applySound() {
  const want =
    !DEMO &&
    Boolean(props.sound) &&
    Boolean(props.audio) &&
    (!props.paused || Boolean(props.textView)) &&
    playersOpen.value === 0;
  const rtc = stream instanceof RtcStream ? stream : null;
  rtc?.setSound(want);
  const overSocket = want && !rtc && wsSoundSupported();
  if (overSocket && !wsSound) {
    wsSound = new WsSound();
  } else if (!overSocket && wsSound) {
    wsSound.stop();
    wsSound = null;
  }
}

watch(() => [props.sound, props.audio, props.textView, playersOpen.value] as const, applySound);

watch(
  () => props.paused,
  (isPaused) => {
    if (DEMO) return;
    if (isPaused) {
      loaded.value = false;
      stream?.stop();
      stream = null;
      if (img.value) img.value.removeAttribute("src");
    } else if (useWebsocket.value) {
      startStream();
    } else {
      streamUrl.value = `/stream?t=${Date.now()}`;
    }
    applySound();
  },
);

watch(useWebsocket, (on) => {
  if (on) startStream();
  else {
    stream?.stop();
    stream = null;
    applySound();
  }
});

/* Re-request the multipart stream after a failure rather than leaving a dead
   element: the device rebuilds its encoder on a resolution change. */
let retryDelay = 1500;
watch(failed, (isFailed) => {
  if (!isFailed) {
    retryDelay = 1500;
    return;
  }
  if (useWebsocket.value) return;
  /*
   * Except when the device is not KNOWN to be producing MJPEG, which is not the
   * same as knowing it produces H.264. The multipart endpoint carries images
   * only; anything else - H.264, or a codec we have not learned yet because the
   * status has not loaded - means the WebSocket is the only transport that can
   * work, and retrying /stream is a loop with a known answer (the device
   * replies 409 and says so).
   *
   * The difference is not academic. The channel is refused before sign-in, so a
   * page that opens on the login screen falls back to the multipart stream, and
   * with the status not yet loaded the old test could not undo it: the picture
   * then never appeared until the page happened to be reloaded in the right
   * order. Which is exactly how it was reported.
   */
  if (props.status?.codec !== "mjpeg") {
    useWebsocket.value = true;
    failed.value = false;
    return;
  }
  /* Backs off, because the failure may be permanent from this page's point of
     view - a device that signed us out answers 401 to every attempt, and a
     tab left retrying twice a second for a few hours grinds to a halt. */
  setTimeout(() => {
    failed.value = false;
    streamUrl.value = `/stream?t=${Date.now()}`;
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
});

/*
 * The device changed codec: take the transport that can carry the new one.
 *
 * Only the WebSocket carries H.264, so a switch to it while the picture is
 * coming over the multipart stream has to move. Waiting for the <img> to fail
 * does not work, and that is the bug this fixes: the device ENDS the multipart
 * response cleanly when the codec stops being MJPEG, and a cleanly ended
 * multipart response fires no error - the element simply keeps showing its last
 * frame. So `failed` stayed false, nothing reconnected, and the picture froze
 * on the frame that happened to be up when the operator pressed H.264.
 *
 * Watching what the device reports rather than what this page asked for also
 * covers a switch made somewhere else - another tab, the settings page.
 *
 * Level-triggered, and that matters: watching the codec alone fires only when
 * it CHANGES, so it misses the ordinary case where the device was already on
 * H.264 before this page could read its status - and it is spent if that one
 * edge lands while text mode holds `paused`. Reading the pause too means it is
 * re-checked when text mode lets go, which is exactly the "text -> H.264" step
 * that showed the fault.
 */
watch(
  () => [props.status?.codec, props.paused, props.webrtc] as const,
  ([codec], old) => {
    if (DEMO || props.paused || !codec) return;
    if (codec !== "mjpeg" && !useWebsocket.value) {
      failed.value = false;
      loaded.value = false;
      useWebsocket.value = true;
      return;
    }
    /* A new codec gives WebRTC another chance. */
    if (old && old[0] && codec !== old[0]) rtcFailed = false;
    /* WebRTC carries H.264 only, and the device may allow it or not: move to
       whichever transport fits now. */
    if (useWebsocket.value && stream && stream instanceof RtcStream !== wantRtc()) startStream();
  },
  { immediate: true },
);

if (DEMO) onMounted(startDemoScreen);
else if (!props.paused) startStream();
onUnmounted(() => {
  stream?.stop();
  wsSound?.stop();
  if (wsRetry !== null) clearTimeout(wsRetry);
  if (demoRAF) cancelAnimationFrame(demoRAF);
  demoCleanup?.();
});

/*
 * The selectable text layer.
 *
 * A text-mode screen is a grid, and the characters we read came out of that
 * grid, so the layer only has to be put back where they were: transparent text
 * over the picture, one row per row, each character over the cell it was read
 * from. The browser then does selection and copying for us - the same thing a
 * PDF viewer does over a scanned page.
 *
 * Two things have to line up. The rectangle the video occupies inside the
 * element, because "fit" letterboxes it - the same calculation the pointer
 * mapping makes, for the same reason. And the character advance: a monospace
 * font at a given size has an advance of its own choosing, which will not be
 * the cell width, so it is measured once and the difference is handed to
 * letter-spacing. Without that the row drifts right and the last characters sit
 * a cell or two from where they were read.
 */
const LAYER_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const box = ref({ left: 0, top: 0, width: 0, height: 0 });

function measureAdvance(fontPx: number): number {
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return fontPx * 0.6;
  c.font = `${fontPx}px ${LAYER_FONT}`;
  return c.measureText("0").width || fontPx * 0.6;
}

function updateBox() {
  const el = (useWebsocket.value ? canvas.value : img.value) as HTMLElement | null;
  if (!el) return;
  const host = el.parentElement?.getBoundingClientRect();
  const p = pictureRect(el, props.fit);
  if (!host || !p) return;
  /* Measured on screen, where the zoom scales both; the layer is placed before it. */
  const z = props.zoom?.z ?? 1;
  box.value = {
    left: (p.rect.left - host.left + p.padX) / z,
    top: (p.rect.top - host.top + p.padY) / z,
    width: p.width / z,
    height: p.height / z,
  };
}

const zoomed = computed(() => (props.zoom?.z ?? 1) > 1);
const zoomStyle = computed(() => {
  const zm = props.zoom;
  return zm && zm.z > 1 ? { transform: `translate(${zm.x}px, ${zm.y}px) scale(${zm.z})` } : {};
});

let boxObserver: ResizeObserver | null = null;
onMounted(() => {
  updateBox();
  boxObserver = new ResizeObserver(updateBox);
  const stage = canvas.value?.parentElement;
  if (stage) boxObserver.observe(stage);
});
onUnmounted(() => boxObserver?.disconnect());
watch(() => props.textLayer, updateBox);
watch(() => props.fit, updateBox);
/* A resolution change moves the letterbox without resizing anything the
   observer can see: the canvas keeps its CSS box and swaps its intrinsic size.
   The status poll is what notices. */
watch(() => [props.status?.width, props.status?.height], updateBox);

/*
 * Give the canvas the target's size before the first frame arrives.
 *
 * An empty <canvas> is 300x150 - the HTML default - and `.screen-fit` sizes the
 * picture with `object-fit: scale-down`, which never enlarges. So a canvas that
 * has not been drawn into yet shows as a ~300px black rectangle in the middle of
 * a full-size stage: the "why is the screen so small after logging in" that a
 * page refresh appeared to cure, because a reload got a frame in before anyone
 * looked. Sizing the backing store from the status the device already reports
 * makes the empty state a properly letterboxed black screen instead.
 *
 * Only while nothing has been drawn: assigning width or height clears a canvas,
 * and doing that to a live picture would blink it on every status poll.
 */
function sizeCanvasBeforeFirstFrame() {
  const el = canvas.value;
  if (!el || loaded.value) return;
  const w = props.status?.width || 1920;
  const h = props.status?.height || 1080;
  if (el.width === w && el.height === h) return;
  el.width = w;
  el.height = h;
  ctx = el.getContext("2d");
}

watch([canvas, () => props.status?.width, () => props.status?.height], sizeCanvasBeforeFirstFrame, {
  immediate: true,
});

const layerRows = computed(() => {
  const t = props.textLayer;
  if (!t) return [];
  return textSpans(t.text, t.rows, t.highlight);
});

const layerStyle = computed(() => {
  const t = props.textLayer;
  if (!t || box.value.width <= 0) return {};
  /*
   * The grid is not always the whole frame: a UEFI console centres 40 rows of
   * 19 in a 768-tall picture and leaves 4 pixels above and below. So scale the
   * frame the reading came from onto the video rectangle, and place the grid
   * inside it at the origin it was read at.
   */
  const scaleX = t.width > 0 ? box.value.width / t.width : box.value.width / (t.cols * t.cellWidth);
  const scaleY =
    t.height > 0 ? box.value.height / t.height : box.value.height / (t.rows * t.cellHeight);
  const cellW = t.cellWidth * scaleX;
  const cellH = t.cellHeight * scaleY;
  /* Size by the cell height, then pull the advance onto the cell width. */
  const fontPx = cellH * 0.82;
  return {
    left: `${box.value.left + t.originX * scaleX}px`,
    top: `${box.value.top + t.originY * scaleY}px`,
    width: `${t.cols * cellW}px`,
    height: `${t.rows * cellH}px`,
    font: `${fontPx}px/${cellH}px ${LAYER_FONT}`,
    letterSpacing: `${cellW - measureAdvance(fontPx)}px`,
  };
});

const noSignal = computed(() => props.status !== null && !props.status.signal);
const tooFast = computed(() => !!props.status?.signal && props.status.tooFast === true);

/*
 * Why there is no picture, as far as the bridge can tell.
 *
 * DDC5V is bit 0 of the capture chip's SYS_STATUS: the source's own +5 V on the
 * HDMI input. It separates the two silences that look identical from here - a
 * target that is off or unplugged, against one that is powered and simply not
 * sending. Saying "it may be powered off, asleep, or unplugged" to somebody
 * whose machine is plainly running sends them to check the wrong things.
 */
const DDC5V = 0x01;
/* Older firmware has no knowsDdc5v and every bridge it ran on could tell. */
const powerKnown = computed(() => props.status?.knowsDdc5v !== false);
const noSignalNote = computed(() => {
  const st = props.status;
  if (!st) return "";
  if (!powerKnown.value) {
    return (
      "This capture chip cannot tell a machine that is off or asleep from one that has " +
      "stopped sending. If the target should be showing something, reconnect the HDMI - " +
      "to the target that looks like the monitor was unplugged and plugged back in."
    );
  }
  if ((st.sysStatus & DDC5V) === 0) {
    return "Nothing is plugged into the HDMI input, or the machine on the other end is powered off.";
  }
  return (
    "The cable is connected and the target has power, but it is not sending a picture. " +
    "Its output may be switched off, or it decided nothing was connected when it started - " +
    "the device offers it a fresh hotplug a few times when this happens."
  );
});
/*
 * "Reconnect HDMI". Where the bridge cannot see the source's +5 V the device no
 * longer resets it on its own - that woke sleeping machines - so the person
 * looking at "No signal" gets the button, and a countdown that presses it for
 * them unless they say no. Once per outage: pressed, cancelled or run out, it
 * waits for the picture to come back before offering again.
 */
const RECONNECT_AFTER_S = 30;
const reconnectLeft = ref(0);
const reconnectState = ref<"idle" | "counting" | "done" | "busy">("idle");
const reconnectError = ref("");
let reconnectTimer: ReturnType<typeof setInterval> | null = null;

function stopReconnectTimer() {
  if (reconnectTimer !== null) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

async function reconnectNow() {
  stopReconnectTimer();
  reconnectState.value = "busy";
  reconnectError.value = "";
  try {
    await reconnectSource();
  } catch (e) {
    reconnectError.value = e instanceof Error ? e.message : String(e);
  }
  reconnectState.value = "done";
}

function cancelReconnect() {
  stopReconnectTimer();
  reconnectState.value = "done";
}

watch(
  () => !DEMO && noSignal.value && !props.textView,
  (on) => {
    stopReconnectTimer();
    reconnectError.value = "";
    if (!on) {
      reconnectState.value = "idle";
      return;
    }
    if (reconnectState.value !== "idle") return;
    if (powerKnown.value) return; /* the device nudges these itself */
    reconnectLeft.value = RECONNECT_AFTER_S;
    reconnectState.value = "counting";
    reconnectTimer = setInterval(() => {
      /* A hidden tab is nobody watching: hold the count. */
      if (document.hidden) return;
      reconnectLeft.value -= 1;
      if (reconnectLeft.value <= 0) void reconnectNow();
    }, 1000);
  },
  { immediate: true },
);
onUnmounted(stopReconnectTimer);

const showOverlay = computed(
  () =>
    /* In text mode the characters are the content, and the stream is paused on
       purpose - saying "Video paused" over them would be telling the operator
       off for the thing they just asked for. */
    !props.textView &&
    (props.paused ||
    Boolean(props.videoBlocked) ||
    failed.value ||
    noSignal.value ||
    tooFast.value ||
    codecError.value !== null ||
    !loaded.value),
);

/* One class per sizing mode: shrink-only, fill the stage, or one pixel each. */
const fitClass = computed(() =>
  props.fit === "fit" ? "screen-fit" : props.fit === "stretch" ? "screen-stretch" : "screen-actual",
);
</script>

<template>
  <div :class="['screen', { 'screen-zoomed': zoomed }]">
    <!-- The picture and its text layer move and scale together. -->
    <div class="screen-zoom" :style="zoomStyle">
      <!-- In text mode the picture is not merely paused, it is gone: leaving the
           last frame under a text box would show a screen that is no longer
           there, half covered by the one that is. Hidden rather than removed,
           because the text layer is placed against this element's box - take it
           out of the layout and the characters have nothing to line up with. -->
      <canvas
        v-show="useWebsocket"
        ref="canvas"
        :class="[
          'screen-img',
          fitClass,
          { 'screen-engaged': engaged, 'screen-img-blank': textView },
        ]"
      />
      <img
        v-if="!DEMO"
        v-show="!useWebsocket"
        ref="img"
        :class="[
          'screen-img',
          fitClass,
          { 'screen-engaged': engaged, 'screen-img-blank': textView },
        ]"
        :src="imgSrc"
        alt="Target screen"
        :draggable="false"
        @load="
          loaded = true;
          codecError = null;
        "
        @error="
          loaded = false;
          failed = true;
        "
      />

      <!-- The engaged outline follows whatever the operator is actually looking
           at. On the picture it rides the canvas; in text mode the canvas is
           `visibility: hidden` (screen-img-blank), so an outline on it is hidden
           with it - which is why the blue frame that says "the keyboard is going
           to the target" simply vanished the moment text mode came up, even
           though the keyboard was still going there. -->
      <div
        v-if="textLayer"
        :class="[
          'screen-text',
          { 'screen-text-solid': textView, 'screen-engaged': engaged && textView },
        ]"
        :style="layerStyle"
        aria-label="Screen text, selectable"
      >
        <div v-for="(spans, i) in layerRows" :key="i" class="screen-text-line">
          <span
            v-for="(span, j) in spans"
            :key="j"
            :class="{ 'screen-text-mark': span.mark }"
            >{{ span.text }}</span
          >
        </div>
      </div>
    </div>

    <div v-if="!DEMO && showOverlay" class="screen-overlay">
      <div class="screen-message">
        <span class="screen-message-icon">
          <Icon
            :name="videoBlocked || noSignal || failed || codecError ? 'warning' : 'screen'"
            :size="26"
          />
        </span>
        <h2 v-if="videoBlocked">Video is not available</h2>
        <h2 v-else-if="paused">{{ pauseNote ? "Video paused for the update" : "Video paused" }}</h2>
        <h2 v-else-if="noSignal">No signal</h2>
        <h2 v-else-if="tooFast">The input mode is too fast</h2>
        <h2 v-else-if="codecError">Cannot play this stream</h2>
        <h2 v-else-if="failed">Stream interrupted</h2>
        <h2 v-else>Waiting for the first frame...</h2>
        <!-- The device's own sentence: it knows why, and inventing a second
             wording here would only disagree with Settings. -->
        <p v-if="videoBlocked" class="muted">{{ videoBlocked }}</p>
        <p v-else-if="paused" class="muted">
          {{
            pauseNote ||
            "The stream is disconnected and the device has stopped encoding. Input still works."
          }}
        </p>
        <p v-else-if="noSignal" class="muted">{{ noSignalNote }}</p>
        <div v-if="!videoBlocked && !paused && noSignal" class="screen-reconnect">
          <!-- A screen that went dark after idling sends no signal at all; one
               nudge of the mouse wakes it, the way a hand on the desk would. -->
          <button
            type="button"
            class="btn btn-sm"
            title="Moves the target's mouse one pixel and back, which wakes a screen that went dark"
            @click="emit('wake')"
          >
            Wake the target
          </button>
          <template v-if="reconnectState === 'counting'">
            <p class="muted">Reconnecting the HDMI in {{ reconnectLeft }} s.</p>
            <button type="button" class="btn btn-sm" @click="reconnectNow">Reconnect now</button>
            <button type="button" class="btn btn-sm btn-quiet" @click="cancelReconnect">Don't</button>
          </template>
          <button
            v-else
            type="button"
            class="btn btn-sm"
            :disabled="reconnectState === 'busy'"
            @click="reconnectNow"
          >
            {{ reconnectState === "busy" ? "Reconnecting..." : "Reconnect HDMI" }}
          </button>
          <p v-if="reconnectError" class="muted">{{ reconnectError }}</p>
          <button v-if="serial" type="button" class="btn btn-sm btn-quiet" @click="emit('open-serial')">
            Open the serial console
          </button>
        </div>
        <p v-else-if="tooFast" class="muted">
          The target sends {{ status?.width }}x{{ status?.height }} at {{ status?.inputHz }} Hz, more
          than the capture link carries, so no frames arrive. Set it to 30 Hz or a smaller mode, or
          pick the 1080p30 or 720p EDID profile in Settings > Video.
        </p>
        <p v-else-if="codecError" class="muted">
          {{ codecError }}. Picking MJPEG in the video readout gives a picture this page can
          always show.
        </p>
        <p v-else-if="failed" class="muted">Reconnecting...</p>
      </div>
    </div>
  </div>
</template>
