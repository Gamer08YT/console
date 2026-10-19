/*
 * The console's own controls that a person can hide - Settings -> UI. This is
 * the one list of them: a control opts in by carrying data-ui="<id>" in the
 * markup, and this module turns the device's ui_hidden setting (a list of ids)
 * into one style rule that hides exactly those. Nothing here switches a feature
 * off on the device; it only takes a button out of the way.
 *
 * Adding a control: give its element data-ui="<id>" and add the id here.
 * Removing one from this list leaves a stored id that matches nothing, which is
 * harmless.
 */
import { ref, watch } from "vue";

export interface UiFeature {
  id: string;
  label: string;
  group: string;
}

export const UI_FEATURES: UiFeature[] = [
  { id: "serial", label: "Serial console", group: "Connections" },
  { id: "keyboard", label: "On-screen keyboard", group: "Input" },
  { id: "cec", label: "TV remote (HDMI-CEC)", group: "Input" },
  { id: "gamepad", label: "Gamepad", group: "Input" },
  { id: "touch", label: "Touch mode", group: "Input" },
  { id: "keylock", label: "All keys (capture browser shortcuts)", group: "Input" },
  { id: "pause", label: "Pause the stream", group: "Picture" },
  { id: "scale", label: "Scale", group: "Picture" },
  { id: "fullscreen", label: "Full screen", group: "Picture" },
  { id: "sound", label: "Sound", group: "Picture" },
  { id: "select", label: "Select text on the screen", group: "Screen text" },
  { id: "copy", label: "Copy the screen as text", group: "Screen text" },
  { id: "screenshot", label: "Screenshot", group: "Recording" },
  { id: "clip", label: "Save clip (dashcam)", group: "Recording" },
  { id: "record", label: "Record", group: "Recording" },
  { id: "netlog", label: "Target log (netconsole)", group: "Logs" },
];

/** Parse the stored list: ids separated by commas or spaces. */
export function parseHidden(csv: string): Set<string> {
  return new Set(
    csv
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** The list to store, in a stable order. */
export function formatHidden(ids: Iterable<string>): string {
  return [...new Set(ids)].sort().join(",");
}

export const uiHidden = ref<Set<string>>(new Set());

export function setUiHidden(csv: string): void {
  const next = parseHidden(csv);
  const cur = uiHidden.value;
  if (next.size === cur.size && [...next].every((id) => cur.has(id))) return;
  uiHidden.value = next;
}

/** Whether a control is shown - for code that has to know, not just CSS. */
export function uiShown(id: string): boolean {
  return !uiHidden.value.has(id);
}

/* One style element, rewritten when the list changes. */
if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.id = "ui-hidden";
  document.head.appendChild(style);
  watch(
    uiHidden,
    (ids) => {
      style.textContent = [...ids]
        .filter((id) => /^[a-z0-9-]+$/.test(id))
        .map((id) => `[data-ui="${id}"]{display:none!important}`)
        .join("\n");
    },
    { immediate: true },
  );
}
