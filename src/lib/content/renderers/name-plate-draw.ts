// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Everything the name plate puts on a canvas.
 *
 * Split from the renderer so that the module holding the layout DECISIONS is not
 * also the module holding several hundred lines of fillRect. Nothing here decides
 * what a sign says; it is handed strings, sizes and colours.
 */

import { type SKRSContext2D } from "@napi-rs/canvas";
import { canvasSurface, type Surface, type SurfaceFactory } from "@/lib/render/surface";
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
/** How one line is set. Grouped, because nine positional arguments is not a call. */
export interface TextStyle {
  size: number;
  color: string;
  /** Default regular: only the surname and the header are set bold. */
  bold?: boolean;
  /** Overrides the body family, for the surname rank when it is set narrow. */
  family?: string;
  /**
   * Passed to `fillText`, which SQUEEZES rather than clips. Every caller here has
   * already fitted its text to this width, so it is a backstop and not the layout.
   */
  maxWidth: number;
}

export function drawLeft(
  t: TypeCtx,
  text: string,
  x: number,
  baseline: number,
  style: TextStyle
): void {
  t.ctx.font = `${style.bold ? "bold " : ""}${style.size}px "${style.family ?? t.ff}"`;
  t.ctx.fillStyle = style.color;
  t.ctx.textAlign = "left";
  t.ctx.textBaseline = "alphabetic";
  t.ctx.fillText(text, x, baseline, style.maxWidth);
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
  drawLeft(t, text, x + padX, Math.round(y + padY + size * CAP_RATIO), {
    size,
    color: colors.pillText,
    bold: true,
    maxWidth: w,
  });
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
  const lines: { text: string; style: TextStyle }[] = [];
  const push = (text: string, size: number, color: string, bold = false, family?: string) =>
    lines.push({ text, style: { size, color, bold, family, maxWidth: 0 } });

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
  const capHeights = lines.map((l) => l.style.size * CAP_RATIO);
  const gaps = lines.slice(0, -1).map((l) => gapAfter(l.style.size));
  const blockH = capHeights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);

  let y = band.y + (band.h - blockH) / 2;
  lines.forEach((line, i) => {
    /* y is the cap TOP of this line, so the baseline sits one cap height below. */
    drawLeft(t, line.text, band.x, Math.round(y + capHeights[i]), {
      ...line.style,
      maxWidth: stackWidth,
    });
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
    drawLeft(t, content.caption, band.x, Math.round(centerY + sizes.secondary * CAP_RATIO * 0.5), {
      size: sizes.secondary,
      color: colors.secondary,
      maxWidth: gutterW,
    });
  }

  const x = band.x + gutterW;
  if (content.ranks) {
    drawRowName(t, content.ranks, x, centerY, sizes, colors, nameWidth);
  } else if (content.notice) {
    drawLeft(t, content.notice, x, Math.round(centerY + sizes.notice * CAP_RATIO * 0.5), {
      size: sizes.notice,
      color: colors.secondary,
      maxWidth: nameWidth,
    });
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
  drawLeft(t, ranks.surname, x, baseline, {
    size: sizes.surname,
    color: colors.name,
    bold: true,
    family: sizes.surnameFamily,
    maxWidth: nameWidth,
  });
  if (!ranks.given) return;
  /* The size search measured exactly this composition, surname plus gap plus
   * given name at its fraction, so the two cannot collide. */
  const gx =
    x +
    measureAt(t, ranks.surname, sizes.surname, true, sizes.surnameFamily) +
    Math.round(sizes.surname * ROW_NAME_GAP);
  drawLeft(t, ranks.given, gx, baseline, {
    size: sizes.given,
    color: colors.name,
    maxWidth: Math.max(0, x + nameWidth - gx),
  });
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
/**
 * Header accents: the pixel code on a panel with hue, and a grey LEVEL on one
 * without.
 *
 * The hue values are the panel's codes rather than what the eye sees. A Spectra 6
 * panel renders "green" as a mid-dark pigment and "red" as a brick, so `#00FF00`
 * in a preview says little about the wall.
 *
 * The greys are CHOSEN, not derived, and the reason is worth keeping. Mapping each
 * hue to its own perceived lightness is the right instinct, and it puts green at
 * 87 % and yellow at 97 %; as a full-width bar on a white panel those reach 1.4:1
 * and 1.0:1 against the page, which is a bar nobody can see. The usable band for a
 * bar on white ends around `#888888`, at 3.5:1, so the four accents are spread
 * evenly inside it while keeping the hues' lightness ORDER, which is the part an
 * operator's expectation actually rests on.
 *
 * Honest limitation: four grey levels are told apart side by side, not from down a
 * corridor. On the E1003 an accent is a marker for someone standing at the door,
 * where on a six-colour panel it works at any distance. Two or three classes carry
 * reliably in grey; four is the most the palette holds at all.
 *
 * `hueText` is DECLARED while the grey's text is derived, and the asymmetry is the
 * point. On a grey panel the code is the appearance, so measuring its contrast
 * answers the question. On Spectra the code is a stand-in for a pigment: the panel
 * renders `#00FF00` as a mid-dark green on which white text holds easily, while
 * measuring `#00FF00` itself returns 1.4:1 and would demand black. Deriving it
 * there would take the preview's word over the wall's.
 */
export const ACCENTS: Record<string, { hue: string; hueText: string; grey: string }> = {
  blue: { hue: "#0000FF", hueText: "#FFFFFF", grey: "#222222" },
  red: { hue: "#FF0000", hueText: "#FFFFFF", grey: "#444444" },
  green: { hue: "#00FF00", hueText: "#FFFFFF", grey: "#666666" },
  yellow: { hue: "#FFFF00", hueText: "#000000", grey: "#888888" },
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
  drawLeft(t, room, pad, Math.round(headerH / 2 + roomSize * CAP_RATIO * 0.5), {
    size: roomSize,
    color: fg,
    bold: true,
    maxWidth: roomWidth,
  });
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
  drawLeft(t, label, x + Math.round((drawn - labelW) / 2), height - footerH - pad, {
    size: labelSize,
    color: labelColor,
    maxWidth: drawn,
  });
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
    drawLeft(t, state, pad, baseline(size), { size, color, bold: true, maxWidth: width / 2 });
  }

  const markSize = Math.max(11, Math.round(20 * scale));
  t.ctx.font = `${markSize}px ${t.ff}`;
  drawLeft(t, mark, width - pad - t.ctx.measureText(mark).width, baseline(markSize), {
    size: markSize,
    color,
    maxWidth: width / 2,
  });
}

/**
 * A blank panel of the right size, painted with the theme's ground.
 *
 * Image smoothing is off unconditionally: the only image this renderer draws is a
 * QR matrix, and a scanner reading an e-paper panel at an angle has no margin for
 * interpolated module edges.
 */
export function newPlateCanvas(
  width: number,
  height: number,
  background: string,
  surface: SurfaceFactory = canvasSurface
): Surface {
  const s = surface(width, height);
  s.ctx.imageSmoothingEnabled = false;
  s.ctx.fillStyle = background;
  s.ctx.fillRect(0, 0, width, height);
  return s;
}
