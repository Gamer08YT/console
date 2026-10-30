<script setup lang="ts">
import Icon from "./Icon.vue";
/*
 * The version, as a small widget in the status bar: an outlined badge showing
 * what is running, a dot when a newer build is published, and - while an update
 * runs - the badge outline itself fills as a progress ring. Clicking it opens
 * the firmware panel (facts, the update check, install), so the whole update
 * flow lives one click from the version rather than buried in settings.
 *
 * An install is followed all the way through, not just up to the last byte:
 * download, upload, the device writing on its own, the reboot, and the console
 * finding it again. See Phase below for why.
 *
 * The check runs in the browser, never on the device: a KVM sits on networks
 * with no way out, and one that quietly reaches the internet is not what belongs
 * there. The browser fetches the image and hands it to the same endpoint a
 * manual upload uses.
 */
import { computed, onUnmounted, ref, watch } from "vue";

import {
  compareVersions,
  downloadFirmware,
  fetchRelease,
  listReleases,
  installRelease as requestDeviceInstall,
  installStatus,
  type PublishedRelease,
  type InstallStatus,
  switchBootSlot,
  TRIAL_SECONDS,
  uploadFirmware,
  type FirmwareRelease,
  type OtaSlot,
  type SystemInfo,
  type Values,
} from "../state/device";
import {
  EXPECTED_WRITE_MS,
  beginWatch,
  restartWatch,
  endWatch,
  rememberRestart,
  watchBack,
  watchPct,
  watchStep,
} from "../state/restart";
import { reportSeen, seenUrl } from "../state/seen";
import { toast } from "../state/toasts";

const props = defineProps<{ system: SystemInfo | null; values: Values }>();

/*
 * Ask for the video stream to be dropped while the image is going over.
 *
 * The device serves the console, the stream and this upload from one small
 * pool of TLS sessions, and it writes flash with the encoder running on the
 * other core. Reported as an update that fails and then works on the second or
 * third try (issue #19) - the flakiness of something being squeezed, not of
 * something broken. The picture is the one thing on screen nobody is looking at
 * while they watch an update bar, so it is what gives way.
 */
const emit = defineEmits<{ (e: "hold-stream", hold: boolean): void }>();

const open = ref(false);

/*
 * How an update proves itself (device.ts, TRIAL_SECONDS). "auto": on trial, and
 * this console keeps it once it can reach it again. "ask": on trial, and the
 * operator keeps it by hand. "off": it keeps itself as soon as it boots.
 */
type TrialMode = "auto" | "ask" | "off";
const TRIAL_KEY = "espkvm.updateTrial";
const trialMode = ref<TrialMode>("auto");
try {
  const saved = localStorage.getItem(TRIAL_KEY);
  if (saved === "ask" || saved === "off") trialMode.value = saved;
} catch {
  /* no storage: the default */
}
watch(trialMode, (m) => {
  try {
    localStorage.setItem(TRIAL_KEY, m);
  } catch {
    /* fine: this visit only */
  }
});
/* Firmware that knows nothing of trials ignores the parameter. */
const trialSeconds = computed(() => (trialMode.value === "off" ? 0 : TRIAL_SECONDS));
const trialNote = computed(() => (trialMode.value === "off" ? undefined : trialMode.value));
/* An update is on trial now: a new one would overwrite the image it falls back to. */
const onTrial = computed(() => (props.system?.trialSeconds ?? 0) > 0);

/*
 * Everything that raises the restart splash goes through here.
 *
 * The splash covers the page behind a blur, and this popup was still open under
 * it - lit up, with the progress bar visibly filling through the frosting. Put
 * the popup away as the splash goes up: the splash is the thing to watch now,
 * and what is underneath should not compete with it.
 */
function beginWatchHere(label: string, steps: Parameters<typeof beginWatch>[1] = []) {
  open.value = false;
  beginWatch(label, steps);
}
const release = ref<FirmwareRelease | null>(null);
const checking = ref(false);
const checkError = ref<string | null>(null);

/*
 * An install is four waits, not one, and each fails differently - so the widget
 * names the one it is in rather than showing a single bar that fills and then
 * appears to hang (issue #13). Only the first two have a percentage: once the
 * last byte is on the wire the device is erasing, writing and verifying flash
 * with nothing to report, and after that it is simply gone until it boots.
 */
