/*
 * Where the picture sits inside its element. Getting this wrong does not look
 * like a measurement bug: the pointer lands somewhere other than where it was
 * clicked, and the operator sees two cursors drifting apart (#32).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { intrinsicSize, letterbox, objectAlignY } from "../src/video/picture.ts";

/* What an <img> showing a 1080p stream looks like in a window that is not 16:9:
   the element fills the stage, and `width`/`height` are the RENDERED size. */
const streamImg = { naturalWidth: 1920, naturalHeight: 1080, width: 1800, height: 1500 };
/* A canvas carries the frame in width/height and has no natural size. */
const streamCanvas = { width: 1920, height: 1080 };

test("an image reports the frame, not the box it is drawn in", () => {
  assert.deepEqual(intrinsicSize(streamImg), { w: 1920, h: 1080 });
});

test("a canvas reports its backing store", () => {
  assert.deepEqual(intrinsicSize(streamCanvas), { w: 1920, h: 1080 });
});

test("an element with neither is unknown", () => {
  assert.equal(intrinsicSize({}), null);
  assert.equal(intrinsicSize({ naturalWidth: 0, width: 0 }), null);
});

test("a tall window letterboxes top and bottom, and nothing sideways", () => {
  const box = { width: 1800, height: 1500 };
  const p = letterbox(box, { w: 1920, h: 1080 }, false);
  assert.equal(Math.round(p.width), 1800);
  assert.equal(Math.round(p.height), 1013); /* 1080 * 1800/1920 */
  assert.equal(p.padX, 0);
  assert.ok(p.padY > 240 && p.padY < 245, `padY ${p.padY}`);
});

test("fit never enlarges: a small target sits in the middle of a big stage", () => {
  const p = letterbox({ width: 3000, height: 2000 }, { w: 1024, h: 768 }, false);
  assert.equal(p.width, 1024);
  assert.equal(p.height, 768);
  assert.equal(p.padX, (3000 - 1024) / 2);
  assert.equal(p.padY, (2000 - 768) / 2);
});

test("stretch fills the stage on one axis", () => {
  const p = letterbox({ width: 3000, height: 2000 }, { w: 1024, h: 768 }, true);
  assert.equal(p.height, 2000); /* height-limited: 2000/768 < 3000/1024 */
  assert.ok(p.padY === 0 && p.padX > 0);
});

test("a matching aspect has no bars at all", () => {
  const p = letterbox({ width: 1280, height: 720 }, { w: 1920, h: 1080 }, false);
  assert.equal(p.padX, 0);
  assert.equal(p.padY, 0);
  assert.equal(p.width, 1280);
});

/*
 * The regression itself: reading `width` before `naturalWidth` answers with the
 * element box, the padding comes out zero, and every click lands wrong on a
 * window that is not the target's aspect.
 */
test("#32: a 1080p stream in a 1800x1500 window is not mapped against the box", () => {
  const size = intrinsicSize(streamImg);
  assert.ok(size);
  const p = letterbox({ width: 1800, height: 1500 }, size, false);
  assert.notEqual(p.height, 1500, "the picture is not as tall as the element");
  assert.ok(p.padY > 0, "there are bars to skip past");

  /* A quarter of the way down the element is much less than a quarter of the
     way down the picture: the bars above it are not part of it. Mapping
     against the box is what put the two cursors in different places. */
  const clickY = 1500 * 0.25;
  const inPicture = (clickY - p.padY) / p.height;
  const againstTheBox = clickY / 1500;
  assert.ok(
    inPicture < againstTheBox - 0.1,
    `picture ${inPicture.toFixed(3)} vs box ${againstTheBox.toFixed(3)}`,
  );

  /* And a click in the bar itself is off the picture, so it is no click. */
  assert.ok((100 - p.padY) / p.height < 0);
});

test("a picture at the top of a tall box has all the spare height under it", () => {
  const p = letterbox({ width: 390, height: 700 }, { w: 1280, h: 720 }, true, 0);
  assert.equal(p.padY, 0);
  assert.equal(Math.round(p.height), 219);
});

test("object-position as computed gives the vertical alignment", () => {
  assert.equal(objectAlignY("50% 0%"), 0);
  assert.equal(objectAlignY("50% 50%"), 0.5);
  assert.equal(objectAlignY("50% 100%"), 1);
  assert.equal(objectAlignY("50% 12px"), 0.5);
  assert.equal(objectAlignY(""), 0.5);
  assert.equal(objectAlignY(undefined), 0.5);
});
