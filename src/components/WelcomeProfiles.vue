<script setup lang="ts">
/*
 * Asked once on a new device: what will it be plugged into? Every card that
 * fits can be picked, none has to be. A device card makes a profile from its
 * preset, picked by itself whenever that device is attached. The two computer
 * cards are about Default: a server has no use for the remote and gamepad
 * buttons, a media or gaming PC does. Over USB one computer looks like another,
 * so with both picked nothing is hidden. "Skip" leaves all as it is, and the
 * same can be done later in Settings.
 */
import { computed, ref } from "vue";

import Icon from "./Icon.vue";
import OsIcon from "./OsIcon.vue";
import { loadValues, saveSettings, type Values } from "../state/device";
import { createProfile, dismissAsk, presetIcon, profiles } from "../state/profiles";
import { toast } from "../state/toasts";
import { formatHidden, parseHidden } from "../ui/features";

const props = defineProps<{ values: Values }>();
const emit = defineEmits<{ values: [Values]; done: [] }>();

const SERVER = "server";
const MEDIA_PC = "mediapc";
/* Buttons a server or a work PC has no use for. */
const NOT_ON_A_COMPUTER = ["cec", "gamepad", "padmouse"];

/* What each card changes, in a few words. */
const NOTES: Record<string, string> = {
  server: "The settings as they are, without the TV remote and gamepad buttons.",
  mediapc: "The settings as they are, the TV remote and the gamepad at hand.",
  steamdeck: "Relative mouse for its pointer. Keyboard, gamepad and remote stay.",
  switch: "The device turns into a Switch controller. No keyboard or mouse buttons.",
  androidtv: "Relative mouse. Keyboard, gamepad and the TV remote at hand.",
  mitvstick: "Its USB is power only: the TV remote over HDMI-CEC is the control.",
};

interface Card {
  id: string;
  name: string;
  /** A console glyph for the computer cards, else an OS icon for a preset. */
  glyph?: "screen" | "film";
  os?: string;
}

const cards = computed<Card[]>(() => [
  { id: SERVER, name: "Server or work PC", glyph: "screen" },
  { id: MEDIA_PC, name: "Media center or gaming PC", glyph: "film" },
  ...(profiles.value?.presets ?? []).map((p) => ({ id: p.id, name: p.name, os: presetIcon(p.id) })),
]);

const picked = ref(new Set<string>());
const busy = ref(false);

function toggle(id: string) {
  const next = new Set(picked.value);
  if (!next.delete(id)) next.add(id);
  picked.value = next;
}

async function finish(apply: boolean) {
  busy.value = true;
  try {
    if (apply) {
      /* Default is the one in effect on a new device: its buttons first,
         then the profiles, none of them made active. */
      if (picked.value.has(SERVER) && !picked.value.has(MEDIA_PC)) {
        const hidden = parseHidden(String(props.values.ui_hidden ?? ""));
        NOT_ON_A_COMPUTER.forEach((id) => hidden.add(id));
        emit("values", await saveSettings({ ui_hidden: formatHidden(hidden) }));
      }
      for (const c of cards.value) {
        if (c.os && picked.value.has(c.id)) {
          await createProfile(c.id, undefined, undefined, undefined, false);
        }
      }
    }
    await dismissAsk({ welcome: true });
    if (apply && [...picked.value].some((id) => id !== MEDIA_PC)) {
      emit("values", await loadValues());
      toast.info("Done. Settings - Profile shows them");
    }
    emit("done");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="wp" role="dialog" aria-labelledby="wp-title">
    <h2 id="wp-title">What will this device be plugged into?</h2>
    <p class="wp-sub">
      Pick everything that fits. Each device gets a profile with settings that suit it, used
      whenever that device is attached.
    </p>
    <div class="wp-cards">
      <button
        v-for="c in cards"
        :key="c.id"
        type="button"
        class="wp-card"
        :class="{ 'wp-on': picked.has(c.id) }"
        :aria-pressed="picked.has(c.id)"
        :disabled="busy"
        @click="toggle(c.id)"
      >
        <span class="wp-tick" aria-hidden="true">{{ picked.has(c.id) ? "✓" : "" }}</span>
        <Icon v-if="c.glyph" :name="c.glyph" :size="28" />
        <OsIcon v-else :os="c.os ?? ''" />
        <strong>{{ c.name }}</strong>
        <small>{{ NOTES[c.id] ?? "" }}</small>
      </button>
    </div>
    <div class="wp-actions">
      <button type="button" class="btn btn-primary" :disabled="busy || !picked.size" @click="finish(true)">
        {{ busy ? "Saving..." : "Done" }}
      </button>
      <button type="button" class="btn btn-quiet" :disabled="busy" @click="finish(false)">Skip</button>
    </div>
  </section>
</template>

<style scoped>
.wp {
  position: absolute;
  top: var(--space-4);
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  width: min(640px, calc(100% - 2 * var(--space-3)));
  max-height: calc(100% - 2 * var(--space-4));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 12px);
  background: var(--bg-overlay);
  color: var(--text);
  box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
}

.wp h2 {
  margin: 0;
  font-size: var(--text-lg, 1.125rem);
}

.wp-sub {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.wp-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-2);
}

.wp-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  background: var(--bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.wp-card:hover {
  border-color: var(--border-strong);
}

.wp-card :deep(.os-icon) {
  width: 28px;
  height: 28px;
}

.wp-card small {
  color: var(--text-muted);
  font-size: var(--text-xs, 0.75rem);
}

.wp-on {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.wp-tick {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  font-size: 12px;
  line-height: 16px;
  text-align: center;
}

.wp-on .wp-tick {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.wp-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}
</style>
