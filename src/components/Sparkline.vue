<script setup lang="ts">
/*
 * One figure over the last minute: a thin line from zero, the value now in the
 * corner, and the reading under the finger or the pointer. One figure each -
 * frames and bitrate have nothing in common to share an axis with.
 */
import { computed, ref } from "vue";

import { HISTORY_MS, type VideoSample } from "../state/videoHistory";

const props = defineProps<{
  samples: VideoSample[];
  label: string;
  value: (s: VideoSample) => number;
  format: (v: number) => string;
  /** The axis never goes lower than this, so a quiet line stays low. */
  floor: number;
}>();

const W = 268;
const H = 44;
const PAD = 3;

const now = computed(() => props.samples.at(-1)?.t ?? 0);
const top = computed(() => Math.max(props.floor, ...props.samples.map(props.value)) * 1.1);

function x(t: number) {
  return W - ((now.value - t) / HISTORY_MS) * W;
}
function y(v: number) {
  return H - PAD - (v / top.value) * (H - 2 * PAD);
}

/* Broken where a sample is missing (more than 2.5 s apart): a gap, not a slope. */
const paths = computed(() => {
  const runs: VideoSample[][] = [];
  for (const s of props.samples) {
    const run = runs.at(-1);
    const prev = run?.at(-1);
    if (run && prev && s.t - prev.t <= 2500) run.push(s);
    else runs.push([s]);
  }
  return runs.map((run) => {
    const line = run.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)} ${y(props.value(s)).toFixed(1)}`).join("");
    const area = run.length > 1 ? `${line}L${x(run.at(-1)!.t).toFixed(1)} ${H}L${x(run[0].t).toFixed(1)} ${H}Z` : "";
    return { line, area };
  });
});

const hover = ref<VideoSample | null>(null);
const shown = computed(() => hover.value ?? props.samples.at(-1) ?? null);
const maxText = computed(() =>
  props.samples.length ? props.format(Math.max(...props.samples.map(props.value))) : "",
);

function onMove(e: PointerEvent) {
  const r = (e.currentTarget as SVGElement).getBoundingClientRect();
  const t = now.value - (1 - (e.clientX - r.left) / r.width) * HISTORY_MS;
  let best: VideoSample | null = null;
  for (const s of props.samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  hover.value = best;
}
</script>

<template>
  <figure class="spark">
    <figcaption class="spark-head">
      <span class="spark-label">{{ label }}</span>
      <span class="spark-now mono">
        <template v-if="shown">
          {{ format(value(shown)) }}
          <small v-if="hover">{{ Math.round((now - hover.t) / 1000) }} s ago</small>
        </template>
      </span>
    </figcaption>
    <svg
      class="spark-plot"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      :aria-label="`${label} over the last minute, up to ${maxText}`"
      @pointermove="onMove"
      @pointerdown="onMove"
      @pointerleave="hover = null"
    >
      <line class="spark-base" x1="0" :y1="H - 0.5" :x2="W" :y2="H - 0.5" />
      <template v-for="(p, i) in paths" :key="i">
        <path v-if="p.area" class="spark-area" :d="p.area" />
        <path class="spark-line" :d="p.line" />
      </template>
      <template v-if="hover">
        <line class="spark-cross" :x1="x(hover.t)" y1="0" :x2="x(hover.t)" :y2="H" />
        <circle class="spark-dot" :cx="x(hover.t)" :cy="y(value(hover))" r="4" />
      </template>
    </svg>
    <div class="spark-foot mono">
      <span>1 min</span>
      <span v-if="maxText">max {{ maxText }}</span>
    </div>
  </figure>
</template>

<style scoped>
.spark {
  margin: 0;
}

.spark-head,
.spark-foot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-2);
}

.spark-label {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.spark-now {
  color: var(--text);
  font-size: var(--text-sm);
}

.spark-now small {
  margin-left: 4px;
  color: var(--text-faint);
}

.spark-foot {
  color: var(--text-faint);
  font-size: var(--text-xs);
}

.spark-plot {
  display: block;
  width: 100%;
  height: auto;
  margin: 2px 0;
  touch-action: none;
  cursor: crosshair;
}

.spark-base {
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.spark-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.spark-area {
  fill: var(--accent);
  opacity: 0.12;
}

.spark-cross {
  stroke: var(--text-faint);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.spark-dot {
  fill: var(--accent);
  stroke: var(--bg-overlay, var(--bg-raised));
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
</style>
