// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Everything the name plate puts on a canvas.
 *
 * Split from the renderer so that the module holding the layout DECISIONS is not
 * also the module holding several hundred lines of fillRect. Nothing here decides
 * what a sign says; it is handed strings, sizes and colours.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { Theme } from "@/lib/theme";
import { drawQrMatrix } from "./booking-qr";
import type { NameRanks } from "./name-split";
import type { BandContent, Rect } from "./name-plate-layout";
import { fitSharedSize } from "./name-plate-layout";
import {
  CAP_RATIO,
  ROW_NAME_GAP,
  measureAt,
  type BandColors,
  type BandSizes,
  type TypeCtx,
} from "./name-plate-scale";

/**
 * Draw one line from its left edge, with `baseline` as its baseline.
 *
 * Left, everywhere, and that is a decision rather than a default. Four centred
 * names are four different line lengths with no shared edge, so the eye has to
 * find the start of each one; against a fixed left axis it returns to the same
 * place every time and the plate reads as a list. The cost is that a single name
 * on a wide panel no longer sits in the middle, which is the price of having one
 * layout instead of two.
 */
export function drawLeft(
  t: TypeCtx,
  text: string,
  x: number,
  baseline: number,
  size: number,
  color: string,
  bold: boolean,
  maxWidth: number,
  /** Overrides the body family, for the surname rank when it is set narrow. */
  family = t.ff
): void {
  t.ctx.font = `${bold ? "bold " : ""}${size}px "${family}"`;
  t.ctx.fillStyle = color;
  t.ctx.textAlign = "left";
  t.ctx.textBaseline = "alphabetic";
  t.ctx.fillText(text, x, baseline, maxWidth);
}

/**
 * The state, as a filled block with the word inside it.
 *
 * A filled area is the only device that survives the distance at which the word
 * itself has stopped being legible, which is the whole argument for it: from ten
 * metres a person sees THAT the desk is taken, and from two they read until when.
 * Only an occupied seat gets one, so absence means free.
 *
 * Beside the name rather than under it, so it costs width and no height.
 */
export function drawPill(
  t: TypeCtx,
  right: number,
  centerY: number,
  text: string,
  size: number,
  colors: BandColors
): void {
  const padX = Math.round(size * 0.55);
  const padY = Math.round(size * 0.34);
  const w = Math.round(measureAt(t, text, size) + padX * 2);
  const h = Math.round(size * CAP_RATIO + padY * 2);
  const x = Math.round(right - w);
  const y = Math.round(centerY - h / 2);

  t.ctx.fillStyle = colors.pillBg;
  t.ctx.fillRect(x, y, w, h);
  drawLeft(
    t,
    text,
    x + padX,
    Math.round(y + padY + size * CAP_RATIO),
    size,
    colors.pillText,
    true,
    w
  );
}

/**
 * A seat as a STACK: up to five lines, smallest ranks outward.
 *
 * Used where there is vertical room, which in practice is one or two seats. The
 * block is centred vertically in the band, so a two-line band and a five-line one
 * both sit optically in the middle of their share, and nothing reserves space for
 * a line it does not draw.
 */
export function drawStack(
  t: TypeCtx,
  band: Rect,
  content: BandContent,
  sizes: BandSizes,
  colors: BandColors,
  stackWidth: number
): void {
  const lines: { text: string; size: number; color: string; bold: boolean; family: string }[] = [];
  const push = (text: string, size: number, color: string, bold: boolean, family = t.ff) =>
    lines.push({ text, size, color, bold, family });

  if (content.caption) push(content.caption, sizes.secondary, colors.secondary, false);
  if (content.ranks) {
    /* Three ranks, smallest first. The surname is the payload and gets the whole
     * width; the titles and the given name are what used to consume it. */
    if (content.ranks.titles) push(content.ranks.titles, sizes.secondary, colors.secondary, false);
    if (content.ranks.given) push(content.ranks.given, sizes.given, colors.name, false);
    /* The one rank that may change face. Everything around it stays in the body
     * family, so the shift reads as hierarchy rather than as a second design. */
    push(content.ranks.surname, sizes.surname, colors.name, true, sizes.surnameFamily);
  } else if (content.notice) {
    /* Light weight, never bold: a statement about the sign is not a name, and the
     * weight is what says so before the size does. */
    push(content.notice, sizes.notice, colors.secondary, false);
  }
  if (content.affiliation) push(content.affiliation, sizes.secondary, colors.secondary, false);
  if (lines.length === 0) return;

  /* Tight, because the caption, the titles, the given name and the affiliation
   * all belong to the surname they surround rather than to the neighbouring band.
   * Proximity is the only thing grouping them, so these gaps stay clearly smaller
   * than the space between bands.
   *
   * One gap PER PAIR, not one for the block. The base is measured off the surname,
   * which is large enough to clear a caption's descender: laid out in cap heights,
   * a caption ending in ")" or "," hangs below its own box and used to collide
   * with the cap of the line beneath it.
   *
   * That base is not enough UNDER the surname. A descender reaches roughly 0.21 em
   * below its baseline, which at 0.14 of the surname is more than the whole gap,
   * so "Krüger" would have run into the unit line below it. Taking the larger of
   * the two clearances fixes that pair and leaves every other pair exactly where
   * it was, because 0.3 of a caption is smaller than 0.14 of the surname. */
  const baseGap = Math.round(sizes.surname * 0.14);
  const gapAfter = (size: number) => Math.max(baseGap, Math.round(size * 0.3));
  const capHeights = lines.map((l) => l.size * CAP_RATIO);
  const gaps = lines.slice(0, -1).map((l) => gapAfter(l.size));
  const blockH = capHeights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);

  let y = band.y + (band.h - blockH) / 2;
  lines.forEach((line, i) => {
    /* y is the cap TOP of this line, so the baseline sits one cap height below. */
    drawLeft(
      t,
      line.text,
      band.x,
      Math.round(y + capHeights[i]),
      line.size,
      line.color,
      line.bold,
      stackWidth,
      line.family
    );
    y += capHeights[i] + (gaps[i] ?? 0);
  });
}

