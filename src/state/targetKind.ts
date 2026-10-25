/*
 * What the target is, for the OS button on the rail. The USB fingerprint tells
 * computers apart, but a Nintendo Switch or a Steam Deck enumerates much like
 * Linux. Over HDMI-CEC both name themselves, so that wins over the USB guess.
 */
import type { CecDevice, UsbProbe } from "./device";

/** CEC vendor ids: Nintendo's IEEE OUI, and what a Steam Deck in its dock reports. */
const NINTENDO = "0009bf";
const STEAM_DECK = "e0319e";

export interface TargetKind {
  kind: string; /* windows, macos, linux, android, switch, steamdeck, or unknown */
  from: "usb" | "cec";
}

export function targetKind(probe: UsbProbe | null, cec: CecDevice | null): TargetKind {
  const vendor = cec?.vendor?.toLowerCase();
  if (cec && (vendor === NINTENDO || /^nintendo/i.test(cec.name))) {
    return { kind: "switch", from: "cec" };
  }
  if (cec && (vendor === STEAM_DECK || /^steam ?deck/i.test(cec.name))) {
    return { kind: "steamdeck", from: "cec" };
  }
  return { kind: probe?.os ?? "unknown", from: "usb" };
}
