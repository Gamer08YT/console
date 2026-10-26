/*
 * Where the frame actually sits inside the element that shows it.
 *
 * Both sizing modes letterbox: the element fills the stage and the picture sits
 * inside it, so everything that has to line up with the picture - the pointer
 * mapping, the selectable text layer, the engaged outline - must work from the
 * frame's own size, not from the element's box.
 *
 * Reading that size is where this went wrong (#32). A canvas carries the frame
 * in `width`/`height`, the backing store. An `<img>` has those two properties
 * as well, but on an image they are the RENDERED size - so asking for `width`
 * first quietly answers "the element box" for the MJPEG stream, the padding
 * comes out as zero, and the pointer maps into the black bars. On a 4K screen
 * with a 1080p target that is two cursors drifting apart, and it looks like a
 * pointer bug rather than a measurement one. `naturalWidth` is the frame, and
 * only an image has it, so it is asked for first.
 */

export interface Intrinsic {
  w: number;
  h: number;
}

export interface Box {
  width: number;
  height: number;
}

export interface Letterbox {
  /** The picture's size on screen, in CSS pixels. */
  width: number;
  height: number;
  /** The black bars: how far the picture starts from the element's edge. */
  padX: number;
  padY: number;
}

/** The frame's own size: an image's natural size, a canvas's backing store. */
export function intrinsicSize(el: unknown): Intrinsic | null {
  const img = el as { naturalWidth?: number; naturalHeight?: number };
  if (typeof img.naturalWidth === "number" && img.naturalWidth > 0) {
    return { w: img.naturalWidth, h: img.naturalHeight ?? 0 };
  }
  const canvas = el as { width?: number; height?: number };
  if (typeof canvas.width === "number" && canvas.width > 0) {
    return { w: canvas.width, h: canvas.height ?? 0 };
  }
  return null;
}

/**
 * Fit @p of into @p box the way the CSS does: `object-fit: contain` when the
 * picture may grow, `scale-down` when it may not. @p alignY is where the spare
 * height goes, as `object-position` puts it: 0 top, 0.5 centre, 1 bottom.
 */
export function letterbox(box: Box, of: Intrinsic, grow: boolean, alignY = 0.5): Letterbox {
  const scale = grow
    ? Math.min(box.width / of.w, box.height / of.h)
    : Math.min(1, box.width / of.w, box.height / of.h);
  const width = of.w * scale;
  const height = of.h * scale;
  return { width, height, padX: (box.width - width) / 2, padY: (box.height - height) * alignY };
}

/** The vertical part of an `object-position` as computed ("50% 0%"), 0..1. */
export function objectAlignY(position: string | undefined): number {
  const y = position?.trim().split(/\s+/)[1];
  if (!y?.endsWith("%")) return 0.5;
  const v = Number.parseFloat(y) / 100;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

export type FitMode = "fit" | "stretch" | "actual";

/** The element's box, plus where the picture is inside it. */
export function pictureRect(
  el: HTMLElement,
  fit: FitMode,
): (Letterbox & { rect: DOMRect }) | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const size = intrinsicSize(el) ?? { w: rect.width, h: rect.height };
  if (size.w <= 0 || size.h <= 0) return null;
  /* On a phone held upright the picture sits at the top (layout.css): read
     where the CSS put it rather than assume the centre. */
  const alignY = objectAlignY(getComputedStyle(el).objectPosition);
  return { rect, ...letterbox(rect, size, fit === "stretch", alignY) };
}
