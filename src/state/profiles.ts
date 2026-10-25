/*
 * Device profiles: settings of their own for each attached device, kept on the
 * device. Default is the settings as they always were. A profile holds only the
 * values it changes, and only for settings marked `profile` in the schema;
 * /api/v1/settings shows the values in effect and writes to the active profile.
 */
import { ref } from "vue";

import { CONSOLE_HEADER, Unauthorized, type Values } from "./device";

export const DEFAULT_PROFILE = 0;

/** What a profile's rule asks of the attached device. "" means any. */
export interface ProfileMatch {
  cecName: string;
  cecVendor: string;
  usbOs: string;
}

export interface Profile {
  id: number;
  name: string;
  /** Absent on Default. */
  match?: ProfileMatch;
  /** The profile's own values. Absent on Default. */
  set?: Values;
}

export interface Preset {
  id: string;
  name: string;
  match: ProfileMatch;
  set: Values;
}

export interface ProfileList {
  active: number;
  /** Chosen by hand rather than by the attached device. */
  manual: boolean;
  max: number;
  profiles: Profile[];
  presets: Preset[];
  /** What is attached now, as the device sees it. */
  seen?: ProfileMatch;
  /** Only on a change: a value that needs a restart moved. */
  reboot?: boolean;
}

const URL_BASE = "/api/v1/profiles";

/** The last list the device sent, for anything that wants to show the profile. */
export const profiles = ref<ProfileList | null>(null);

async function call(path: string, body?: unknown): Promise<ProfileList> {
  const res = await fetch(URL_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? CONSOLE_HEADER : { ...CONSOLE_HEADER, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? `profiles: ${res.status}`);
  }
  profiles.value = json as ProfileList;
  return profiles.value;
}

export function loadProfiles(): Promise<ProfileList> {
  return call("");
}

/**
 * @param from "current", "empty" or a preset id
 * @param set values of its own over where it starts
 * @param select make it active (the device's default)
 */
export function createProfile(
  from: string,
  name?: string,
  match?: ProfileMatch,
  set?: Values,
  select = true,
): Promise<ProfileList> {
  return call("", {
    from,
    select,
    ...(name ? { name } : {}),
    ...(match ? { match } : {}),
    ...(set ? { set } : {}),
  });
}

export function updateProfile(
  id: number,
  change: { name?: string; match?: ProfileMatch; set?: Values; unset?: string[] },
): Promise<ProfileList> {
  return call("/update", { id, ...change });
}

export function deleteProfile(id: number): Promise<ProfileList> {
  return call("/delete", { id });
}

export function selectProfile(id: number): Promise<ProfileList> {
  return call("/select", { id });
}

export function activeProfile(list: ProfileList | null): Profile | undefined {
  return list?.profiles.find((p) => p.id === list.active);
}

/** Whether the active profile holds its own value for @p key. */
export function ownValue(list: ProfileList | null, key: string): boolean {
  const p = activeProfile(list);
  return Boolean(p && p.id !== DEFAULT_PROFILE && p.set && key in p.set);
}