type Phase =
  | "idle"
  | "downloading" /* pulling the image from the release server */
  | "uploading" /* handing it to the device, byte by byte */
  | "writing" /* device is writing and verifying; no progress to be had */
  | "restarting" /* written, waiting for it to come back on the new image */
  | "back" /* it answered again; reload onto the new firmware */
  | "lost"; /* it never answered - say so instead of pretending */

const phase = ref<Phase>("idle");
const firmwarePct = ref(0);
/** The device restarted without confirming the write, so the outcome is a guess. */
const unconfirmed = ref(false);
/** Why the last attempt failed, kept on screen until the next one starts. */
const installError = ref<string | null>(null);

/** An install is in flight: the controls stay disabled until it ends. "lost"
    is an ending, not a phase to wait in, so it frees the buttons for a retry. */
const uploading = computed(() => phase.value !== "idle" && phase.value !== "lost");
/** Phases with a real fraction to show; the others get an indeterminate bar. */
const measured = computed(() => phase.value === "downloading" || phase.value === "uploading");

/* Not "downloading": that one runs between the browser and the release server,
   and costs the device nothing. */
watch(
  () => phase.value === "uploading" || phase.value === "writing" || phase.value === "restarting",
  (busy) => emit("hold-stream", busy),
);

/* OTA slots (version + image state per app slot); absent on older firmware. */
const slots = computed<OtaSlot[]>(() => props.system?.ota ?? []);
/* The running image is a fresh, not-yet-confirmed OTA: a reset would roll it back. */
const runningPending = computed(() => slots.value.some((s) => s.running && s.state === "pending"));
const otherLabel = computed(() => slots.value.find((s) => !s.running)?.label ?? "the other slot");
/* An update always lands on the inactive slot; the running one is left untouched
   until the new image verifies. Null on older firmware that doesn't report slots. */
const updateTarget = computed(() => slots.value.find((s) => !s.running)?.label ?? null);

/** The slot being switched to, or null. Disables the buttons while it reboots. */
const switching = ref<string | null>(null);
/** The device never answered after a switch; say so rather than spin forever. */
const switchLost = ref(false);

/* Bootable = holds an image the bootloader has not marked bad. An empty version
   means no app was found in that slot. */
function canBoot(slot: OtaSlot): boolean {
  return !slot.running && slot.version !== "" && slot.state !== "invalid" && slot.state !== "aborted";
}

/** The state badge's short word. */
function stateLabel(slot: OtaSlot): string {
  if (slot.version === "") return "empty";
  switch (slot.state) {
    case "pending":
      return slot.running ? "unconfirmed" : "pending";
    case "invalid":
    case "aborted":
      return "failed";
    case "new":
      return "new";
    default:
      return slot.running ? "confirmed" : "standby";
  }
}

function badgeClass(slot: OtaSlot): string {
  if (slot.version === "") return "uw-tag-warn";
  if (slot.state === "invalid" || slot.state === "aborted") return "uw-tag-bad";
  if (slot.state === "pending" && slot.running) return "uw-tag-warn";
  return "";
}

/* Point the bootloader at another slot and ride the same restart -> reload path an
   install uses. The device refuses a slot without a valid image, so the worst a
   misclick costs is the confirm dialog. */
async function switchSlot(slot: OtaSlot) {
  if (slot.running || switching.value) return;
  const ver = slot.version || "unknown version";
  if (!confirm(`Boot from ${slot.label} (${ver}) and restart the device now?`)) return;
  switchLost.value = false;
  switching.value = slot.label;
  try {
    await switchBootSlot(slot.label);
  } catch (err) {
    switching.value = null;
    toast.error(err instanceof Error ? err.message : String(err));
    return;
  }
  beginWatchHere(`Booting ${slot.label}`);

  rememberRestart({ kind: "slot", from: props.system?.version, to: ver });
  if (await watchBack()) {
    watchStep("restart", "The device is back. Reloading the console...");
    /* The reboot cleared the session; the reload lands on the sign-in page. */
    setTimeout(() => location.reload(), 1500);
    return;
  }
  switching.value = null;
  switchLost.value = true;
}

