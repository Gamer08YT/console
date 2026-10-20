<script setup lang="ts">
/*
 * The pointer stick of touch mode, drawn where the finger landed. Only a
 * picture: useTouch reads the finger and moves the pointer.
 */
import type { StickAt } from "../input/useTouch";

defineProps<{ at: StickAt }>();
</script>

<template>
  <div class="pstick" :style="{ left: at.x + 'px', top: at.y + 'px' }" aria-hidden="true">
    <span
      class="pstick-thumb"
      :style="{ transform: `translate(${at.tx * 60}px, ${at.ty * 60}px)` }"
    ></span>
  </div>
</template>

<style scoped>
/* 120 px across: full tilt is at its rim, 60 px from the centre. */
.pstick {
  position: fixed;
  width: 120px;
  height: 120px;
  margin: -60px 0 0 -60px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg-overlay) 55%, transparent);
  border: 1px solid var(--border);
  pointer-events: none;
  z-index: 5;
}

.pstick-thumb {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg-raised) 85%, transparent);
  border: 1px solid var(--border-strong);
}
</style>
