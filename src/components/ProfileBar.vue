<script setup lang="ts">
/*
 * The profile the settings below belong to, above them. Switching here changes
 * the values in effect on the device; a new profile starts from the active
 * one, an empty one or a preset, and becomes the one being edited.
 */
import { computed, onMounted, ref } from "vue";

import { loadValues, restartDevice, type Values } from "../state/device";
import {
  DEFAULT_PROFILE,
  activeProfile,
  createProfile,
  deleteProfile,
  loadProfiles,
  profiles,
  selectProfile,
  updateProfile,
  type ProfileList,
  type ProfileMatch,
} from "../state/profiles";
import { runRestart } from "../state/restart";
import { toast } from "../state/toasts";

const emit = defineEmits<{ values: [Values] }>();

const busy = ref(false);
/* Which form is open under the bar. */
const open = ref<"" | "new" | "edit">("");

const active = computed(() => activeProfile(profiles.value));
const custom = computed(() => (active.value?.id ?? DEFAULT_PROFILE) !== DEFAULT_PROFILE);
const full = computed(
  () => !!profiles.value && profiles.value.profiles.length > profiles.value.max,
);

onMounted(() => {
  loadProfiles().catch(() => {
    /* an older firmware has no profiles: the bar stays away */
  });
});

/* After a change: fresh values for the panel, and the restart a moved
   boot-time value needs. */
async function settle(list: ProfileList) {
  emit("values", await loadValues());
  if (
    list.reboot &&
    confirm("Some settings of this profile apply after a restart (the gamepad, the EDID). Restart now?")
  ) {
    if (await runRestart("Restarting the device", restartDevice, { kind: "manual" })) {
      location.reload();
    }
  }
}

async function run(fn: () => Promise<ProfileList>) {
  busy.value = true;
  try {
    await settle(await fn());
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

function onSelect(e: Event) {
  const id = Number((e.target as HTMLSelectElement).value);
  open.value = "";
  void run(() => selectProfile(id));
}

/* ---- a new profile ---- */
const newFrom = ref("current");
const newName = ref("");

function openNew() {
  newFrom.value = profiles.value?.presets[0]?.id ?? "current";
  newName.value = "";
  open.value = open.value === "new" ? "" : "new";
}

const newPlaceholder = computed(
  () => profiles.value?.presets.find((p) => p.id === newFrom.value)?.name ?? "New profile",
);

async function makeNew() {
  await run(() => createProfile(newFrom.value, newName.value.trim() || undefined));
  open.value = "";
}

/* ---- the active one: name, rule, delete ---- */
const editName = ref("");
const editMatch = ref<ProfileMatch>({ cecName: "", cecVendor: "", usbOs: "" });

function openEdit() {
  const p = active.value;
  if (!p) return;
  editName.value = p.name;
  editMatch.value = { cecName: "", cecVendor: "", usbOs: "", ...p.match };
  open.value = open.value === "edit" ? "" : "edit";
}

async function saveEdit() {
  const p = active.value;
  if (!p) return;
  await run(() =>
    updateProfile(p.id, { name: editName.value.trim() || p.name, match: { ...editMatch.value } }),
  );
  open.value = "";
}

async function removeActive() {
  const p = active.value;
  if (!p || !confirm(`Delete the profile "${p.name}"? Default becomes active.`)) return;
  await run(() => deleteProfile(p.id));
  open.value = "";
}

const OS_CHOICES = [
  ["", "any"],
  ["windows", "Windows"],
  ["macos", "macOS"],
  ["linux", "Linux"],
  ["android", "Android"],
] as const;
</script>

<template>
  <div v-if="profiles" class="profile-bar">
    <div class="profile-row">
      <label class="setting-title" for="profile-pick">Profile</label>
      <select id="profile-pick" :value="String(profiles.active)" :disabled="busy" @change="onSelect">
        <option v-for="p in profiles.profiles" :key="p.id" :value="String(p.id)">
          {{ p.name }}
        </option>
      </select>
      <span v-if="custom" class="badge" :title="profiles.manual ? 'Picked by hand' : 'Picked for the attached device'">
        {{ profiles.manual ? "by hand" : "auto" }}
      </span>
      <span class="profile-actions">
        <button type="button" class="btn btn-sm" :disabled="busy || full" @click="openNew">New</button>
        <button v-if="custom" type="button" class="btn btn-sm" :disabled="busy" @click="openEdit">
          Edit
        </button>
      </span>
    </div>
    <p class="setting-note">
      <template v-if="custom">
        Settings marked with the profile's name are its own. The rest come from Default.
      </template>
      <template v-else>
        Default is used for every device. A profile keeps its own pointer, gamepad and
        video settings for one device.
      </template>
    </p>

    <form v-if="open === 'new'" class="profile-form" @submit.prevent="makeNew">
      <label>
        Start from
        <select v-model="newFrom" :disabled="busy">
          <option v-for="p in profiles.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
          <option value="current">a copy of {{ active?.name ?? "Default" }}</option>
          <option value="empty">nothing (all from Default)</option>
        </select>
      </label>
      <label>
        Name
        <input v-model="newName" type="text" maxlength="31" :placeholder="newPlaceholder" />
      </label>
      <span class="profile-actions">
        <button type="submit" class="btn btn-sm" :disabled="busy">Make it</button>
        <button type="button" class="btn btn-sm" @click="open = ''">Cancel</button>
      </span>
    </form>

    <form v-if="open === 'edit'" class="profile-form" @submit.prevent="saveEdit">
      <label>
        Name
        <input v-model="editName" type="text" maxlength="31" />
      </label>
      <p class="setting-note">
        Picked by itself when the attached device fits. A CEC name or vendor wins over the USB guess
        alone. Leave all three empty to pick it only by hand.
      </p>
      <label>
        CEC name starts with
        <input v-model="editMatch.cecName" type="text" maxlength="14" placeholder="any" />
      </label>
      <label>
        CEC vendor id
        <input v-model="editMatch.cecVendor" type="text" maxlength="6" placeholder="any, e.g. 0009bf" />
      </label>
      <label>
        OS by USB
        <select v-model="editMatch.usbOs">
          <option v-for="[v, t] in OS_CHOICES" :key="v" :value="v">{{ t }}</option>
        </select>
      </label>
      <span class="profile-actions">
        <button type="submit" class="btn btn-sm" :disabled="busy">Save</button>
        <button type="button" class="btn btn-sm" @click="open = ''">Cancel</button>
        <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="removeActive">
          Delete
        </button>
      </span>
    </form>
  </div>
</template>

<style scoped>
.profile-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}

.profile-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.profile-actions {
  display: inline-flex;
  gap: var(--space-1);
  margin-left: auto;
}

.profile-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.profile-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.profile-form .profile-actions {
  margin-left: 0;
}
</style>
