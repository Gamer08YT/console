<script setup lang="ts">
/*
 * Plays a recording from the card over the page. An MP4 (dashcam clips,
 * timelapses) goes to the browser's own <video>, which seeks with HTTP ranges;
 * a .ts goes through TsPlayer. Both stream: nothing is downloaded first.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { captureUrl, type CaptureFile } from "../state/device";
import Icon from "./Icon.vue";
import { cueAt, parseSrt, toVtt, type Cue } from "../video/srt";
import { playersOpen } from "../video/sound";
import { TsPlayer } from "../video/tsPlayer";

const props = defineProps<{ file: CaptureFile; start?: number }>();
const emit = defineEmits<{ close: [] }>();

const mp4 = computed(() => props.file.path.endsWith(".mp4"));
const url = computed(() => captureUrl(props.file.path));
const name = computed(() => props.file.path.slice(props.file.path.lastIndexOf("/") + 1));

const canvas = ref<HTMLCanvasElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const time = ref(0);
const duration = ref(0);
const playing = ref(false);
const waiting = ref(true);
const error = ref("");
/* While the slider is held, it shows where it is, not where the video is. */
const dragging = ref<number | null>(null);
const cues = ref<Cue[]>([]);
/* Keystroke subtitles: drawn over the picture for a .ts, a track of the
   browser's player (its CC button) for an MP4. */
const showSubs = ref(true);
const subtitle = computed(() => (showSubs.value && !mp4.value ? cueAt(cues.value, time.value) : ""));
const vttUrl = ref("");

let player: TsPlayer | null = null;

function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

onMounted(async () => {
  playersOpen.value++;
  if (props.file.subtitles) {
    try {
      const res = await fetch(captureUrl(props.file.subtitles), { cache: "no-store" });
      if (res.ok) cues.value = parseSrt(await res.text());
      if (cues.value.length) {
        vttUrl.value = URL.createObjectURL(new Blob([toVtt(cues.value)], { type: "text/vtt" }));
      }
    } catch {
      /* the video plays without them */
    }
  }
  if (mp4.value || !canvas.value) return;
  video.value?.addEventListener("loadedmetadata", () => {
    if (props.start && video.value) video.value.currentTime = props.start;
  });
  player = new TsPlayer(url.value, props.file.size, canvas.value, {
    onTime: (s) => (time.value = s),
    onDuration: (s) => (duration.value = s),
    onPlaying: (p) => (playing.value = p),
    onWaiting: (w) => (waiting.value = w),
    onEnded: () => (playing.value = false),
    onError: (m) => (error.value = m),
  });
  await player.open();
  if (props.start) player.seek(props.start);
});

onBeforeUnmount(() => {
  playersOpen.value--;
  player?.close();
  if (vttUrl.value) URL.revokeObjectURL(vttUrl.value);
});

function toggle() {
  if (!player) return;
  if (player.paused) player.play();
  else player.pause();
}

function onSlide(e: Event) {
  dragging.value = Number((e.target as HTMLInputElement).value);
}

function onSeek(e: Event) {
  const to = Number((e.target as HTMLInputElement).value);
  dragging.value = null;
  time.value = to;
  player?.seek(to);
}

/* The <video> reports its own time; subtitles follow it too. */
function onVideoTime(e: Event) {
  time.value = (e.target as HTMLVideoElement).currentTime;
}
</script>

<template>
  <Teleport to="body">
    <div class="player-veil" role="dialog" aria-modal="true" :aria-label="name" @click.self="emit('close')">
      <div class="player">
        <div class="player-head">
          <span class="mono player-name">{{ name }}</span>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            aria-label="Close"
            title="Close"
            @click="emit('close')"
          >
            <Icon name="close" :size="15" />
          </button>
        </div>
        <div class="player-screen">
          <video v-if="mp4" ref="video" :src="url" controls autoplay playsinline @timeupdate="onVideoTime">
            <track v-if="vttUrl" kind="subtitles" srclang="en" label="Keys pressed" :src="vttUrl" default />
          </video>
          <template v-else>
            <canvas ref="canvas" @click="toggle" />
            <span v-if="waiting && !error" class="player-wait muted">Loading…</span>
          </template>
          <span v-if="subtitle" class="player-sub">{{ subtitle }}</span>
        </div>
        <p v-if="error" class="setting-note setting-note-blocked">{{ error }}</p>
        <div v-if="!mp4" class="player-bar">
          <button
            type="button"
            class="btn btn-sm btn-icon"
            :aria-label="playing ? 'Pause' : 'Play'"
            :title="playing ? 'Pause' : 'Play'"
            :disabled="!!error"
            @click="toggle"
          >
            <Icon :name="playing ? 'pause' : 'play'" :size="15" />
          </button>
          <input
            type="range"
            class="player-seek"
            min="0"
            :max="duration || 0"
            step="0.1"
            :value="dragging ?? time"
            :disabled="!duration || !!error"
            aria-label="Position"
            @input="onSlide"
            @change="onSeek"
          />
          <button
            v-if="cues.length"
            type="button"
            :class="['btn', 'btn-sm', 'btn-icon', { 'btn-on': showSubs }]"
            :aria-pressed="showSubs"
            aria-label="Subtitles"
            title="Show what was pressed during the recording"
            @click="showSubs = !showSubs"
          >
            <Icon name="captions" :size="15" />
          </button>
          <span class="mono muted player-time">
            {{ clock(dragging ?? time) }} / {{ clock(duration) }}
          </span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
