import { test } from "node:test";
import assert from "node:assert/strict";

import { targetKind } from "../src/state/targetKind.ts";

const sw = { la: 4, name: "NintendoSwitch", type: "playback", vendor: "0009bf", power: "on", seenMs: 0 };
const deck = { la: 4, name: "Steam Deck", type: "playback", vendor: "e0319e", power: "on", seenMs: 0 };
const tv = { la: 4, name: "Chromecast", type: "playback", vendor: "001a11", power: "on", seenMs: 0 };
// what a Switch dock looks like over USB: close to Linux
const linuxLike = { os: "linux" as const, trace: "D D C0 C0 S00 C0 C0 S00 S01 S02 S03" };

test("a Nintendo source over CEC is a Switch, whatever USB says", () => {
  assert.deepEqual(targetKind(linuxLike, sw), { kind: "switch", from: "cec" });
  assert.deepEqual(targetKind(null, sw), { kind: "switch", from: "cec" });
  assert.deepEqual(targetKind(null, { ...sw, vendor: undefined }), { kind: "switch", from: "cec" });
});

test("a Steam Deck in its dock names itself over CEC", () => {
  assert.deepEqual(targetKind(linuxLike, deck), { kind: "steamdeck", from: "cec" });
  assert.deepEqual(targetKind(linuxLike, { ...deck, vendor: undefined }), { kind: "steamdeck", from: "cec" });
  assert.deepEqual(targetKind(linuxLike, { ...deck, name: "" }), { kind: "steamdeck", from: "cec" });
});

test("a Mi TV Stick is Android by its CEC name", () => {
  const stick = { la: 4, name: "Mi TV Stick", type: "playback", vendor: "00ec0a", power: "on", seenMs: 0 };
  assert.deepEqual(targetKind(null, stick), { kind: "android", from: "cec" });
  assert.deepEqual(targetKind(linuxLike, { ...stick, name: "Mi Soundbar" }), { kind: "linux", from: "usb" });
});

test("anything else keeps the USB guess", () => {
  assert.deepEqual(targetKind(linuxLike, tv), { kind: "linux", from: "usb" });
  assert.deepEqual(targetKind(linuxLike, null), { kind: "linux", from: "usb" });
  assert.deepEqual(targetKind(null, null), { kind: "unknown", from: "usb" });
});

test("a source known only over CEC is shown by its CEC name", () => {
  assert.deepEqual(targetKind(null, tv), { kind: "unknown", from: "cec" });
  assert.deepEqual(targetKind({ os: "unknown", trace: "" }, tv), { kind: "unknown", from: "cec" });
  assert.deepEqual(targetKind(null, { ...tv, name: "" }), { kind: "unknown", from: "usb" });
});
