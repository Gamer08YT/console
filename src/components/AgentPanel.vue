<script setup lang="ts">
/*
 * espkvm-agent on the target, as a small floating window: what the machine
 * is, its clipboard both ways, and a clean shutdown or restart. The agent
 * talks over the USB serial port the device gives the target in agent mode.
 *
 * Reading the clipboard and power are switched on at the machine, not here,
 * so a refusal says what to switch on there.
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

import {
  AgentError,
  agentPower,
  getAgent,
  getAgentClipboard,
  getAgentMachine,
  setAgentClipboard,
  type AgentMachine,
  type AgentStatus,
} from "../state/device";
import { toast } from "../state/toasts";
import { useFloating } from "../ui/floating";
import Icon from "./Icon.vue";

const emit = defineEmits<{ close: [] }>();

/* The device takes at most 64 KB of clipboard text. */
const MAX_TEXT = 64 * 1024;

const status = ref<AgentStatus | null>(null);
const machine = ref<AgentMachine | null>(null);
const text = ref("");
const busy = ref(false);
const clipNote = ref("");
const powerNote = ref("");
const popup = ref<HTMLElement | null>(null);
let timer: number | null = null;

const OS_NAMES: Record<string, string> = { linux: "Linux", windows: "Windows", darwin: "macOS" };

async function refresh() {
  try {
    const st = await getAgent();
    const came = st.connected && !status.value?.connected;
    status.value = st;
    if (came) await readMachine();
    if (!st.connected) machine.value = null;
  } catch {
    /* A missed reading is not worth a toast; the next one will do. */
  }
}