/**
 * A seat as a ROW: the seat label in a gutter, the name on one line beside it.
 *
 * Used from three seats up, where the stack stops working. The arithmetic is
 * blunt about why. On a 7.5" panel four bands are 61 px tall, a five-line stack
 * needs 2.41 surname-sizes, and the surname therefore lands at 22 px, or 3,2 mm of
 * cap height: a sign readable from 65 cm. One line at the same height reaches
 * three times that, because a short surname leaves horizontal room exactly where
 * the vertical room has run out.
 *
 * What is dropped is dropped deliberately, not for lack of a place to put it: the
 * titles and the affiliation. Fitting them in would halve the surname, which is
 * the one trade this whole design refuses. An operator who needs a unit or a
 * position on the sign is describing a plate with one or two seats.
 */
export function drawRow(
  t: TypeCtx,
  band: Rect,
  content: BandContent,
  sizes: BandSizes,
  colors: BandColors,
  gutterW: number,
  nameWidth: number
): void {
  const centerY = band.y + band.h / 2;
  if (content.caption && gutterW > 0) {
    drawLeft(
      t,
      content.caption,
      band.x,
      Math.round(centerY + sizes.secondary * CAP_RATIO * 0.5),
      sizes.secondary,
      colors.secondary,
      false,
      gutterW
    );
  }

  const x = band.x + gutterW;
  if (content.ranks) {
    drawRowName(t, content.ranks, x, centerY, sizes, colors, nameWidth);
  } else if (content.notice) {
    drawLeft(
      t,
      content.notice,
      x,
      Math.round(centerY + sizes.notice * CAP_RATIO * 0.5),
      sizes.notice,
      colors.secondary,
      false,
      nameWidth
    );
  }
}

/** The surname, and the given name baseline-aligned beside it. */
export function drawRowName(
  t: TypeCtx,
  ranks: NameRanks,
  x: number,
  centerY: number,
  sizes: BandSizes,
  colors: BandColors,
  nameWidth: number
): void {
  const baseline = Math.round(centerY + sizes.surname * CAP_RATIO * 0.5);
  drawLeft(
    t,
    ranks.surname,
    x,
    baseline,
    sizes.surname,
    colors.name,
    true,
    nameWidth,
    sizes.surnameFamily
  );
  if (!ranks.given) return;
  /* The size search measured exactly this composition, surname plus gap plus
   * given name at its fraction, so the two cannot collide. */
  const gx =
    x +
    measureAt(t, ranks.surname, sizes.surname, true, sizes.surnameFamily) +
    Math.round(sizes.surname * ROW_NAME_GAP);
  drawLeft(
    t,
    ranks.given,
    gx,
    baseline,
    sizes.given,
    colors.name,
    false,
    Math.max(0, x + nameWidth - gx)
  );
}

/**
 * A rule between bands.
 *
 * Without it a four-seat plate is a dozen lines whose grouping the reader has to
 * infer from spacing alone, and spacing alone was not enough: a caption sat about
 * as far from its own name as from the name above it.
 *
 * Two pixels minimum, not one. A 1-bit e-paper panel reaches roughly ten to one
 * in contrast rather than twenty-one, so a single-pixel rule is materially
 * fainter on the wall than in any preview, and on the two 7-inch panels the old
 * `scale` arithmetic rounded to exactly one.
 */
export function drawSeparators(
  ctx: SKRSContext2D,
  bands: Rect[],
  color: string,
  scale: number
): void {
  if (bands.length < 2) return;
  const thickness = Math.max(2, Math.round(2 * scale));
  ctx.fillStyle = color;
  for (let i = 1; i < bands.length; i++) {
    const y = Math.round((bands[i - 1].y + bands[i - 1].h + bands[i].y) / 2);
    ctx.fillRect(bands[i].x, y, bands[i].w, thickness);
  }
}

