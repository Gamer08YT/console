/*
 * Screen areas: parts of the screen the device watches by itself - for a
 * change, for stillness, for a remembered picture, or for a colour - and
 * reports to notifications, the dashcam, Home Assistant and runbooks.
 */
import { ref } from "vue";

import { CONSOLE_HEADER, Unauthorized } from "./device";

export const REGION_MODES = ["change", "still", "like", "unlike", "colour"] as const;
export type RegionMode = (typeof REGION_MODES)[number];

export const REGION_COLOURS = [
  "any",
  "black",
  "grey",
  "white",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "magenta",
] as const;
export type RegionColour = (typeof REGION_COLOURS)[number];

export const MODE_LABELS: Record<RegionMode, string> = {
  change: "Changes",
  still: "Stops changing",
  like: "Looks like the saved picture",
  unlike: "No longer looks like it",
  colour: "Colour",
};

/** Parts of the screen, 0..1. */
export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionLive {
  seen: boolean;
  active: boolean;
  diff: number;
  events: number;
  colour: RegionColour;
  colourPct: number;
  rgb: string;
  activeMs?: number;
  stillMs?: number;
}

export interface Region extends RegionRect {
  id?: number;
  name: string;
  mode: RegionMode;
  /** % of the area that has to differ. */
  threshold: number;
  /** Seconds: how long it must hold; for "still", how long unchanged. */
  hold: number;
  colour: RegionColour;
  notify: boolean;
  clip: boolean;
  hasRef?: boolean;
  live?: RegionLive;
}

export interface RegionList {
  max: number;
  regions: Region[];
}

export const REGIONS_MAX = 8;

const URL_BASE = "/api/v1/regions";

async function call(path: string, body?: unknown): Promise<RegionList> {
  const res = await fetch(URL_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? CONSOLE_HEADER : { ...CONSOLE_HEADER, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 404 && !path) return { max: REGIONS_MAX, regions: [] }; /* older firmware */
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `areas: ${res.status}`);
  return json as RegionList;
}

export function loadRegions(): Promise<RegionList> {
  return call("");
}

/** All the areas at once; what the device keeps is what it answers. */
export function saveRegions(regions: Region[]): Promise<RegionList> {
  const strip = regions.map(({ live: _live, ...r }) => r);
  return call("", { regions: strip });
}

export function rememberRegion(id: number): Promise<RegionList> {
  return call("/remember", { id });
}

export function newRegion(rect: RegionRect, n: number): Region {
  return { ...rect, name: `Area ${n}`, mode: "change", threshold: 5, hold: 0, colour: "any", notify: false, clip: false };
}

/* ---- drawing one on the picture ------------------------------------------ */

/** Set while the operator drags a rectangle over the picture. */
export const drawing = ref(false);
/** The area being edited, kept here so it survives the panel closing to draw. */
export const draft = ref<Region | null>(null);
/** Which entry the draft replaces, or -1 for a new one. */
export const draftIndex = ref(-1);
/** The other areas, outlined while drawing. */
export const outlines = ref<RegionRect[]>([]);

/** A short line for what an area is watching for. */
export function describe(r: Region): string {
  switch (r.mode) {
    case "change":
      return r.hold ? `changes for ${r.hold} s` : "changes";
    case "still":
      return `still for ${r.hold} s`;
    case "like":
      return r.hasRef ? "looks like the saved picture" : "looks like... (nothing saved yet)";
    case "unlike":
      return r.hasRef ? "no longer looks like the saved picture" : "no longer like... (nothing saved yet)";
    case "colour":
      return r.colour === "any" ? "colour changes" : `turns ${r.colour}`;
  }
}

/** Keep a rectangle inside the screen and at least half a percent each way. */
export function clampRect(r: RegionRect): RegionRect {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const x = c(Math.min(r.x, r.x + r.w));
  const y = c(Math.min(r.y, r.y + r.h));
  const w = Math.min(1 - x, Math.abs(r.w));
  const h = Math.min(1 - y, Math.abs(r.h));
  return { x, y, w, h };
}

export function rectUsable(r: RegionRect): boolean {
  return r.w >= 0.005 && r.h >= 0.005;
}