async function readMachine() {
  try {
    machine.value = await getAgentMachine();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

onMounted(async () => {
  await nextTick();
  popup.value?.focus();
  await refresh();
  timer = window.setInterval(() => void refresh(), 3000);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

const { pos, dragStart, dragMove, dragEnd } = useFloating({
  key: "espkvm.agent",
  el: popup,
  initial: () => ({
    x: Math.max(8, window.innerWidth - 300 - 24),
    y: window.innerWidth < 700 ? Math.max(8, window.innerHeight - 520) : 80,
  }),
});

const uptime = computed(() => {
  const s = machine.value?.uptimeS;
  if (s === undefined) return "";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `up ${d} d ${h} h` : h > 0 ? `up ${h} h ${m} min` : `up ${m} min`;
});

const summary = computed(() => {
  const m = machine.value;
  if (!m) return "";
  return [m.osName || OS_NAMES[m.os] || m.os, m.arch, uptime.value, m.user].filter(Boolean).join(" · ");
});

/* What to do about a refusal, in words for the person at the console. */
function why(err: unknown, op: "read" | "write" | "power"): string {
  if (!(err instanceof AgentError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case "not_allowed":
      return op === "power"
        ? "Power is off on the machine. Install the agent there with --allow-power."
        : "Reading the clipboard is off on the machine. Install the agent there with --allow-clipboard-read.";
    case "locked":
      return "The machine's screen is locked, so its clipboard is not read.";
    case "no_desktop":
      return "The agent runs as a system service, which has no clipboard. Install it with --desktop.";
    default:
      return err.message;
  }
}

async function getClip() {
  busy.value = true;
  clipNote.value = "";
  try {
    text.value = await getAgentClipboard();
    if (!text.value) clipNote.value = "The clipboard is empty.";
  } catch (err) {
    clipNote.value = why(err, "read");
  } finally {
    busy.value = false;
  }
}

async function sendClip() {
  busy.value = true;
  clipNote.value = "";
  try {
    await setAgentClipboard(text.value);
    toast.info("On the machine's clipboard");
  } catch (err) {
    clipNote.value = why(err, "write");
  } finally {
    busy.value = false;
  }
}

async function power(action: "shutdown" | "reboot") {
  const name = machine.value?.hostname || "the machine";
  if (!confirm(action === "reboot" ? `Restart ${name}?` : `Shut ${name} down?`)) return;
  powerNote.value = "";
  try {
    await agentPower(action);
    toast.info(action === "reboot" ? `${name} is restarting` : `${name} is shutting down`);
  } catch (err) {
    powerNote.value = why(err, "power");
  }
}

const tooLong = computed(() => new TextEncoder().encode(text.value).length > MAX_TEXT);
</script>

<template>
  <Teleport to="body">
    <section
      ref="popup"
      class="ag-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      tabindex="-1"
      aria-label="Agent"
    >
      <div
        class="ag-head"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointercancel="dragEnd"
      >
        <h3>Agent</h3>
        <span v-if="status" :class="['pill', status.connected ? 'pill-on' : 'pill-off']">
          {{ status.connected ? `${OS_NAMES[status.os ?? ""] ?? status.os} ${status.version}` : "waiting" }}
        </span>
        <button
          type="button"
          class="btn btn-sm btn-icon btn-quiet ag-close"
          aria-label="Close the agent window"
          title="Close"
          @click="emit('close')"
        >
          <Icon name="close" :size="15" />
        </button>
      </div>

      <p v-if="!status" class="ag-note">Asking the device...</p>
      <template v-else-if="!status.connected">
        <p class="ag-note">
          No agent on the machine yet. Install
          <a href="https://github.com/espkvm/agent" target="_blank" rel="noopener">espkvm-agent</a>
          there. It finds this USB port by itself.
        </p>
      </template>
      <template v-else>
        <div class="ag-who">
          <strong>{{ machine?.hostname || "..." }}</strong>
          <small>{{ summary }}</small>
          <ul v-if="machine?.ifaces.length" class="ag-ifaces mono">
            <li v-for="i in machine.ifaces" :key="i.name">
              <span class="ag-if">{{ i.name }}</span> {{ i.ips.join(", ") }}
            </li>
          </ul>
        </div>

        <h4>Clipboard</h4>
        <textarea
          v-model="text"
          class="ag-text"
          rows="4"
          spellcheck="false"
          placeholder="Text to put on the machine's clipboard, or get from it"
          aria-label="Clipboard text"
        />
        <div class="ag-row">
          <button type="button" class="btn btn-sm" :disabled="busy" title="Read the machine's clipboard" @click="getClip">
            Get
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="busy || tooLong"
            title="Put this text on the machine's clipboard"
            @click="sendClip"
          >
            Send
          </button>
        </div>
        <p v-if="tooLong" class="ag-note ag-warn">Over 64 KB, too long to send.</p>
        <p v-else-if="clipNote" class="ag-note ag-warn">{{ clipNote }}</p>

        <h4>Power</h4>
        <div class="ag-row">
          <button type="button" class="btn btn-sm" @click="power('reboot')">Restart</button>
          <button type="button" class="btn btn-sm" @click="power('shutdown')">
            <Icon name="power" :size="14" /> Shut down
          </button>
        </div>
        <p v-if="powerNote" class="ag-note ag-warn">{{ powerNote }}</p>
        <p v-else class="ag-note">A clean shutdown through the OS, if allowed on the machine.</p>
      </template>
    </section>
  </Teleport>
</template>

<style scoped>
.ag-menu {
  position: fixed;
  z-index: 56;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  width: 300px;
  max-width: calc(100vw - 16px);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  box-shadow: var(--shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
  outline: none;
}

.ag-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.ag-head h3,
.ag-menu h4 {
  margin: 0;
}

.ag-menu h4 {
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ag-close {
  margin-left: auto;
}

.ag-note {
  margin: 0;
  color: var(--text-faint);
  font-size: var(--text-xs);
}

.ag-warn {
  color: var(--warn, var(--text));
}

.ag-who {
  display: flex;
  flex-direction: column;
}

.ag-who small {
  color: var(--text-faint);
  font-size: var(--text-xs);
}

.ag-ifaces {
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.ag-if {
  color: var(--text-faint);
}

.ag-text {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font: inherit;
  font-size: var(--text-sm, 13px);
}

.ag-row {
  display: flex;
  gap: 4px;
}

.ag-row .btn {
  flex: 1;
}
</style>
