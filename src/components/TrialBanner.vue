<script setup lang="ts">
/*
 * The running update is on trial (device.ts, TRIAL_SECONDS): how long until it
 * goes back, and both ways to end it sooner. Shown to every viewer, since any
 * of them can keep it.
 */
import { computed, onUnmounted, ref, watch } from "vue";

import { keepUpdate, rollbackUpdate, type SystemInfo } from "../state/device";
import { runRestart } from "../state/restart";
import { toast } from "../state/toasts";

const props = defineProps<{ system: SystemInfo | null }>();
const emit = defineEmits<{ (e: "kept"): void }>();

/* The device counts down, this only shows it: re-read on every system poll. */
const deadline = ref(0);
const now = ref(Date.now());
const busy = ref(false);
watch(
  () => props.system?.trialSeconds ?? 0,
  (s) => {
    deadline.value = s > 0 ? Date.now() + s * 1000 : 0;
  },
  { immediate: true },
);
const tick = window.setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => window.clearInterval(tick));

const left = computed(() => Math.max(0, Math.ceil((deadline.value - now.value) / 1000)));
const clock = computed(
  () => `${Math.floor(left.value / 60)}:${String(left.value % 60).padStart(2, "0")}`,
);
const previous = computed(
  () => props.system?.ota?.find((s) => !s.running)?.version || "the previous version",
);

async function keep() {
  busy.value = true;
  try {
    await keepUpdate();
    deadline.value = 0;
    toast.info(`Kept ${props.system?.version ?? "the update"}`);
    emit("kept");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

async function rollback() {
  if (!confirm(`Go back to ${previous.value} and restart the device now?`)) return;
  busy.value = true;
  try {
    const back = await runRestart(`Going back to ${previous.value}`, rollbackUpdate, {
      kind: "slot",
      from: props.system?.version,
      to: previous.value,
    });
    if (back) location.reload();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="deadline" class="update-banner" role="alert">
    <span v-if="left > 0">
      {{ system?.version }} is on trial. Check that video and input work, then keep it. Otherwise,
      or after a restart, the device goes back to {{ previous }} in {{ clock }}.
    </span>
    <span v-else>Nobody kept the update. The device is going back to {{ previous }}...</span>
    <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !left" @click="keep">
      Keep it
    </button>
    <button type="button" class="btn btn-sm" :disabled="busy || !left" @click="rollback">
      Go back now
    </button>
  </div>
</template>
