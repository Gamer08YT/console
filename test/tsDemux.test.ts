import assert from "node:assert/strict";
import { test } from "node:test";

import { TS_PACKET, TsDemuxer, lastPts } from "../src/video/tsDemux.ts";

/* A tiny transport stream: PAT, PMT (H.264 on PID 0x100), then one PES per frame. */
function packet(pid: number, start: boolean, payload: Uint8Array): Uint8Array {
  const p = new Uint8Array(TS_PACKET).fill(0xff);
  p[0] = 0x47;
  p[1] = (start ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  const room = TS_PACKET - 4;
  if (payload.length >= room) {
    p[3] = 0x10;
    p.set(payload.subarray(0, room), 4);
  } else {
    /* adaptation field stuffing in front of a short payload */
    const af = room - payload.length - 1;
    p[3] = 0x30;
    p[4] = af;
    if (af > 0) p[5] = 0;
    p.set(payload, 4 + 1 + af);
  }
  return p;
}

function section(bytes: number[]): Uint8Array {
  return new Uint8Array([0, ...bytes, 0, 0, 0, 0]);
}

function stream(frames: { pts: number; data: number[]; audio?: boolean }[]): Uint8Array {
  const out: Uint8Array[] = [];
  /* PAT: program 1 -> PMT PID 0x1000; section_length = 13 */
  out.push(packet(0, true, section([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00])));
  /* PMT: PCR PID 0x100, one stream type 0x1b on 0x100; section_length = 18 */
  out.push(
    packet(0x1000, true, section([0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0, 0x1b, 0xe1, 0x00, 0xf0, 0])),
  );
  for (const f of frames) {
    const p = f.pts;
    /* Audio has a PES length, as the recorder writes it; video has none. */
    const len = f.audio ? 8 + f.data.length : 0;
    const pes = new Uint8Array([
      0, 0, 1, f.audio ? 0xc0 : 0xe0, len >> 8, len & 0xff, 0x80, 0x80, 5,
      0x21 | ((Math.floor(p / 2 ** 30) & 7) << 1),
      (p >> 22) & 0xff,
      (((p >> 15) & 0x7f) << 1) | 1,
      (p >> 7) & 0xff,
      ((p & 0x7f) << 1) | 1,
      ...f.data,
    ]);
    for (let at = 0; at < pes.length; at += TS_PACKET - 4) {
      out.push(packet(f.audio ? 0x101 : 0x100, at === 0, pes.subarray(at, at + TS_PACKET - 4)));
    }
  }
  const all = new Uint8Array(out.length * TS_PACKET);
  out.forEach((p, i) => all.set(p, i * TS_PACKET));
  return all;
}

const big = Array.from({ length: 500 }, (_, i) => i & 0xff);
const ts = stream([
  { pts: 63000, data: [0, 0, 0, 1, 0x65, 1, 2, 3] },
  { pts: 66600, data: big },
  { pts: 70200, data: [0, 0, 0, 1, 0x41, 9] },
]);

test("frames and times come out whole, fed in odd pieces", () => {
  const d = new TsDemuxer();
  const got = [];
  for (let i = 0; i < ts.length; i += 100) got.push(...d.push(ts.subarray(i, i + 100)));
  got.push(...d.flush());
  assert.deepEqual(
    got.map((a) => a.pts),
    [63000, 66600, 70200],
  );
  assert.deepEqual([...got[0].data], [0, 0, 0, 1, 0x65, 1, 2, 3]);
  assert.deepEqual([...got[1].data], big);
});

test("starting mid-file skips the cut frame and finds the rest", () => {
  const d = new TsDemuxer();
  /* From inside the second frame, off the packet boundary, with no PAT or PMT. */
  const got = [...d.push(ts.subarray(3 * TS_PACKET + 77)), ...d.flush()];
  assert.deepEqual(
    got.map((a) => a.pts),
    [70200],
  );
  assert.equal(lastPts(ts), 70200);
});

test("sound comes out as its own frames, and does not count for the length", () => {
  const adts = [0xff, 0xf1, 0x4c, 0x80, 0x01, 0x3f, 0xfc, 7, 7];
  const av = stream([
    { pts: 63000, data: [0, 0, 0, 1, 0x65, 1] },
    { pts: 63900, data: adts, audio: true },
    { pts: 66600, data: [0, 0, 0, 1, 0x41, 2] },
    { pts: 65820, data: adts, audio: true },
    { pts: 70200, data: [0, 0, 0, 1, 0x41, 3] },
    { pts: 99000, data: adts, audio: true },
  ]);
  const d = new TsDemuxer();
  const got = [...d.push(av), ...d.flush()];
  const sound = got.filter((a) => a.audio);
  assert.deepEqual(
    got.filter((a) => !a.audio).map((a) => a.pts),
    [63000, 66600, 70200],
  );
  assert.deepEqual(
    sound.map((a) => a.pts),
    [63900, 65820, 99000],
  );
  /* the frame, header and all, nothing more */
  assert.deepEqual([...sound[0].data], adts);
  assert.equal(lastPts(av), 70200);
});