/** The badge carries the version and nothing else - the install has the screen. */
const badgeText = computed(() => props.system?.version ?? "");
/* A local build carries a git-describe tail ("-12-gabc123-dirty") that does
   not fit a phone's top bar; there the badge shows the release part only. */
const badgeShort = computed(() => {
  const v = badgeText.value;
  const i = v.indexOf("-");
  return i > 0 ? `${v.slice(0, i)}\u2026` : v;
});

/** One line for the badge tooltip and the button label while an install runs. */
const statusText = computed(() => {
  switch (phase.value) {
    case "downloading":
      return `Downloading ${firmwarePct.value}%...`;
    case "uploading":
      return `Uploading ${firmwarePct.value}%...`;
    case "writing":
      return "Writing and verifying...";
    case "restarting":
      return "Restarting...";
    case "back":
      return "Back up, reloading...";
    default:
      return "";
  }
});

const reload = () => location.reload();

const updateUrl = computed(() => String(props.values.upd_url ?? "").trim());
const updateEnabled = computed(() => Boolean(props.values.upd_check) && updateUrl.value !== "");

const updateState = computed<"none" | "newer" | "same" | "older" | "unknown">(() => {
  const published = release.value?.version;
  const running = props.system?.version;
  if (!published || !running) return "none";
  const order = compareVersions(published, running);
  if (order === null) return published === running ? "same" : "unknown";
  if (order > 0) return "newer";
  return order === 0 ? "same" : "older";
});
const updateAvailable = computed(
  () => updateState.value === "newer" || updateState.value === "unknown",
);

async function checkForUpdate() {
  if (!updateEnabled.value) return;
  checking.value = true;
  checkError.value = null;
  try {
    release.value = await fetchRelease(updateUrl.value);
  } catch (err) {
    release.value = null;
    checkError.value = err instanceof Error ? err.message : String(err);
  } finally {
    checking.value = false;
  }
}

watch(updateEnabled, (on) => (on ? void checkForUpdate() : (release.value = null)), {
  immediate: true,
});
watch(updateUrl, () => void checkForUpdate());
/* A check that worked counts the device (seen.ts); the device info may come
   in after the check, so either order reports. */
watch([release, () => props.system?.installId], ([rel, id]) => {
  if (!rel) return;
  const s = props.system;
  reportSeen(seenUrl(updateUrl.value, id, s?.boardId, s?.version), id);
});

/**
 * Say what went wrong, and leave it said.
 *
 * A toast alone is not enough here: it fades while the operator is watching the
 * progress ring, and an install that ends with a full ring and no word is the
 * worst of the failures reported in issue #13. So the popup keeps the reason
 * until the next attempt clears it.
 */
function fail(message: string) {
  /* The watch owns the whole screen, so it has to come down with the failure -
     otherwise a refused image leaves the console behind an overlay that says
     what it was doing a moment ago, with no way out but a reload. */
  endWatch();
  phase.value = "idle";
  installError.value = message;
  toast.error(message);
}

/**
 * Catch an image that is plainly not one before it goes anywhere.
 *
 * An ESP application image starts with the magic byte 0xE9 and runs to
 * megabytes; a redirect page or a truncated download starts with "<" and is
 * over in a few kilobytes. Both would otherwise upload in a blink, be rejected
 * by the device, and look exactly like an update that did nothing.
 *
 * @returns the reason to refuse, or null if it looks like firmware.
 */
async function notAFirmwareImage(image: Blob): Promise<string | null> {
  if (image.size < 256 * 1024) {
    const kb = Math.round(image.size / 1024);
    return `that file is only ${kb} KB - too small to be a firmware image`;
  }
  const head = new Uint8Array(await image.slice(0, 1).arrayBuffer());
  if (head[0] !== 0xe9) return "that file does not start like an ESP firmware image";
  return null;
}

/**
 * Hand an image to the device and see the reboot through to the other side.
 *
 * The waiting is the point. The upload bar reaching the end means nothing was
 * lost on the wire, not that the device is done - it still has to verify the
 * image and reboot, and the console has to find it again afterwards. So this
 * walks the phases and ends on a concrete answer: back on its feet, or not.
 */
