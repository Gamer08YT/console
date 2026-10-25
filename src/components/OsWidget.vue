<script setup lang="ts">
/*
 * The guessed target OS as a rail button above Settings: the button shows the OS
 * icon, a click opens the raw USB fingerprint the guess was inferred from beside
 * the rail. Only present once a target is attached over USB and the guess is
 * something other than unknown. A Nintendo Switch or a Steam Deck is known from
 * HDMI-CEC instead, and shown while it is the HDMI source, with the USB
 * fingerprint under it. The `side` prop is the rail's edge so the popup opens
 * inward over the stage, matching the diagnostics widget below it.
 *
 * The popup also shows the device profile in effect, lets one be picked by
 * hand, and saves the settings as a profile for the device attached now.
 */
import { computed, ref, watch } from "vue";

import OsIcon from "./OsIcon.vue";
import { loadValues, restartDevice, type CecDevice, type UsbProbe, type Values } from "../state/device";
import { runRestart } from "../state/restart";
import { toast } from "../state/toasts";
import {
  activeProfile,
  createProfile,
  loadProfiles,
  profiles,
  selectProfile,
  type ProfileList,
} from "../state/profiles";
import { targetKind } from "../state/targetKind";

const props = defineProps<{
  probe: UsbProbe | null;
  cec: CecDevice | null;
  attached: boolean;
  side: "left" | "right";
}>();

const emit = defineEmits<{ values: [Values] }>();

const open = ref(false);
const busy = ref(false);

watch(open, (o) => {
  if (o) {
    loadProfiles().catch(() => {
      /* an older firmware: no profile line */
    });
  }
});

const active = computed(() => activeProfile(profiles.value));

async function apply(fn: () => Promise<ProfileList>) {
  busy.value = true;
  try {
    const list = await fn();
    emit("values", await loadValues());
    if (
      list.reboot &&
      confirm("Some settings of this profile apply after a restart (the gamepad, the EDID). Restart now?") &&
      (await runRestart("Restarting the device", restartDevice, { kind: "manual" }))
    ) {
      location.reload();
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

function onPick(e: Event) {
  const id = Number((e.target as HTMLSelectElement).value);
  void apply(() => selectProfile(id));
}

/* A profile for the device attached now: a copy of what is in effect, with a
   rule from what the device says about itself. A preset that fits is the
   better start, so it is used when there is one. */
function saveForDevice() {
  const seen = profiles.value?.seen;
  if (!seen) return;
  const cec = target.value.from === "cec";
  const match = {
    cecName: cec ? (props.cec?.name ?? "") : "",
    cecVendor: cec ? (props.cec?.vendor ?? "") : "",
    usbOs: cec ? "" : (props.probe?.os ?? ""),
  };
  const preset = profiles.value?.presets.find(
    (p) =>
      (match.cecVendor && p.match.cecVendor === match.cecVendor) ||
      (match.cecName && p.match.cecName &&
        match.cecName.toLowerCase().startsWith(p.match.cecName.toLowerCase())) ||
      (!cec && match.usbOs && p.match.usbOs === match.usbOs),
  );
  void apply(() =>
    preset
      ? createProfile(preset.id, undefined, match)
      : createProfile("current", name.value, match),
  );
}

const OS_NAMES: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  switch: "Nintendo Switch",
  steamdeck: "Steam Deck",
};

const target = computed(() => targetKind(props.probe, props.cec));
const show = computed(
  () => target.value.from === "cec" || (props.attached && target.value.kind !== "unknown"),
);
const name = computed(() =>
  target.value.kind === "unknown" && target.value.from === "cec"
    ? (props.cec?.name ?? "unknown")
    : (OS_NAMES[target.value.kind] ?? target.value.kind),
);
const usbName = computed(() => OS_NAMES[props.probe?.os ?? ""] ?? props.probe?.os);
</script>

<template>
  <div class="ow" :data-side="side" v-if="show">
    <button
      type="button"
      class="rail-btn ow-btn"
      :class="{ 'rail-btn-active': open }"
      :title="target.from === 'cec' ? `Target: ${name}` : `Target looks like ${name} - click for the USB fingerprint`"
      :aria-label="`Target OS: ${name}`"
      @click="open = !open"
    >
      <OsIcon :os="target.kind" />
    </button>

    <template v-if="open">
      <div class="ow-backdrop" @click="open = false" />
      <div class="ow-popup">
        <div class="ow-head">
          <OsIcon :os="target.kind" />
          <template v-if="target.from === 'cec'">This is <strong>{{ name }}</strong></template>
          <template v-else>Looks like <strong>{{ name }}</strong></template>
        </div>
        <p v-if="target.from === 'cec'">
          It names itself over HDMI-CEC: {{ cec?.name || "no name" }}, vendor {{ cec?.vendor }}.
        </p>
        <template v-if="probe && attached">
          <p v-if="target.from === 'cec'">
            Over USB it looks like {{ probe.os === "unknown" ? "nothing known" : usbName }}:
          </p>
          <p v-else>
            Inferred from how the target enumerated over USB. If that is wrong,
            send this fingerprint in an issue so a later build can learn it:
          </p>
          <pre class="fingerprint">{{ probe.trace }}</pre>
        </template>
        <div v-if="profiles" class="ow-profile">
          <label>
            Profile
            <select :value="String(profiles.active)" :disabled="busy" @change="onPick">
              <option v-for="p in profiles.profiles" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
            </select>
          </label>
          <span v-if="active && active.id !== 0" class="badge">{{ profiles.manual ? "by hand" : "auto" }}</span>
          <button
            v-if="!active || active.id === 0"
            type="button"
            class="btn btn-sm"
            :disabled="busy || profiles.profiles.length > profiles.max"
            title="A profile with its own pointer, gamepad and video settings, picked when this device is attached"
            @click="saveForDevice"
          >
            Profile for this device
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ow {
  position: relative;
}

.ow-btn :deep(.os-icon) {
  width: 18px;
  height: 18px;
}

.ow-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

/* Same anchoring as the diagnostics widget: absolute, opening inward past the
   rail's edge (the rail sets no overflow, so it is not clipped). */
.ow-popup {
  position: absolute;
  bottom: 0;
  z-index: 41;
  width: min(340px, 80vw);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
}

.ow[data-side="left"] .ow-popup {
  left: calc(100% + 8px);
}

.ow[data-side="right"] .ow-popup {
  right: calc(100% + 8px);
}

.ow-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  margin-bottom: 8px;
}

.ow-head :deep(.os-icon) {
  width: 22px;
  height: 22px;
  color: var(--text);
}

.ow-profile {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
  font-size: 13px;
}

.ow-profile label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.ow-popup p {
  margin: 0 0 8px;
  color: var(--text-muted);
  font-size: 13px;
}

/* On a phone the rail is a row across the top, so "beside the button" points at
   the edge of the screen: the popup opened up and to the right, off the glass on
   both sides. Anchoring to a button that small buys nothing here - centre it. */
@media (max-width: 640px) {
  .ow-popup,
  .ow[data-side="left"] .ow-popup,
  .ow[data-side="right"] .ow-popup {
    position: fixed;
    left: var(--space-3);
    right: var(--space-3);
    top: 50%;
    bottom: auto;
    transform: translateY(-50%);
    width: auto;
    max-width: none;
    max-height: 80dvh;
    overflow-y: auto;
  }
}
</style>