/* ── Renderer ─────────────────────────────────────────────────── */

/**
 * Header accents, as exact palette entries plus the text colour that survives on
 * each.
 *
 * The values are the panel's pixel codes, not what the eye sees: a Spectra 6
 * panel renders "green" as a mid-dark pigment and "red" as a brick, so white text
 * holds on both even though `#00FF00` in a preview suggests otherwise. Yellow is
 * light as a code AND as a pigment, so it is the one accent that takes dark text.
 */
export const ACCENTS: Record<string, { bg: string; fg: string }> = {
  red: { bg: "#FF0000", fg: "#FFFFFF" },
  blue: { bg: "#0000FF", fg: "#FFFFFF" },
  green: { bg: "#00FF00", fg: "#FFFFFF" },
  yellow: { bg: "#FFFF00", fg: "#000000" },
};

/** The header bar: the place, and optionally its class as a colour. */
export function drawHeader(
  t: TypeCtx,
  room: string,
  geom: { width: number; headerH: number; pad: number; scale: number },
  bg: string,
  fg: string
): void {
  const { width, headerH, pad, scale } = geom;
  t.ctx.fillStyle = bg;
  t.ctx.fillRect(0, 0, width, headerH);
  const roomWidth = width - pad * 2;
  const roomSize = fitSharedSize({
    texts: [room],
    maxWidth: roomWidth,
    maxHeight: Math.round(headerH * 0.42),
    measure: (text, size) => measureAt(t, text, size),
    min: 12,
    max: Math.round(34 * scale),
  });
  drawLeft(
    t,
    room,
    pad,
    Math.round(headerH / 2 + roomSize * CAP_RATIO * 0.5),
    roomSize,
    fg,
    true,
    roomWidth
  );
}

/**
 * The booking code and its label, bottom right of the band area.
 *
 * Inside the width `render` already reserved for it, so nothing has to move. The
 * label is centred under the MATRIX rather than under the reserved box: the matrix
 * is the box rounded down to whole modules, so the two differ by up to a module
 * and a left-aligned label reads as misplaced.
 */
export function drawQrPanel(
  t: TypeCtx,
  url: string,
  label: string,
  labelColor: string,
  geom: {
    width: number;
    height: number;
    pad: number;
    footerH: number;
    qrBox: number;
    scale: number;
  }
): void {
  const { width, height, pad, footerH, qrBox, scale } = geom;
  const labelSize = Math.max(11, Math.round(20 * scale));
  const x = width - pad - qrBox;
  const drawn = drawQrMatrix(
    t.ctx,
    url,
    x,
    height - footerH - pad - qrBox - Math.round(labelSize * 1.4),
    qrBox
  );
  t.ctx.font = `${labelSize}px ${t.ff}`;
  const labelW = t.ctx.measureText(label).width;
  drawLeft(
    t,
    label,
    x + Math.round((drawn - labelW) / 2),
    height - footerH - pad,
    labelSize,
    labelColor,
    false,
    drawn
  );
}

/**
 * The footer strip: the plate's state on the left, the freshness mark on the
 * right.
 *
 * Filled when a state is passed, which happens only on a single-seat plate whose
 * seat is occupied; otherwise a rule. The filled form uses the header colour pair
 * for the same reason the state pill does, namely that it is the one combination
 * every palette holds exactly.
 */
export function drawFooter(
  t: TypeCtx,
  geom: { width: number; height: number; pad: number; footerH: number; scale: number },
  state: string | null,
  mark: string,
  T: Theme
): void {
  const { width, height, pad, footerH, scale } = geom;
  const y = height - footerH;
  if (state) {
    t.ctx.fillStyle = T.headerBg;
    t.ctx.fillRect(0, y, width, footerH);
  } else {
    t.ctx.fillStyle = T.slotSecondary;
    t.ctx.fillRect(pad, y, width - pad * 2, Math.max(2, Math.round(2 * scale)));
  }

  const color = state ? T.headerText : T.footerText;
  const baseline = (size: number) => Math.round(y + footerH / 2 + size * CAP_RATIO * 0.5);
  if (state) {
    const size = Math.max(11, Math.round(26 * scale));
    drawLeft(t, state, pad, baseline(size), size, color, true, width / 2);
  }

  const markSize = Math.max(11, Math.round(20 * scale));
  t.ctx.font = `${markSize}px ${t.ff}`;
  drawLeft(
    t,
    mark,
    width - pad - t.ctx.measureText(mark).width,
    baseline(markSize),
    markSize,
    color,
    false,
    width / 2
  );
}

/**
 * A blank panel of the right size, painted with the theme's ground.
 *
 * Image smoothing is off unconditionally: the only image this renderer draws is a
 * QR matrix, and a scanner reading an e-paper panel at an angle has no margin for
 * interpolated module edges.
 */
export function newPlateCanvas(width: number, height: number, background: string) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}
