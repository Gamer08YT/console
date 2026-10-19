<script setup lang="ts">
/*
 * Icons are inline SVG paths, not a font or a sprite fetched at runtime: the
 * device serves one embedded file and cannot reach a CDN. Every shape is a
 * path so the template stays a single loop.
 *
 * They are drawn to the Feather / Lucide conventions - 24x24 box, 2px stroke,
 * round caps and joins - which is also why several of them came out close to
 * those sets. Both are permissively licensed; the attribution is in NOTICE.
 */
const PATHS = {
  screen: [
    "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M8 21h8M12 17v4",
  ],
  keyboard: [
    "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
    "M6 11h.01M10 11h.01M14 11h.01M18 11h.01M8 15h8",
  ],
  disc: [
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  ],
  power: ["M12 3v9", "M18.4 6.6a9 9 0 1 1-12.8 0"],
  /* A terminal: a window with a prompt and a cursor. */
  terminal: [
    "M3.5 4.5h17a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18V6a1.5 1.5 0 0 1 1.5-1.5z",
    "M6 9l3 3-3 3",
    "M12 15h5",
  ],
  /* A page of log lines. */
  logs: ["M5 4.5h14v15H5z", "M8 8.5h8M8 12h8M8 15.5h5"],
  /* Three dots in a row: more of something. */
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  /* A game controller: the body, a cross on the left, two buttons on the right. */
  gamepad: [
    "M7 7h10a5 5 0 0 1 4.9 6l-.8 4a2.5 2.5 0 0 1-4.3 1.2L14.5 16h-5l-2.3 2.2a2.5 2.5 0 0 1-4.3-1.2l-.8-4A5 5 0 0 1 7 7z",
    "M8 10v4M6 12h4",
    "M15.5 11h.01M17.5 13h.01",
  ],
  remote: [
    "M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M12 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    "M10 14h.01M14 14h.01M10 17h.01M14 17h.01",
  ],
  settings: [
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
  fullscreen: [
    "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
  ],
  close: ["M6 6l12 12M18 6L6 18"],
  /* A speaker with sound waves, and the same speaker crossed out. */
  volume: ["M11 5 6 9H2v6h4l5 4V5z", "M15.5 8.5a5 5 0 0 1 0 7", "M19 5a10 10 0 0 1 0 14"],
  "volume-off": ["M11 5 6 9H2v6h4l5 4V5z", "M22 9l-6 6M16 9l6 6"],
  /* The target's media keys: the same speaker with a minus and a plus, the
     player's skip and play/pause, and a dim sun for brightness down. */
  "volume-down": ["M11 5 6 9H2v6h4l5 4V5z", "M16 12h6"],
  "volume-up": ["M11 5 6 9H2v6h4l5 4V5z", "M16 12h6M19 9v6"],
  "skip-back": ["M19 20 9 12l10-8v16z", "M5 19V5"],
  "play-pause": ["M3 6l8 6-8 6z", "M15 6v12M20 6v12"],
  "skip-forward": ["M5 4l10 8-10 8V4z", "M19 5v14"],
  /* The keyboard of function and media keys: an F and a play triangle. */
  "fn-keys": ["M3 5v14M3 5h7M3 12h5", "M14 8l7 4-7 4z"],
  "sun-dim": [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    "M12 4h.01M12 20h.01M4 12h.01M20 12h.01M6.3 6.3h.01M17.7 17.7h.01M6.3 17.7h.01M17.7 6.3h.01",
  ],
  /* A door frame with an arrow leaving it. */
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  /* A drawing pin seen from the side: head, shaft, point. */
  pin: ["M9 4h6M10 4v6l-3 3v2h10v-2l-3-3V4", "M12 15v5"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5M12 8h.01"],
  warning: [
    "M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
    "M12 9v4M12 17h.01",
  ],
  sun: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  ],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
  hdmi: [
    "M5 7h14a1.5 1.5 0 0 1 1.5 1.5v3.5l-2.5 3H6l-2.5-3V8.5A1.5 1.5 0 0 1 5 7z",
    "M8 11.8h8",
  ],
  usb: [
    "M6.5 8h11v9.5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z",
    "M9 2h6v6H9z",
    "M10 3.8h1.7v2.4h-1.7z",
    "M12.3 3.8h1.7v2.4h-1.7z",
  ],
  sd: [
    "M7 3h8l2 2v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-5h1v-2H6V4a1 1 0 0 1 1-1z",
    "M8.4 4.5v2M10.6 4.5v2M12.8 4.5v2M15 4.5v2",
  ],
  ethernet: [
    "M3.5 4.5h17a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18V6a1.5 1.5 0 0 1 1.5-1.5z",
    "M6 7.5h12v6h-2v2h-3v2h-2v-2H8v-2H6z",
    "M8 9.5v2.5M10.7 9.5v2.5M13.3 9.5v2.5M16 9.5v2.5",
  ],
  /* WiFi station: the signal fan opening upward, with the device as a dot. */
  wifi: [
    "M2.5 9.5a13 13 0 0 1 19 0",
    "M6 13a8 8 0 0 1 12 0",
    "M9.5 16.5a3.5 3.5 0 0 1 5 0",
    "M12 19.6h.01",
  ],
  /* Access point: broadcasting from a centre dot, waves to both sides. */
  ap: [
    "M12 12.5h.01",
    "M9.3 15.2a4 4 0 0 1 0-5.4M14.7 9.8a4 4 0 0 1 0 5.4",
    "M6.8 17.6a8 8 0 0 1 0-11.2M17.2 6.4a8 8 0 0 1 0 11.2",
  ],
  /* Shield with a check: the Tailscale / VPN membership. */
  vpn: [
    "M12 3l7 3v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z",
    "M9 12l2 2 4-4",
  ],
  /* Broadcast/telemetry: a centre dot with two pairs of concentric arcs. */
  mqtt: [
    "M4.9 16.1a7 7 0 0 1 0-8.2",
    "M8.4 13.6a3 3 0 0 1 0-3.2",
    "M19.1 7.9a7 7 0 0 1 0 8.2",
    "M15.6 10.4a3 3 0 0 1 0 3.2",
    "M12 12h.01",
  ],
  /* Media transport for the stream Pause/Resume control. */
  pause: ["M9 4v16", "M15 4v16"],
  play: ["M7 4l13 8-13 8z"],
  /* Recording and screenshots. */
  camera: ["M4 8h3l2-3h6l2 3h3v11H4z", "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  record: ["M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z"],
  stop: ["M7 7h10v10H7z"],
  film: ["M4 5h16v14H4z", "M8 5v14M16 5v14", "M4 9h4M4 15h4M16 9h4M16 15h4"],
  /* Recordings panel: a camcorder for a video, a picture for a screenshot. */
  video: ["M3 7h12v10H3z", "M15 10.5l6-3.5v10l-6-3.5"],
  image: ["M3 5h18v14H3z", "M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5-11 9"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  /* A chevron pointing down: pull something out from the top. */
  "chevron-down": ["M6 9l6 6 6-6"],
  trash: ["M4 7h16", "M10 11v6M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  captions: ["M3 5h18v14H3z", "M7 15h4M13 15h4M7 11h2M11 11h6"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  /* The on-screen keyboard's own controls: dock it under the picture, let it
     float, or drop to the few rows a browser tends to swallow. */
  dock: ["M3 4h18v16H3z", "M3 14h18"],
  float: ["M7 8h14v11H7z", "M3 5h14v3", "M3 5v11h4"],
  compact: ["M3 6h18", "M3 12h18", "M7 18h10"],
  /* Show or hide a password. */
  eye: ["M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  "eye-off": [
    "M4 4l16 16",
    "M9.9 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.7",
    "M6.3 7.6A16.6 16.6 0 0 0 2 11s3.6 6 10 6a9.8 9.8 0 0 0 3.7-.7",
    "M9.9 9.9a3 3 0 0 0 4.2 4.2",
  ],
  /* The symbols layout: what is printed above the numbers. */
  symbols: ["M6 4L4 20", "M14 4l-2 16", "M3 9h16", "M2 15h16", "M20 15h2"],
  /* Two keys pressed at once: the ready-made combinations. */
  combo: [
    "M4 5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M10 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z",
  ],
  /* Put a setting back to the value it shipped with. */
  undo: ["M3 8h11a5 5 0 0 1 0 10h-6", "M7 4L3 8l4 4"],
  palette: [
    "M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z",
    "M7.5 11.5h.01M10 8h.01M14 8h.01M16.5 11h.01",
  ],
  /* Mouse cursor: the "who has control" indicator. */
  pointer: ["M4 3l7.1 17 2.5-7.4 7.4-2.5z"],
  /* text selection: an I-beam; copy: two sheets */
  "text-select": ["M9 4h6M9 20h6M12 4v16", "M4 9v6M20 9v6"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  /* the picture's scale: shrunk to fit, stretched to fill, one pixel to one */
  "fit-shrink": [
    "M15 15l6 6M15 15v4.8M15 15h4.8M9 15v4.8M9 15H4.2M9 15l-6 6",
    "M15 9l6-6M15 9V4.2M15 9h4.8M9 9V4.2M9 9H4.2M9 9L3 3",
  ],
  "fit-stretch": [
    "M15 15l6 6M9 15l-6 6M15 9l6-6M9 9L3 3",
    "M21 16.2V21h-4.8M3 16.2V21h4.8M21 7.8V3h-4.8M3 7.8V3h4.8",
  ],
  "fit-actual": [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    "M8 10l1-1v6M15 10l1-1v6M12 10.5v.01M12 13.5v.01",
  ],
  /* a finger on a pad: the screen used as a trackpad */
  touch: [
    "M22 14a8 8 0 0 1-8 8",
    "M18 11v-1a2 2 0 0 0-4 0",
    "M14 10V9a2 2 0 0 0-4 0v1",
    "M10 9.5V4a2 2 0 0 0-4 0v10",
    "M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
  ],
} as const;

defineProps<{ name: keyof typeof PATHS; size?: number }>();
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in PATHS[name]" :key="i" :d="d" />
  </svg>
</template>
