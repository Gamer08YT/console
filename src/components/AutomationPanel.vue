<script setup lang="ts">
/*
 * Automation: what the device does by itself. Runbooks first - a macro that
 * can wait - with room for the rest of the family beside it.
 *
 * The device does the running - keys, waits, timeouts - so the tab can close
 * and the run carries on. This panel only keeps the list, checks a script the
 * same way the device will before saving it, and shows where a run is.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  loadRunbooks,
  parseRunbookScript,
  runbooksBytes,
  RUNBOOKS_MAX_BYTES,
  serializeRunbooks,
  type Runbook,
} from "../runbookScript";
import {
  cronError,
  loadSchedules,
  SCHEDULE_ACTIONS,
  schedulesBytes,
  SCHEDULES_MAX_BYTES,
  serializeSchedules,
  type Schedule,
  type ScheduleAction,
} from "../schedules";
import {
  loadNotifyStatus,
  loadRunbookStatus,
  loadScheduleStatus,
  runRunbook,
  runSchedule,
  saveSettings,
  stopRunbook,
  testNotify,
  type NotifyStatus,
  type RunbookStatus,
  type ScheduleStatus,
  type Values,
} from "../state/device";
import { toast } from "../state/toasts";
import RegionsSection from "./RegionsSection.vue";

const props = defineProps<{
  values: Values;
  /** Whether the target has a keyboard to send to. */
  attached: boolean;
}>();

const emit = defineEmits<{ (e: "values", v: Values): void }>();

const runbooks = computed<Runbook[]>(() => loadRunbooks(props.values.runbooks_json));

/* ---- the run ------------------------------------------------------------ */

const status = ref<RunbookStatus | null>(null);
const starting = ref(false);
const stopping = ref(false);
const running = computed(() => status.value?.state === "running");
let timer: number | null = null;

async function refresh() {
  try {
    status.value = await loadRunbookStatus();
  } catch {
    /* A device that is restarting answers later; keep the last view. */
  }
}

/* Poll quickly while a run is on, and not at all otherwise: the status is a
   fact about the last run until somebody starts another. */
function schedule() {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    await refresh();
    if (running.value) schedule();
    else timer = null;
  }, 500);
}

watch(running, (on) => {
  if (on) schedule();
});

onMounted(async () => {
  await refresh();
  if (running.value) schedule();
  await refreshSched();
  await refreshNotify();
  // The clock and the last-fired line change slowly; a look every 15 s is plenty.
  schedTimer = window.setInterval(refreshSched, 15000);
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer);
  if (schedTimer !== null) window.clearInterval(schedTimer);
});

async function run(r: Runbook) {
  starting.value = true;
  try {
    await runRunbook(r.name);
    await refresh();
    schedule();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    starting.value = false;
  }
}

async function stop() {
  stopping.value = true;
  try {
    await stopRunbook();
    await refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    stopping.value = false;
  }
}