async function sendImage(image: Blob, label: string, version?: string) {
  phase.value = "uploading";
  firmwarePct.value = 0;
  unconfirmed.value = false;
  const wrong = await notAFirmwareImage(image);
  if (wrong) return fail(wrong);

  /* The install owns the screen from here: it ends in a restart, so there is
     nothing else to do in the console until it is over. */
  /* Installing a published build starts the watch earlier, at the download, and
     keeps its own longer list of steps. */
  if (!restartWatch.active) {
    beginWatchHere(`Installing ${label}`, [
      { key: "send", label: "Sending the image to the device" },
      { key: "write", label: "Writing and verifying it" },
      { key: "restart", label: "Restarting onto the new image" },
    ]);
  }
  watchStep("send", "Sending the image to the device...", { pct: 0 });
  let outcome;
  try {
    outcome = await uploadFirmware(
      image,
      trialSeconds.value,
      (f) => {
        firmwarePct.value = Math.round(f * 100);
        watchPct(firmwarePct.value);
      },
      () => {
        phase.value = "writing";
        watchStep("write", "Writing and verifying it on the device...", {
          pct: null,
          expectedMs: EXPECTED_WRITE_MS,
        });
      },
    );
  } catch (err) {
    endWatch();
    return fail(err instanceof Error ? err.message : String(err));
  }

  unconfirmed.value = !outcome.confirmed;
  phase.value = "restarting";
  /* Written down before the wait, not after: the answer is read on the far side
     of a reload that throws away everything this function knows. */
  rememberRestart({ kind: "update", from: props.system?.version, to: version, trial: trialNote.value });
  if (await watchBack()) {
    phase.value = "back";
    watchStep("restart", "The device is back. Reloading the console...");
    /* The reboot cleared the session, so the reload lands on the sign-in page
       of the new firmware. A beat first, so the message is readable. */
    setTimeout(() => location.reload(), 1500);
    return;
  }
  phase.value = "lost";
}

async function installRelease() {
  const target = release.value;
  if (!target) return;
  if (!confirm(`Install ${target.version} and restart the device?`)) return;
  installError.value = null;
  phase.value = "downloading";
  firmwarePct.value = 0;
  beginWatchHere(`Installing ${target.version}`, [
    { key: "download", label: "Fetching the image from the release" },
    { key: "send", label: "Sending the image to the device" },
    { key: "write", label: "Writing and verifying it" },
    { key: "restart", label: "Restarting onto the new image" },
  ]);
  watchStep("download", "Fetching the image...", { pct: 0 });
  let image: Blob;
  try {
    image = await downloadFirmware(target, (f) => {
      firmwarePct.value = Math.round(f * 100);
      watchPct(firmwarePct.value);
    });
  } catch (err) {
    endWatch();
    return fail(err instanceof Error ? err.message : String(err));
  }
  await sendImage(image, target.version, target.version);
}

async function onFirmwareChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  if (!confirm(`Install ${file.name} and restart the device?`)) return;
  installError.value = null;
  await sendImage(file, file.name);
}

/* The badge outline: accent when an update is available, a plain border
   otherwise. It used to carry the install as a filling ring and a pulse, which
   ran at the same time as the full-screen account of the same install - two
   things saying one thing, and the moving one made the version underneath hard
   to read (#22). The screen tells the story; the badge just says which version
   this is. */
const ringStyle = computed(() =>
  updateAvailable.value ? { background: "var(--accent)" } : {},
);

/*
 * Going back to an earlier release.
 *
 * The list is read here - GitHub's API allows a cross-origin read - but the
 * image cannot be: the host its assets come from sends no such header, so the
 * browser is refused whichever URL it tries. The device fetches it instead,
 * which it only does when the operator has said it may (fw_fetch), because a
 * KVM often sits where nothing should be reaching the internet at all.
 */
const fetchAllowed = computed(() => Boolean(props.values.fw_fetch));
const releases = ref<PublishedRelease[]>([]);
const releasesError = ref<string | null>(null);
const loadingReleases = ref(false);
const install = ref<InstallStatus | null>(null);
const installStarting = ref<string | null>(null);
let installPoll = 0;

async function loadReleases() {
  loadingReleases.value = true;
  releasesError.value = null;
  try {
    releases.value = await listReleases(props.system?.boardId);
  } catch (err) {
    releasesError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingReleases.value = false;
  }
}

/* What is worth offering: a published build for this board that is not the one
   already running. The direction is not filtered - going forward through a
   version that was skipped is the same operation. */
