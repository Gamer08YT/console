/*
 * Just enough MPEG-TS to play the device's recordings: find the H.264 stream,
 * and the AAC one when the recording has sound, and hand back one access unit
 * per PES packet, with its PTS.
 *
 * The recorder writes one frame per PES packet, so a PES packet is a frame. The
 * input can start anywhere - a seek fetches from the middle of a file - so the
 * demuxer finds the packet boundary itself, and learns the video PID from the
 * PMT or, if it has not seen one yet, from the first video PES header.
 */

export const TS_PACKET = 188;
const SYNC = 0x47;

export interface AccessUnit {
  /** 90 kHz presentation time. */
  pts: number;
  data: Uint8Array;
  /** An AAC frame with its ADTS header, not a picture. */
  audio?: boolean;
}

/* One PID's PES packet being gathered. */
class Gather {
  parts: Uint8Array[] = [];
  len = 0;
  add(p: Uint8Array): void {
    this.parts.push(p.slice());
    this.len += p.length;
  }
  take(): Uint8Array | null {
    if (!this.parts.length) return null;
    const pes = new Uint8Array(this.len);
    let at = 0;
    for (const part of this.parts) {
      pes.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.len = 0;
    return pes;
  }
}

/* PTS from a PES header, or null if it has none. Wants the PES bytes from 00 00 01. */
function pesPts(pes: Uint8Array): number | null {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null;
  if ((pes[7] & 0x80) === 0) return null;
  /* 33 bits: stay in doubles, not 32-bit bit ops. */
  return (
    ((pes[9] >> 1) & 0x07) * 2 ** 30 +
    (pes[10] << 22) +
    ((pes[11] >> 1) << 15) +
    (pes[12] << 7) +
    (pes[13] >> 1)
  );
}

export class TsDemuxer {
  #carry = new Uint8Array(0);
  #pmtPid = -1;
  #videoPid = -1;
  #audioPid = -1;
  #video = new Gather();
  #audio = new Gather();

  /** Forget everything: the next bytes come from somewhere else in the file. */
  reset(): void {
    this.#carry = new Uint8Array(0);
    this.#video = new Gather();
    this.#audio = new Gather();
  }

  /** Feed bytes; returns the frames completed by them. */
  push(bytes: Uint8Array): AccessUnit[] {
    let buf = bytes;
    if (this.#carry.length) {
      buf = new Uint8Array(this.#carry.length + bytes.length);
      buf.set(this.#carry);
      buf.set(bytes, this.#carry.length);
    }
    const out: AccessUnit[] = [];
    let i = 0;
    while (i + TS_PACKET <= buf.length) {
      /* In sync when this byte and the next packet's both say so. */
      if (buf[i] !== SYNC || (i + 2 * TS_PACKET <= buf.length && buf[i + TS_PACKET] !== SYNC)) {
        i++;
        continue;
      }
      this.#packet(buf.subarray(i, i + TS_PACKET), out);
      i += TS_PACKET;
    }
    this.#carry = buf.slice(i);
    return out;
  }

  /** The frame still being collected, at the end of the input. */
  flush(): AccessUnit[] {
    const out: AccessUnit[] = [];
    this.#finish(this.#video, false, out);
    this.#finish(this.#audio, true, out);
    return out;
  }

  #packet(p: Uint8Array, out: AccessUnit[]): void {
    const start = (p[1] & 0x40) !== 0;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const afc = (p[3] >> 4) & 0x3;
    let off = 4;
    if (afc === 2 || afc === 0) return; /* no payload */
    if (afc === 3) off += 1 + p[4];
    if (off >= TS_PACKET) return;
    const payload = p.subarray(off);

    if (pid === 0) {
      if (start) this.#pat(payload);
      return;
    }
    if (pid === this.#pmtPid) {
      if (start) this.#pmt(payload);
      return;
    }
    if (start && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
      const streamId = payload[3];
      if (this.#videoPid < 0 && streamId >= 0xe0 && streamId <= 0xef) this.#videoPid = pid;
      if (this.#audioPid < 0 && streamId >= 0xc0 && streamId <= 0xdf) this.#audioPid = pid;
    }
    const audio = pid === this.#audioPid;
    if (pid !== this.#videoPid && !audio) return;
    const g = audio ? this.#audio : this.#video;

    if (start) {
      this.#finish(g, audio, out);
    } else if (!g.parts.length) {
      return; /* the middle of a frame whose start was not seen */
    }
    g.add(payload);
  }

  #finish(g: Gather, audio: boolean, out: AccessUnit[]): void {
    const pes = g.take();
    if (!pes) return;
    const pts = pesPts(pes);
    if (pts === null) return;
    const headerEnd = 9 + pes[8];
    let end = pes.length;
    if (audio) {
      /* An audio PES has a length; what follows it in its last packet is filler. */
      end = Math.min(end, 6 + ((pes[4] << 8) | pes[5]));
    }
    if (headerEnd < end) {
      out.push({ pts, data: pes.subarray(headerEnd, end), audio: audio || undefined });
    }
  }

  /* A section starts after the pointer field. */
  #pat(payload: Uint8Array): void {
    const s = payload.subarray(1 + payload[0]);
    const len = ((s[1] & 0x0f) << 8) | s[2];
    for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
      const program = (s[i] << 8) | s[i + 1];
      if (program !== 0) {
        this.#pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
        return;
      }
    }
  }

  #pmt(payload: Uint8Array): void {
    const s = payload.subarray(1 + payload[0]);
    const len = ((s[1] & 0x0f) << 8) | s[2];
    const infoLen = ((s[10] & 0x0f) << 8) | s[11];
    for (let i = 12 + infoLen; i + 5 <= 3 + len - 4; ) {
      const type = s[i];
      const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
      const esInfo = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
      if (type === 0x1b) this.#videoPid = pid;
      if (type === 0x0f) this.#audioPid = pid;
      i += 5 + esInfo;
    }
  }
}

/** The largest PTS in a stretch of a TS file: the tail gives the duration. */
export function lastPts(bytes: Uint8Array): number | null {
  const d = new TsDemuxer();
  let last: number | null = null;
  for (const au of [...d.push(bytes), ...d.flush()]) {
    if (!au.audio && (last === null || au.pts > last)) last = au.pts;
  }
  return last;
}
