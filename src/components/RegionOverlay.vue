<script setup lang="ts">
/*
 * Drawing a screen area: a layer over the picture that takes one drag and
 * turns it into parts of the frame. The sums go through pictureRect(), the
 * same as the pointer's, so the black bars, the zoom and a picture sat at the
 * top of a phone all come out right.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { clampRect, rectUsable, type RegionRect } from "../state/regions";
import { pictureRect, type FitMode } from "../video/picture";

const props = defineProps<{
  surface: HTMLElement | null;
  fit: FitMode;
  /** The other areas, drawn faintly so the new one is placed beside them. */
  others: RegionRect[];
}>();

const emit = defineEmits<{ done: [rect: RegionRect]; cancel: [] }>();

const layer = ref<HTMLElement | null>(null);
const start = ref<{ x: number; y: number } | null>(null);
const rect = ref<RegionRect | null>(null);

/** A point on the page as parts of the frame, held inside it. */
function toFrame(e: PointerEvent): { x: number; y: number } | null {
  if (!props.surface) return null;
  const p = pictureRect(props.surface, props.fit);
  if (!p) return null;
  const x = (e.clientX - p.rect.left - p.padX) / p.width;
  const y = (e.clientY - p.rect.top - p.padY) / p.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function down(e: PointerEvent) {
  const at = toFrame(e);
  if (!at) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  start.value = at;
  rect.value = { x: at.x, y: at.y, w: 0, h: 0 };
}

function move(e: PointerEvent) {
  if (!start.value) return;
  const at = toFrame(e);
  if (!at) return;
  rect.value = clampRect({ x: start.value.x, y: start.value.y, w: at.x - start.value.x, h: at.y - start.value.y });
}

function up() {
  const r = rect.value;
  start.value = null;
  if (r && rectUsable(r)) emit("done", r);
  else rect.value = null;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("cancel");
  }
}

/* The layer's size is known once it is on the page, and again after a resize. */
const tick = ref(0);
const bump = () => tick.value++;
onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", bump);
  bump();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", bump);
});

/* Parts of the frame back to the layer's own pixels, for drawing. */
const box = computed(() => {
  void rect.value;
  void tick.value;
  if (!props.surface || !layer.value) return null;
  const p = pictureRect(props.surface, props.fit);
  if (!p) return null;
  const l = layer.value.getBoundingClientRect();
  return { left: p.rect.left - l.left + p.padX, top: p.rect.top - l.top + p.padY, width: p.width, height: p.height };
});

function style(r: RegionRect) {
  const b = box.value;
  if (!b) return { display: "none" };
  return {
    left: `${b.left + r.x * b.width}px`,
    top: `${b.top + r.y * b.height}px`,
    width: `${r.w * b.width}px`,
    height: `${r.h * b.height}px`,
  };
}
</script>

<template>
  <div
    ref="layer"
    class="rg-layer"
    @pointerdown.prevent="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
  >
    <div v-for="(o, i) in others" :key="i" class="rg-box rg-box-other" :style="style(o)" />
    <div v-if="rect" class="rg-box" :style="style(rect)" />
    <div class="rg-hint">
      Drag over the part of the screen to watch.
      <button type="button" class="btn btn-sm" @pointerdown.stop @click="emit('cancel')">Cancel</button>
    </div>
  </div>
</template>

<style scoped>
.rg-layer {
  position: absolute;
  inset: 0;
  z-index: 20;
  cursor: crosshair;
  touch-action: none;
  background: rgb(0 0 0 / 20%);
}

.rg-box {
  position: absolute;
  border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  pointer-events: none;
}

.rg-box-other {
  border-style: dashed;
  border-color: var(--text-faint);
  background: none;
}

.rg-hint {
  position: absolute;
  top: var(--space-2);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: 999px;
  background: var(--bg-overlay);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: var(--text-sm);
  white-space: nowrap;
  cursor: default;
}
</style>