const otherReleases = computed(() =>
  releases.value.filter((r) => r.hasImage && r.version !== props.system?.version),
);

function stopInstallPoll() {
  if (installPoll) {
    window.clearInterval(installPoll);
    installPoll = 0;
  }
}

/*
 * The device fetches it, so the console has nothing to upload - but the
 * operator still needs the same thing the upload path gives them: a checklist
 * that says which stage it is in, and a reload once the device is back. Without
 * the reload a console left over from the old firmware goes on driving the new
 * one, which is exactly what `firmwareChanged` exists to complain about.
 */
async function startInstall(version: string) {
  if (!confirm(`Install ${version} and restart the device?`)) return;
  installStarting.value = version;
  releasesError.value = null;
  install.value = null;
  beginWatchHere(`Installing ${version}`, [
    { key: "fetch", label: "The device is fetching the image" },
    { key: "write", label: "Writing and verifying it" },
    { key: "restart", label: "Restarting" },
  ]);
  watchStep("fetch", "Asking for the image...", { pct: null });
  try {
    await requestDeviceInstall(version, trialSeconds.value);
  } catch (err) {
    endWatch();
    installStarting.value = null;
    releasesError.value = err instanceof Error ? err.message : String(err);
    return;
  }
  emit("hold-stream", true);

  stopInstallPoll();
  installPoll = window.setInterval(() => {
    void (async () => {
      let st: InstallStatus;
      try {
        st = await installStatus();
      } catch {
        /* The device goes away the moment it is done, so a poll that fails is
           the ordinary end of this - the state below is what decides. */
        return;
      }
      install.value = st;
      if (st.state === "running") {
        if (st.percent >= 0) {
          watchStep("fetch", "Downloading the image to the device...", { pct: st.percent });
          watchPct(st.percent);
        } else {
          watchStep("fetch", st.message, { pct: null });
        }
        return;
      }
      stopInstallPoll();
      installStarting.value = null;
      emit("hold-stream", false);
      if (st.state === "failed") {
        endWatch();
        releasesError.value = st.message;
        return;
      }
      /* Written down before the wait: the verdict is read on the far side of a
         reload that throws away everything this function knows. */
      watchStep("write", "Written and verified.", { pct: null, expectedMs: EXPECTED_WRITE_MS });
      rememberRestart({ kind: "update", from: props.system?.version, to: version, trial: trialNote.value });
      if (await watchBack()) {
        watchStep("restart", "The device is back. Reloading the console...");
        setTimeout(() => location.reload(), 1500);
      }
    })();
  }, 1000);
}

onUnmounted(stopInstallPoll);
</script>

