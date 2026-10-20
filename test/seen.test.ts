import { test } from "node:test";
import assert from "node:assert/strict";

import { seenUrl, SEEN_URL } from "../src/state/seen.ts";

const ID = "0123456789abcdef0123456789abcdef";

test("the project's own manifest is counted", () => {
  const u = seenUrl("https://fw.espkvm.io/firmware/funcev/manifest.json", ID, "funcev", "v.0.67.0");
  assert.equal(u, `${SEEN_URL}?id=${ID}&board=funcev&ver=v.0.67.0`);
});

test("a fork, a bad id or a broken url is not", () => {
  assert.equal(seenUrl("https://example.com/manifest.json", ID, "funcev", "v1"), null);
  assert.equal(seenUrl("https://fw.espkvm.io/firmware/manifest.json", undefined, "x", "v1"), null);
  assert.equal(seenUrl("https://fw.espkvm.io/firmware/manifest.json", "ABC", "x", "v1"), null);
  assert.equal(seenUrl("not a url", ID, "x", "v1"), null);
});
