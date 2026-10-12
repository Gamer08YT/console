<script setup lang="ts">
/*
 * Several screens on the target: a small drawing of the whole desktop and
 * where the captured screen sits in it, from the four saved numbers. Shows at
 * a glance whether "Find this screen" got it right. The other monitors' own
 * shapes are not known, only the desktop around them.
 */
import { computed } from "vue";

const props = defineProps<{
  deskW: number;
  deskH: number;
  x: number;
  y: number;
  /** The captured screen's size (the picture's). */
  w: number;
  h: number;
}>();

const VIEW_W = 280;
const PAD = 6;
/* What has to fit in the drawing: the desktop, and the screen even where a
   wrong result puts it outside. */
const bounds = computed(() => {
  const x0 = Math.min(0, props.x);
  const y0 = Math.min(0, props.y);
  const x1 = Math.max(props.deskW, props.x + props.w);
  const y1 = Math.max(props.deskH, props.y + props.h);
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
});
/* As tall as that shape asks, within reason */
const viewH = computed(() =>
  Math.round(Math.min(150, Math.max(60, (bounds.value.h / bounds.value.w) * (VIEW_W - 2 * PAD) + 2 * PAD))),
);

const fit = computed(() => {
  const b = bounds.value;
  const vh = viewH.value;
  const s = Math.min((VIEW_W - 2 * PAD) / b.w, (vh - 2 * PAD) / b.h);
  const ox = (VIEW_W - b.w * s) / 2 - b.x0 * s;
  const oy = (vh - b.h * s) / 2 - b.y0 * s;
  return {
    desk: { x: ox, y: oy, w: props.deskW * s, h: props.deskH * s },
    scr: { x: ox + props.x * s, y: oy + props.y * s, w: props.w * s, h: props.h * s },
  };
});

/* A screen that does not fit inside the desktop cannot be right. */
const outside = computed(
  () =>
    props.x < 0 ||
    props.y < 0 ||
    props.x + props.w > props.deskW ||
    props.y + props.h > props.deskH,
);
/* The desktop is this one screen: nothing else to point at. */
const alone = computed(() => props.deskW === props.w && props.deskH === props.h);
</script>

<template>
  <figure class="screen-layout">
    <svg
      :viewBox="`0 0 ${VIEW_W} ${viewH}`"
      :width="VIEW_W"
      :height="viewH"
      role="img"
      :aria-label="`Desktop ${deskW} by ${deskH}; this screen ${w} by ${h} at ${x}, ${y}`"
    >
      <rect
        class="desk"
        :x="fit.desk.x"
        :y="fit.desk.y"
        :width="fit.desk.w"
        :height="fit.desk.h"
      />
      <text
        v-if="!alone"
        class="label faint"
        :x="fit.desk.x + 6"
        :y="fit.desk.y + fit.desk.h - 6"
      >
        other screens
      </text>
      <rect
        class="scr"
        :class="{ bad: outside }"
        :x="fit.scr.x"
        :y="fit.scr.y"
        :width="fit.scr.w"
        :height="fit.scr.h"
      />
      <text
        class="label"
        :x="fit.scr.x + fit.scr.w / 2"
        :y="fit.scr.y + fit.scr.h / 2 + 4"
        text-anchor="middle"
      >
        this screen
      </text>
    </svg>
    <figcaption>
      Desktop {{ deskW }}&times;{{ deskH }}; this screen {{ w }}&times;{{ h }} at
      {{ x }}, {{ y }}.
      <span v-if="outside" class="warn">
        It does not fit inside the desktop: run "Find this screen" again.
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.screen-layout {
  margin: 0.5rem 0 0;
}
svg {
  display: block;
  max-width: 100%;
  height: auto;
}
.desk {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
}
.scr {
  fill: color-mix(in srgb, var(--accent) 25%, transparent);
  stroke: var(--accent);
  stroke-width: 2;
}
.scr.bad {
  fill: color-mix(in srgb, var(--danger) 25%, transparent);
  stroke: var(--danger);
}
.label {
  font-size: 11px;
  fill: var(--text);
}
.faint {
  fill: var(--text-faint);
}
figcaption {
  font-size: var(--text-sm);
  color: var(--text-faint);
  margin-top: 0.25rem;
}
.warn {
  color: var(--danger);
}
</style>