<template>
  <div class="uw" v-if="system">
    <button
      type="button"
      class="uw-badge"
      :style="ringStyle"
      :title="uploading ? statusText : `${system.version}${updateAvailable ? ' - update available' : ''}`"
      :aria-label="`Firmware ${system.version}${updateAvailable ? ', update available' : ''}`"
      @click="open = !open"
    >
      <span class="uw-inner mono">
        <span class="uw-ver uw-ver-full">{{ badgeText }}</span>
        <span class="uw-ver uw-ver-short">{{ badgeShort }}</span>
        <span v-if="updateAvailable && !uploading" class="uw-dot" aria-hidden="true" />
      </span>
    </button>

    <template v-if="open">
      <div class="uw-backdrop" @click="open = false" />
      <div class="uw-popup">
        <div class="uw-head">
          <h3>Firmware</h3>
          <button
            type="button"
            class="btn btn-sm btn-icon btn-quiet"
            aria-label="Close"
            title="Close"
            @click="open = false"
          >
            <Icon name="close" :size="15" />
          </button>
        </div>

        <dl class="facts">
          <div class="fact">
            <dt>Version</dt>
            <dd class="mono">
              <a
                v-if="/^v\.\d+\.\d+\.\d+$/.test(system.version)"
                :href="`https://github.com/espkvm/espkvm/releases/tag/${system.version}`"
                target="_blank"
                rel="noopener"
                title="What is in this version"
                >{{ system.version }}</a
              >
              <template v-else>{{ system.version }}</template>
            </dd>
          </div>
          <div class="fact"><dt>Built</dt><dd class="mono">{{ system.built }}</dd></div>
          <div v-if="!slots.length" class="fact">
            <dt>Running from</dt>
            <dd class="mono">{{ system.partition }}</dd>
          </div>
        </dl>

        <div v-if="slots.length" class="uw-slots">
          <div class="uw-slots-head">Slots</div>
          <div v-for="slot in slots" :key="slot.label" class="uw-slot">
            <span class="mono uw-slot-name">{{ slot.label }}</span>
            <span class="mono uw-slot-ver">{{ slot.version || "empty" }}</span>
            <span class="uw-slot-badges">
              <span v-if="slot.running" class="uw-tag uw-tag-active">active</span>
              <span v-else-if="slot.boot" class="uw-tag">boots next</span>
              <span :class="['uw-tag', badgeClass(slot)]">{{ stateLabel(slot) }}</span>
            </span>
            <button
              v-if="!slot.running"
              type="button"
              class="btn btn-sm btn-quiet"
              :disabled="!canBoot(slot) || switching !== null"
              :title="canBoot(slot) ? `Boot from ${slot.label} and restart` : 'No bootable image in this slot'"
              @click="switchSlot(slot)"
            >
              {{ switching === slot.label ? "Switching..." : "Boot this" }}
            </button>
          </div>
          <p v-if="runningPending && !onTrial" class="setting-note setting-note-blocked">
            The running image is not confirmed yet - a reset now would roll back to
            {{ otherLabel }}.
          </p>
          <p v-if="switching" class="setting-note">
            Switching to {{ switching }} - the device is restarting and the console will reload...
          </p>
          <p v-if="switchLost" class="setting-note setting-note-blocked">
            The device did not answer after the switch. Reload the page to see which slot it is on.
          </p>
        </div>

        <!-- Earlier releases. The two slots above already let the operator go
             back one step; this is how to go further, and it is the device that
             fetches the image because the browser is not allowed to. -->
        <div v-if="system.updatable" class="uw-slots">
          <div class="uw-slots-head">Published releases</div>
          <p v-if="!fetchAllowed" class="setting-note">
            Installing an earlier release means the device downloading it itself, which is off
            until you allow it in Settings &rarr; System. The browser cannot fetch these images:
            the host they are served from refuses cross-origin reads.
          </p>
          <template v-else-if="install && install.state === 'running'">
            <p class="setting-note">
              Installing {{ install.version }} &mdash; {{ install.message
              }}<span v-if="install.percent >= 0"> {{ install.percent }}%</span>
            </p>
          </template>
          <template v-else-if="install && install.state === 'failed'">
            <p class="setting-note setting-note-blocked">
              {{ install.version }} was not installed: {{ install.message }}
            </p>
          </template>
          <template v-else>
            <button
              v-if="!releases.length"
              type="button"
              class="btn btn-sm btn-quiet"
              :disabled="loadingReleases"
              @click="loadReleases()"
            >
              {{ loadingReleases ? "Reading..." : "Show published releases" }}
            </button>
            <div v-for="rel in otherReleases" :key="rel.version" class="uw-slot">
              <span class="mono uw-slot-name">{{ rel.version }}</span>
              <span class="mono uw-slot-ver">{{ (rel.published ?? "").slice(0, 10) }}</span>
              <span class="uw-slot-badges">
                <a v-if="rel.notes" :href="rel.notes" target="_blank" rel="noopener">notes</a>
              </span>
              <button
                type="button"
                class="btn btn-sm btn-quiet"
                :disabled="installStarting !== null || onTrial"
                :title="`Have the device fetch ${rel.version} and restart into it`"
                @click="startInstall(rel.version)"
              >
                {{ installStarting === rel.version ? "Starting..." : "Install" }}
              </button>
            </div>
          </template>
          <p v-if="releasesError" class="setting-note setting-note-blocked">
            {{ releasesError }}
          </p>
        </div>

        <p v-if="!system.updatable" class="section-blocked">
          This firmware has a single app slot, so it cannot update itself.
        </p>
        <template v-else>
          <!-- Idle controls: hidden while an install runs, so the block shows just
               the progress bar and one line - not three copies of the percentage. -->
          <p v-if="onTrial" class="setting-note setting-note-blocked">
            The last update is still on trial. Keep it or roll it back before installing another.
          </p>
          <template v-if="!uploading && !onTrial">
          <p class="setting-note">
            The update installs to
            <span class="mono">{{ updateTarget ?? "the spare slot" }}</span> - the inactive one;
            the running slot is left untouched until the new image verifies, so a bad update
            falls back on its own.
          </p>

          <div v-if="updateEnabled">
            <p v-if="checking" class="setting-note">Checking for a newer build...</p>
            <p v-else-if="checkError" class="setting-note setting-note-blocked">
              Could not read the update manifest: {{ checkError }}
            </p>
            <template v-else-if="release">
              <p v-if="updateState === 'newer'" class="setting-note">
                <strong>{{ release.version }}</strong> is published; this device runs
                {{ system.version }}.
                <a v-if="release.notes" :href="release.notes" target="_blank" rel="noreferrer">
                  What changed
                </a>
              </p>
              <p v-else-if="updateState === 'unknown'" class="setting-note">
                <strong>{{ release.version }}</strong> is published. This device runs
                {{ system.version }}, which is not a release, so which is newer is anyone's guess.
              </p>
              <p v-else-if="updateState === 'older'" class="setting-note">
                This device runs {{ system.version }}, ahead of the published
                {{ release.version }}.
              </p>
              <p v-else class="setting-note">This device runs the newest published build.</p>
              <button
                v-if="updateAvailable"
                type="button"
                class="btn btn-sm"
                :disabled="uploading"
                @click="installRelease"
              >
                Install {{ release.version }}
              </button>
            </template>
            <button
              type="button"
              class="btn btn-sm btn-quiet"
              :disabled="checking || uploading"
              @click="checkForUpdate"
            >
              Check again
            </button>
          </div>

          <p class="setting-note">
            Or install a specific build by hand: download its <code>.bin</code> from the
            <a
              href="https://github.com/espkvm/espkvm/releases"
              target="_blank"
              rel="noreferrer"
              >releases page</a
            >
            and pick it below.
          </p>
          <label class="setting-note uw-trial">
            After an update
            <select v-model="trialMode">
              <option value="auto">keep it once this console reaches it</option>
              <option value="ask">let me check it, then keep it</option>
              <option value="off">keep it as soon as it boots</option>
            </select>
          </label>
          <p v-if="trialMode !== 'off'" class="setting-note">
            If it is not kept within {{ TRIAL_SECONDS / 60 }} minutes, the device goes back to
            {{ system.version }}. Use this when the device is far away: a broken VPN or Wi-Fi
            undoes itself.
          </p>
          <label class="btn btn-sm">
            Install firmware...
            <input type="file" accept=".bin" class="sr-only" @change="onFirmwareChosen" />
          </label>
          </template>

          <!-- The install, phase by phase: a real bar while bytes move, a
               travelling one while the device works with nothing to report,
               and a plain answer at the end either way. -->
          <template v-if="uploading">
            <div
              v-if="measured"
              class="progress"
              role="progressbar"
              :aria-valuenow="firmwarePct"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="progress-fill" :style="{ width: firmwarePct + '%' }"></div>
            </div>
            <div
              v-else-if="phase === 'writing' || phase === 'restarting'"
              class="progress"
              role="progressbar"
              :aria-label="statusText"
            >
              <div class="progress-sweep"></div>
            </div>
            <p class="setting-note" aria-live="polite">
              <template v-if="phase === 'downloading'">
                Downloading the image... {{ firmwarePct }}%
              </template>
              <template v-else-if="phase === 'uploading'">
                Sending the image to the device... {{ firmwarePct }}%
              </template>
              <template v-else-if="phase === 'writing'">
                The image is on the device, which is now writing and verifying it. This takes
                the better part of a minute and there is no progress to show for it - keep this
                page open.
              </template>
              <template v-else-if="phase === 'restarting'">
                <template v-if="unconfirmed">
                  The device dropped the connection on the last byte, which is what a restart
                  looks like from here. Waiting for it to come back...
                </template>
                <template v-else>Written. Waiting for the device to restart...</template>
              </template>
              <template v-else-if="phase === 'back'">
                The device is back. Reloading the console...
              </template>
            </p>
          </template>

          <template v-else>
            <p v-if="phase === 'lost'" class="setting-note setting-note-blocked">
              The device has not answered in a minute and a half. It may still be booting, or the
              new image may have failed to start - in which case the bootloader has already put
              the old one back. Reload the page to see which.
              <button type="button" class="btn btn-sm btn-quiet" @click="reload">Reload</button>
            </p>
            <p v-else-if="installError" class="setting-note setting-note-blocked">
              The update did not go through: {{ installError }}
            </p>
          </template>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.uw-trial {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.uw-trial select {
  max-width: 100%;
}
.uw {
  position: relative;
}

/* The outlined badge. The button's own background is the "outline": an inner
   span sits on top with the surface colour, leaving a 2px ring that ringStyle
   can turn into a progress arc or an accent border. */
.uw-badge {
  padding: 2px;
  border: none;
  border-radius: var(--radius);
  background: var(--border);
  cursor: pointer;
  line-height: 0;
}

.uw-inner {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1, 4px);
  padding: 2px 8px;
  border-radius: calc(var(--radius) - 2px);
  background: var(--bg-raised);
  color: var(--text);
  font-size: var(--text-sm);
  line-height: 1.4;
}