const STATE_WORDS: Record<string, string> = {
  idle: "Nothing has run yet",
  running: "Running",
  done: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/* ---- the editor --------------------------------------------------------- */

/* index -1 is a new runbook, >= 0 edits an existing one, null hides the editor. */
const editIndex = ref<number | null>(null);
const editName = ref("");
const editScript = ref("");
const saving = ref(false);

const scriptError = computed(() => {
  if (editIndex.value === null || !editScript.value.trim()) return null;
  try {
    parseRunbookScript(editScript.value);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
});

function newRunbook() {
  editIndex.value = -1;
  editName.value = "";
  editScript.value = "timeout 120\nwait Press F2\nkey f2\nwait Boot\n";
}

function edit(i: number) {
  const r = runbooks.value[i];
  editIndex.value = i;
  editName.value = r.name;
  editScript.value = r.script;
}

function cancelEdit() {
  editIndex.value = null;
}

async function persist(list: Runbook[]) {
  const bytes = runbooksBytes(list);
  if (bytes > RUNBOOKS_MAX_BYTES) {
    toast.error(`The runbooks take ${bytes} bytes; the device holds ${RUNBOOKS_MAX_BYTES}`);
    return false;
  }
  saving.value = true;
  try {
    emit("values", await saveSettings({ runbooks_json: serializeRunbooks(list) }));
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    saving.value = false;
  }
}

async function save() {
  const name = editName.value.trim();
  if (!name) {
    toast.error("Give the runbook a name");
    return;
  }
  if (name.length > 47) {
    toast.error("A name is at most 47 characters");
    return;
  }
  if (scriptError.value) {
    toast.error(scriptError.value);
    return;
  }
  const taken = runbooks.value.findIndex((r) => r.name === name);
  if (taken >= 0 && taken !== editIndex.value) {
    toast.error(`There is already a runbook called "${name}"`);
    return;
  }
  const list = runbooks.value.slice();
  const entry = { name, script: editScript.value };
  if (editIndex.value !== null && editIndex.value >= 0) {
    list[editIndex.value] = entry;
  } else {
    list.push(entry);
  }
  if (await persist(list)) editIndex.value = null;
}

async function remove(i: number) {
  if (!confirm(`Delete the runbook "${runbooks.value[i].name}"?`)) return;
  const list = runbooks.value.slice();
  list.splice(i, 1);
  await persist(list);
}

/* ---- schedules ---------------------------------------------------------- */

const schedules = computed<Schedule[]>(() => loadSchedules(props.values.schedules_json));
const runbookNames = computed(() => runbooks.value.map((r) => r.name));
const schedEnabled = computed({
  get: () => props.values.sched_enable === true || props.values.sched_enable === 1,
  set: (v: boolean) => void saveSettings({ sched_enable: v }).then((vv) => emit("values", vv)),
});

const schedStatus = ref<ScheduleStatus | null>(null);
let schedTimer: number | null = null;
async function refreshSched() {
  try {
    schedStatus.value = await loadScheduleStatus();
  } catch {
    /* keep the last view across a restart */
  }
}

const scEdit = ref<number | null>(null);
const scName = ref("");
const scCron = ref("");
const scAction = ref<ScheduleAction>("wol");
const scArg = ref("");
const scEnabled = ref(true);
const scSaving = ref(false);

const cronMsg = computed(() =>
  scEdit.value !== null && scCron.value.trim() ? cronError(scCron.value) : null,
);

function newSchedule() {
  scEdit.value = -1;
  scName.value = "";
  scCron.value = "0 7 * * 1-5";
  scAction.value = "wol";
  scArg.value = "";
  scEnabled.value = true;
}

function editSchedule(i: number) {
  const s = schedules.value[i];
  scEdit.value = i;
  scName.value = s.name;
  scCron.value = s.cron;
  scAction.value = s.action;
  scArg.value = s.arg ?? "";
  scEnabled.value = s.enabled;
}

function cancelSchedule() {
  scEdit.value = null;
}

async function persistSchedules(list: Schedule[]): Promise<boolean> {
  const bytes = schedulesBytes(list);
  if (bytes > SCHEDULES_MAX_BYTES) {
    toast.error(`The schedules take ${bytes} bytes; the device holds ${SCHEDULES_MAX_BYTES}`);
    return false;
  }
  scSaving.value = true;
  try {
    emit("values", await saveSettings({ schedules_json: serializeSchedules(list) }));
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    scSaving.value = false;
  }
}

async function saveSchedule() {
  const name = scName.value.trim();
  if (!name) {
    toast.error("Give the schedule a name");
    return;
  }
  if (cronMsg.value) {
    toast.error(cronMsg.value);
    return;
  }
  if (scAction.value === "runbook" && !scArg.value) {
    toast.error("Choose a runbook to run");
    return;
  }
  const taken = schedules.value.findIndex((s) => s.name === name);
  if (taken >= 0 && taken !== scEdit.value) {
    toast.error(`There is already a schedule called "${name}"`);
    return;
  }
  const entry: Schedule = {
    name,
    cron: scCron.value.trim(),
    action: scAction.value,
    arg: scAction.value === "runbook" ? scArg.value : undefined,
    enabled: scEnabled.value,
  };
  const list = schedules.value.slice();
  if (scEdit.value !== null && scEdit.value >= 0) list[scEdit.value] = entry;
  else list.push(entry);
  if (await persistSchedules(list)) scEdit.value = null;
}

async function removeSchedule(i: number) {
  if (!confirm(`Delete the schedule "${schedules.value[i].name}"?`)) return;
  const list = schedules.value.slice();
  list.splice(i, 1);
  await persistSchedules(list);
}

async function toggleSchedule(i: number) {
  const list = schedules.value.slice();
  list[i] = { ...list[i], enabled: !list[i].enabled };
  await persistSchedules(list);
}

async function runNow(s: Schedule) {
  try {
    await runSchedule(s.name);
    toast.info(`Fired "${s.name}"`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

function actionLabel(a: string): string {
  return SCHEDULE_ACTIONS.find((x) => x.value === a)?.label ?? a;
}

/* ---- notifications ------------------------------------------------------ */

const notifyEnabled = computed({
  get: () => props.values.notify_enable === true || props.values.notify_enable === 1,
  set: (v: boolean) => void saveSettings({ notify_enable: v }).then((vv) => emit("values", vv)),
});
const notifyStatus = ref<NotifyStatus | null>(null);
const testing = ref(false);

async function refreshNotify() {
  try {
    notifyStatus.value = await loadNotifyStatus();
  } catch {
    /* keep the last view */
  }
}

async function sendTest() {
  testing.value = true;
  try {
    await testNotify();
    // The send runs on the device; give it a moment, then read the result.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      await refreshNotify();
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="automation">
    <p class="setting-note">
      A runbook is a macro that can wait: it sends keys, and it holds until a phrase shows up on
      the screen. The device runs it, so this tab can close. Waits only see a text screen - a
      BIOS, a boot menu, a console - never a picture.
    </p>

    <div v-if="status && status.state !== 'idle'" class="runbook-status" :class="`runbook-${status.state}`">
      <div class="runbook-status-head">
        <strong>{{ STATE_WORDS[status.state] }}</strong>
        <span class="mono">{{ status.name }}</span>
        <span v-if="status.steps" class="setting-note">step {{ status.step }} of {{ status.steps }}</span>
        <span class="setting-note">{{ elapsed(status.elapsedMs) }}</span>
        <button v-if="running" type="button" class="btn btn-sm" :disabled="stopping" @click="stop">
          {{ stopping ? "Stopping..." : "Stop" }}
        </button>
      </div>
      <div v-if="status.line" class="mono runbook-line">{{ status.line }}</div>
      <div v-if="status.state === 'failed' || status.state === 'stopped'" class="setting-note setting-note-blocked">
        {{ status.message }}
      </div>
    </div>

    <h3>Runbooks</h3>
    <ul v-if="runbooks.length" class="image-list">
      <li v-for="(r, i) in runbooks" :key="i" class="image-row">
        <span class="image-name mono">{{ r.name }}</span>
        <span class="macro-actions">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="running || starting || !attached"
            :title="attached ? '' : 'No USB target to send keys to'"
            @click="run(r)"
          >
            Run
          </button>
          <button type="button" class="btn btn-sm btn-quiet" @click="edit(i)">Edit</button>
          <button type="button" class="btn btn-sm btn-quiet" @click="remove(i)">Delete</button>
        </span>
      </li>
    </ul>
    <p v-else class="setting-note">No runbooks yet.</p>

    <div v-if="editIndex !== null" class="macro-editor">
      <input v-model="editName" type="text" placeholder="Runbook name" />
      <textarea
        v-model="editScript"
        rows="10"
        class="mono"
        spellcheck="false"
        placeholder="timeout 120&#10;wait Press F2&#10;key f2&#10;wait Boot"
      ></textarea>
      <p class="setting-note">
        One command per line. <code>key ctrl+alt+f2</code> presses a chord,
        <code>type root</code> types text (US layout), <code>delay 500</code> pauses in
        milliseconds. <code>wait Press F2</code> holds until a row of the screen contains the
        phrase, <code>gone Loading</code> until none does, <code>wait area Name</code> until a
        screen area fires (<code>gone area Name</code> until it is off), and <code>timeout 120</code> sets how
        many seconds the waits below it may take (60 if unsaid). A wait that runs out stops the
        runbook there. <code>record</code> starts recording the screen to the microSD card and
        goes on (<code>record 300</code> for five minutes), <code>timelapse 10</code> records one frame every
        10 seconds (<code>timelapse 10 28800</code> for eight hours), <code>record stop</code> ends
        either, and <code>screenshot</code> saves one picture. Over HDMI-CEC, <code>hdmi standby</code>
        puts the source to sleep, <code>hdmi wake</code> wakes it and <code>hdmi key up</code>
        presses a remote key (up, down, left, right, select, back, home, play, pause...). Lines
        starting with # are ignored. Every key name is listed in
        <a href="https://espkvm.io/scripts/" target="_blank" rel="noopener">espkvm.io/scripts</a>.
      </p>
      <p v-if="scriptError" class="setting-note setting-note-blocked">{{ scriptError }}</p>
      <div class="macro-actions">
        <button type="button" class="btn btn-sm" :disabled="saving || !!scriptError" @click="save">
          {{ saving ? "Saving..." : "Save" }}
        </button>
        <button type="button" class="btn btn-sm btn-quiet" @click="cancelEdit">Cancel</button>
      </div>
    </div>
    <button v-else type="button" class="btn btn-sm" @click="newRunbook">New runbook...</button>

    <hr class="panel-rule" />

    <RegionsSection />

    <hr class="panel-rule" />

    <h3>Schedules</h3>
    <p class="setting-note">
      Fire an action on a timetable - Wake-on-LAN in the morning, a runbook overnight, a reset on
      a schedule. The device runs these, so nothing has to be open. They need the clock, which it
      sets over the network; the time server and the time zone are in Settings, System.
    </p>

    <label class="switch">
      <input v-model="schedEnabled" type="checkbox" />
      <span>Run schedules</span>
    </label>

    <p v-if="schedEnabled && schedStatus" class="setting-note">
      <template v-if="schedStatus.clockValid">
        Device clock: <span class="mono">{{ schedStatus.now }}</span>
        <span v-if="schedStatus.tz"> ({{ schedStatus.tz }})</span>.
        <template v-if="schedStatus.lastName">
          Last fired <span class="mono">{{ schedStatus.lastName }}</span> at
          {{ schedStatus.lastAt }}.
        </template>
      </template>
      <span v-else class="setting-note-blocked">
        The clock is not set yet. Nothing fires until it is - check the time server under Settings,
        System.
      </span>
    </p>

    <ul v-if="schedules.length" class="image-list">
      <li v-for="(s, i) in schedules" :key="i" class="image-row">
        <span class="sched-desc">
          <span class="image-name mono">{{ s.name }}</span>
          <span class="setting-note sched-when">
            <code>{{ s.cron }}</code> &rarr; {{ actionLabel(s.action) }}<template v-if="s.arg"> ({{ s.arg }})</template>
          </span>
        </span>
        <span class="macro-actions">
          <button type="button" class="btn btn-sm" @click="runNow(s)">Run now</button>
          <button
            type="button"
            class="btn btn-sm btn-quiet"
            :class="{ 'btn-on': s.enabled }"
            :title="s.enabled ? 'On - click to pause' : 'Paused - click to enable'"
            @click="toggleSchedule(i)"
          >
            {{ s.enabled ? "On" : "Off" }}
          </button>
          <button type="button" class="btn btn-sm btn-quiet" @click="editSchedule(i)">Edit</button>
          <button type="button" class="btn btn-sm btn-quiet" @click="removeSchedule(i)">Delete</button>
        </span>
      </li>
    </ul>
    <p v-else class="setting-note">No schedules yet.</p>

    <div v-if="scEdit !== null" class="macro-editor">
      <input v-model="scName" type="text" placeholder="Schedule name" />
      <input v-model="scCron" type="text" class="mono" spellcheck="false" placeholder="0 7 * * 1-5" />
      <p class="setting-note">
        Five fields: minute hour day month weekday. <code>0 7 * * 1-5</code> is 07:00 on weekdays,
        <code>*/15 * * * *</code> every fifteen minutes. <a href="https://espkvm.io/scripts/" target="_blank" rel="noopener">espkvm.io/scripts</a>.
      </p>
      <p v-if="cronMsg" class="setting-note setting-note-blocked">{{ cronMsg }}</p>
      <select v-model="scAction">
        <option v-for="a in SCHEDULE_ACTIONS" :key="a.value" :value="a.value">{{ a.label }}</option>
      </select>
      <select v-if="scAction === 'runbook'" v-model="scArg">
        <option value="" disabled>Choose a runbook...</option>
        <option v-for="n in runbookNames" :key="n" :value="n">{{ n }}</option>
      </select>
      <label class="switch">
        <input v-model="scEnabled" type="checkbox" />
        <span>Enabled</span>
      </label>
      <div class="macro-actions">
        <button type="button" class="btn btn-sm" :disabled="scSaving || !!cronMsg" @click="saveSchedule">
          {{ scSaving ? "Saving..." : "Save" }}
        </button>
        <button type="button" class="btn btn-sm btn-quiet" @click="cancelSchedule">Cancel</button>
      </div>
    </div>
    <button v-else type="button" class="btn btn-sm" @click="newSchedule">New schedule...</button>

    <hr class="panel-rule" />

    <h3>Notifications</h3>
    <p class="setting-note">
      Push a message when a watched phrase appears, the screen goes blank or a screen area that
      asks for it fires - to Telegram (with a
      screenshot on the MJPEG codec) or a webhook. Set the bot token, chat id or URL under
      Settings &rarr; Notifications.
      <a href="https://github.com/espkvm/espkvm/blob/main/docs/NOTIFICATIONS.md" target="_blank"
        rel="noopener">How they work</a>.
    </p>
    <label class="switch">
      <input v-model="notifyEnabled" type="checkbox" />
      <span>Send notifications</span>
    </label>
    <p v-if="notifyStatus" class="setting-note">
      Last send:
      <span :class="{ 'setting-note-blocked': notifyStatus.lastResult !== 'ok' && notifyStatus.lastAt }">
        {{ notifyStatus.lastResult }}</span
      ><template v-if="notifyStatus.lastAt"> ({{ notifyStatus.lastAt }})</template>.
    </p>
    <button type="button" class="btn btn-sm" :disabled="testing || !notifyEnabled" @click="sendTest">
      {{ testing ? "Sending..." : "Send a test" }}
    </button>
  </div>
</template>
