<script setup lang="ts">
/*
 * Screen areas, in the Automation panel: the list with what each sees now,
 * and the form for one. The rectangle is drawn on the picture itself - the
 * panel steps aside for that (App.vue), and the draft waits here.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  MODE_LABELS,
  REGION_COLOURS,
  REGION_MODES,
  REGIONS_MAX,
  describe,
  draft,
  draftIndex,
  drawing,
  loadRegions,
  outlines,
  rememberRegion,
  saveRegions,
  type Region,
} from "../state/regions";
import { toast } from "../state/toasts";

const regions = ref<Region[]>([]);
const loaded = ref(false);
const busy = ref(false);
let timer = 0;

async function refresh() {
  try {
    const list = await loadRegions();
    regions.value = list.regions;
    loaded.value = true;
  } catch {
    /* restarting: keep the last view */
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(refresh, 1000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const full = computed(() => regions.value.length >= REGIONS_MAX);

/* "Stops changing" means nothing at 0 seconds: half a minute to start with. */
watch(
  () => draft.value?.mode,
  (mode) => {
    if (mode === "still" && draft.value && draft.value.hold < 1) draft.value.hold = 30;
  },
);

function startDraw(index: number) {
  /* "Draw again" keeps the form as it is; anything else starts from the list. */
  if (!draft.value || index !== draftIndex.value) {
    draft.value = index >= 0 ? { ...regions.value[index] } : null;
  }
  draftIndex.value = index;
  outlines.value = regions.value.filter((_, i) => i !== index);
  drawing.value = true;
}

function edit(index: number) {
  draftIndex.value = index;
  draft.value = { ...regions.value[index] };
}

function cancel() {
  draft.value = null;
  draftIndex.value = -1;
}

async function apply(next: Region[], ok: string) {
  busy.value = true;
  try {
    regions.value = (await saveRegions(next)).regions;
    toast.info(ok);
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    busy.value = false;
  }
}

async function saveDraft() {
  const d = draft.value;
  if (!d) return;
  const next = [...regions.value];
  if (draftIndex.value >= 0) next[draftIndex.value] = d;
  else next.push(d);
  if (await apply(next, `Saved "${d.name}"`)) cancel();
}

async function remove(index: number) {
  const r = regions.value[index];
  if (!confirm(`Delete the area "${r.name}"?`)) return;
  await apply(
    regions.value.filter((_, i) => i !== index),
    `Deleted "${r.name}"`,
  );
  if (draftIndex.value === index) cancel();
}

async function remember(r: Region) {
  if (!r.id) return;
  busy.value = true;
  try {
    regions.value = (await rememberRegion(r.id)).regions;
    toast.info(`"${r.name}" will compare with what it shows now`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

function state(r: Region): string {
  const l = r.live;
  if (!l || !l.seen) return "no picture";
  if (r.mode === "colour") return `${l.colour} ${l.colourPct}%`;
  if (r.mode === "still") return l.active ? `still ${Math.round((l.stillMs ?? 0) / 1000)} s` : `moved ${l.diff}%`;
  return `${l.diff}% off`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
</script>

<template>
  <h3>Screen areas</h3>
  <p class="setting-note">
    Parts of the screen the device watches by itself: for a change, for a picture that stops
    moving, for one it has seen before, or for a colour. An area can send a notification, keep a
    dashcam clip, show in Home Assistant, and a runbook can wait for it with
    <code>wait area Name</code>.
  </p>

  <ul v-if="regions.length" class="image-list">
    <li v-for="(r, i) in regions" :key="r.id ?? i" class="image-row rg-row">
      <span
        class="rg-dot"
        :class="{ 'rg-dot-on': r.live?.active }"
        :style="r.mode === 'colour' && r.live?.seen ? { background: r.live.rgb } : undefined"
        :title="r.live?.active ? 'On' : 'Off'"
      />
      <span class="rg-name">
        <span class="image-name">{{ r.name }}</span>
        <small class="muted">{{ describe(r) }} &middot; <span class="mono">{{ state(r) }}</span></small>
      </span>
      <span class="macro-actions">
        <button type="button" class="btn btn-sm btn-quiet" @click="edit(i)">Edit</button>
        <button type="button" class="btn btn-sm btn-quiet" :disabled="busy" @click="remove(i)">Delete</button>
      </span>
    </li>
  </ul>
  <p v-else-if="loaded" class="setting-note">No areas yet.</p>

  <div v-if="draft" class="macro-editor rg-form">
    <label>
      Name
      <input v-model="draft.name" type="text" maxlength="23" />
    </label>
    <div class="rg-rect">
      <span class="mono">
        {{ pct(draft.x) }}, {{ pct(draft.y) }} &middot; {{ pct(draft.w) }} &times; {{ pct(draft.h) }}
      </span>
      <button type="button" class="btn btn-sm" @click="startDraw(draftIndex)">Draw again</button>
    </div>
    <label>
      Fires when it
      <select v-model="draft.mode">
        <option v-for="m in REGION_MODES" :key="m" :value="m">{{ MODE_LABELS[m] }}</option>
      </select>
    </label>
    <label v-if="draft.mode === 'colour'">
      Colour
      <select v-model="draft.colour">
        <option v-for="c in REGION_COLOURS" :key="c" :value="c">
          {{ c === "any" ? "any change of colour" : c }}
        </option>
      </select>
    </label>
    <label v-if="draft.mode !== 'colour'">
      How much of it must differ, %
      <input v-model.number="draft.threshold" type="number" min="1" max="100" />
      <small class="muted">1 for a thin progress bar, 5 for most, more to ignore a blinking cursor.</small>
    </label>
    <label>
      {{ draft.mode === "still" ? "Unchanged for, seconds" : "Has to last, seconds" }}
      <input v-model.number="draft.hold" type="number" :min="draft.mode === 'still' ? 1 : 0" max="86400" />
    </label>
    <div v-if="draft.mode === 'like' || draft.mode === 'unlike'" class="rg-ref">
      <span class="muted">
        {{ draft.hasRef ? "Compares with a saved picture." : "Nothing saved yet." }}
      </span>
      <button
        type="button"
        class="btn btn-sm"
        :disabled="busy || !draft.id"
        :title="draft.id ? 'Save what this area shows now' : 'Save the area first'"
        @click="remember(draft)"
      >
        Save what it shows now
      </button>
    </div>
    <label class="switch">
      <input v-model="draft.notify" type="checkbox" />
      <span>Send a notification</span>
    </label>
    <label class="switch">
      <input v-model="draft.clip" type="checkbox" />
      <span>Keep a dashcam clip</span>
    </label>
    <div class="macro-actions">
      <button type="button" class="btn btn-sm" :disabled="busy || !draft.name.trim()" @click="saveDraft">
        {{ busy ? "Saving..." : "Save" }}
      </button>
      <button type="button" class="btn btn-sm btn-quiet" @click="cancel">Cancel</button>
    </div>
  </div>
  <button v-else type="button" class="btn btn-sm" :disabled="full" @click="startDraw(-1)">
    {{ full ? `${REGIONS_MAX} areas at most` : "New area: draw it on the screen" }}
  </button>
</template>

<style scoped>
.rg-row {
  align-items: center;
}

.rg-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: transparent;
}

.rg-dot-on {
  background: var(--accent);
  border-color: var(--accent);
}

.rg-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.rg-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.rg-form label.switch {
  flex-direction: row;
  align-items: center;
}

.rg-rect,
.rg-ref {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
</style>