/* One line, never wrapped: a long local build name used to stand the badge on
   end. Whatever still does not fit is cut with an ellipsis. */
.uw-ver {
  display: inline-block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40vw;
}

.uw-ver-short {
  display: none;
}

@media (max-width: 640px) {
  .uw-ver-full {
    display: none;
  }

  .uw-ver-short {
    display: inline-block;
  }
}

/* The OTA slot list: one row per app slot, its version and state, and the button
   that boots the other one. */
.uw-slots {
  margin-top: var(--space-2, 8px);
}

.uw-slots-head {
  font-size: var(--text-sm);
  color: var(--muted);
  margin-bottom: var(--space-1, 4px);
}

.uw-slot {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: var(--space-1, 4px) 0;
  /* The popup asks for overflow-y: auto, and CSS turns the other axis from
     visible into auto with it - so anything wider than the popup produces a
     horizontal scrollbar, which was visible sliding about under the restart
     splash. Flex items do not shrink below their content unless told to, and a
     version string like v.0.36.0-2-gf373f94-dirty is wider than 320px allows.
     So let the row and its text shrink, and cut the text with an ellipsis. */
  min-width: 0;
}

.uw-slot-name,
.uw-slot-ver {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uw-slot-name {
  min-width: 3.5em;
}

.uw-slot-ver {
  color: var(--muted);
}

.uw-slot-badges {
  display: inline-flex;
  gap: var(--space-1, 4px);
  margin-left: auto;
}

/* Small state chip next to a slot. Distinct from .uw-badge, which is the
   status-bar button. */
.uw-tag {
  padding: 1px 6px;
  border-radius: var(--radius);
  background: var(--border);
  color: var(--text);
  font-size: var(--text-xs, 0.75rem);
  line-height: 1.5;
  white-space: nowrap;
}

.uw-tag-active {
  background: var(--accent);
  color: var(--bg, #fff);
}

.uw-tag-warn {
  background: var(--warn, #b8860b);
  color: #fff;
}

.uw-tag-bad {
  background: var(--danger, #b00020);
  color: #fff;
}

/* An indeterminate bar for the same phases: a band travelling across the track
   rather than a fill that would imply a fraction nobody can measure. */
.progress-sweep {
  height: 100%;
  width: 35%;
  border-radius: 999px;
  background: var(--accent);
  animation: uw-sweep 1.2s ease-in-out infinite;
}

@keyframes uw-sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress-sweep {
    animation: none;
  }
}

.uw-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.uw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.uw-popup {
  /* Fixed, not absolute: the status bar sets overflow-x, which makes overflow-y
     compute to auto and would clip a popup dropping below the bar. Fixed escapes
     that, positioned just under the bar at the right where the badge sits. */
  position: fixed;
  top: calc(var(--bar-height) + 6px);
  right: var(--space-3);
  z-index: 41;
  width: 320px;
  max-width: 90vw;
  max-height: 70vh;
  overflow-y: auto;
  /* Named rather than left to compute: see the note on .uw-slot. Nothing here
     is meant to be reachable sideways. */
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
}

.uw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.uw-head h3 {
  margin: 0;
}
</style>
