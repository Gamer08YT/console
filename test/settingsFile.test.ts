/*
 * Settings files: what a device hands over, and what it refuses to take back.
 *
 * The rules here are the ones somebody only notices when they are wrong - two
 * boxes ending up with one hostname, a file that quietly writes a pin setting
 * from another board - so they are pinned down rather than re-read.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  FILE_KIND,
  FILE_VERSION,
  IDENTITY_KEYS,
  buildFile,
  fileName,
  planImport,
  readFile,
} from "../src/state/settingsFile.ts";
import type { Setting } from "../src/state/device.ts";

const schema: Setting[] = [
  { key: "net_hostname", type: "string", section: "network", label: "Hostname" },
  { key: "vid_fps", type: "int", section: "video", label: "Frame rate" },
  { key: "mqtt_pass", type: "string", section: "mqtt", label: "Password", secret: true },
  { key: "disp_sclk", type: "int", section: "display", label: "Display clock pin" },
] as unknown as Setting[];

const values = { net_hostname: "espkvm1", vid_fps: 30, disp_sclk: 7 };

test("a file says what it is, and carries no secrets", () => {
  const file = buildFile({ ...values, mqtt_pass: "hunter2" }, schema, { firmware: "v.0.36.0", board: "p4-eth" });
  assert.equal(file.kind, FILE_KIND);
  assert.equal(file.version, FILE_VERSION);
  assert.equal(file.board, "p4-eth");
  assert.equal(file.values.mqtt_pass, undefined, "a secret must never reach the file");
  assert.equal(file.values.vid_fps, 30);
});

test("the name says which device and when", () => {
  const name = fileName("p4-eth", new Date("2026-08-25T10:20:30Z"));
  assert.match(name, /p4-eth/);
  assert.match(name, /2026-08-25/);
  assert.match(name, /\.json$/);
});

test("something that is not one of our files is refused, not guessed at", () => {
  assert.throws(() => readFile("{}"));
  assert.throws(() => readFile("not json at all"));
  assert.throws(() => readFile(JSON.stringify({ kind: "something-else", version: 1, values: {} })));
});

test("identity is held back, because two devices must not share a name", () => {
  const file = buildFile({ ...values, net_hostname: "espkvm2" }, schema, { firmware: "v.0.36.0", board: "p4-eth" });
  const plan = planImport(file, schema, values, { board: "p4-eth" });
  assert.deepEqual(plan.identity, ["net_hostname"]);
  assert.equal(plan.apply.net_hostname, undefined);
  for (const key of IDENTITY_KEYS) {
    assert.equal(plan.apply[key], undefined);
  }
});

test("asked for it, identity is applied like anything else", () => {
  const file = buildFile({ ...values, net_hostname: "espkvm2" }, schema, { firmware: "v.0.36.0", board: "p4-eth" });
  const plan = planImport(file, schema, values, { board: "p4-eth", withIdentity: true });
  assert.equal(plan.apply.net_hostname, "espkvm2");
  assert.deepEqual(plan.identity, []);
});

test("what is already set is not written again", () => {
  const file = buildFile(values, schema, { firmware: "v.0.36.0", board: "p4-eth" });
  const plan = planImport(file, schema, values, { board: "p4-eth" });
  assert.deepEqual(plan.apply, {});
  assert.ok(plan.same.includes("vid_fps"));
});

test("a key this firmware does not know is named, not applied", () => {
  const file = { ...buildFile(values, schema, { firmware: "v.0.36.0", board: "p4-eth" }) };
  file.values = { ...file.values, from_the_future: 1 };
  const plan = planImport(file, schema, values, { board: "p4-eth" });
  assert.ok(plan.unknown.includes("from_the_future"));
  assert.equal(plan.apply.from_the_future, undefined);
});

test("a file from another board says so, since its pins may not fit", () => {
  const file = buildFile(values, schema, { firmware: "v.0.36.0", board: "funcev" });
  const plan = planImport(file, schema, values, { board: "p4-eth" });
  assert.equal(plan.otherBoard, true);
  const same = planImport(file, schema, values, { board: "funcev" });
  assert.equal(same.otherBoard, false);
});

test("the secrets this device has are named, so nobody waits for a VPN that cannot come up", () => {
  const file = buildFile(values, schema, { firmware: "v.0.36.0", board: "p4-eth" });
  const plan = planImport(file, schema, values, { board: "p4-eth" });
  assert.deepEqual(plan.secrets, ["mqtt_pass"]);
});

const profSchema: Setting[] = [
  ...schema,
  { key: "mouse_mode", type: "enum", section: "input", label: "Pointer", profile: true },
  { key: "ptr_desk_w", type: "int", section: "input", label: "Desktop width", profile: true },
] as unknown as Setting[];

test("device profiles travel with the file, Default stays out of the list", () => {
  const file = buildFile(values, profSchema, {
    profiles: [
      { id: 0, name: "Default" },
      { id: 1, name: "Steam Deck", match: { cecName: "Steam Deck", cecVendor: "", usbOs: "" }, set: { mouse_mode: 1 } },
    ],
  });
  assert.deepEqual(file.profiles, [
    { name: "Steam Deck", match: { cecName: "Steam Deck", cecVendor: "", usbOs: "" }, set: { mouse_mode: 1 } },
  ]);
  assert.equal(buildFile(values, profSchema, { profiles: [{ id: 0, name: "Default" }] }).profiles, undefined);
});

test("an imported profile keeps only what a profile may hold here", () => {
  const file = readFile(
    JSON.stringify({
      kind: FILE_KIND,
      version: FILE_VERSION,
      values: {},
      profiles: [{ name: "Deck", set: { mouse_mode: 1, ptr_desk_w: 0, net_hostname: "x", gone: 1 } }, { set: {} }],
    }),
  );
  const plan = planImport(file, profSchema, values);
  assert.deepEqual(plan.profiles, [{ name: "Deck", match: undefined, set: { mouse_mode: 1 } }]);
  const withId = planImport(file, profSchema, values, { withIdentity: true });
  assert.deepEqual(withId.profiles[0].set, { mouse_mode: 1, ptr_desk_w: 0 });
});

test("a file from before profiles plans as it always did", () => {
  const file = readFile(JSON.stringify({ kind: FILE_KIND, version: 1, values: { vid_fps: 60 } }));
  const plan = planImport(file, profSchema, values);
  assert.deepEqual(plan.apply, { vid_fps: 60 });
  assert.deepEqual(plan.profiles, []);
});
