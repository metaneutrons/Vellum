// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Split a display name into the three ranks a door sign sets.
 *
 * This exists because a door sign is WIDTH-bound, not height-bound. Measured
 * against the panel geometries in `DISPLAY_REGISTRY`, "Prof. Dr. Fabian
 * Schmieder" set as one line reaches 7,6 mm of cap height on a 7.5" panel and is
 * therefore readable from 1,5 m, at one seat exactly as at four: the seat count
 * barely matters, the length of the longest string decides. Set as three ranks,
 * the surname alone gets the full width and reaches 18,5 mm, or 3,7 m. Splitting
 * the name is worth a factor of 2,4 in reading distance and costs nothing, since
 * the vertical room it needs was going unused.
 *
 * A HEURISTIC, and only where one is unavoidable. A provider that structures the
 * name is believed instead (anny returns `given_name` and `family_name`, and
 * `CalendarEvent` carries them through). Microsoft Graph offers `displayName` and
 * nothing else on a calendar event, so a booking from there arrives as one string
 * and has to be taken apart here.
 *
 * What it cannot do, stated plainly rather than papered over: a name written
 * surname-first without a comma is indistinguishable from one written the usual
 * way. "Ćurić Nikola" is read as given name "Ćurić", surname "Nikola", and no
 * amount of rule-writing fixes that without knowing the source's convention. An
 * operator who hits this uses a static seat, where the ranks are typed.
 */

/** The three ranks, largest last. Any of the first two may be empty. */
export interface NameRanks {
  /** Honorifics and academic prefixes, e.g. "Prof. Dr." Set smallest. */
  titles: string;
  /** Given names and initials, e.g. "Fabian". Set between the other two. */
  given: string;
  /** The payload, e.g. "Schmieder" or "van der Berg". Set largest. */
  surname: string;
}

/**
 * Honorifics and academic prefixes that appear BEFORE the name.
 *
 * Held without their trailing dot, because `normalize` strips one. Lowercase
 * fragments of longer German titles ("Dr. rer. nat.") are matched by the dotted
 * rule in `isTitle` rather than listed here.
 */
const TITLE_WORDS = new Set([
  "prof",
  "prof.in",
  "dr",
  "dr.in",
  "dres",
  "drs",
  "pd",
  "doz",
  "dipl",
  "mag",
  "ing",
  "habil",
  "univ",
  "herr",
  "frau",
  "mr",
  "mrs",
  "ms",
  "mx",
  "sir",
  "dame",
  "dott",
  "dott.ssa",
]);

/**
 * Degrees and generational markers that appear AFTER the name.
 *
 * Dropped rather than shown. They are the least useful thing on a door and would
 * otherwise be mistaken for the surname, which is the one rank that has to be
 * right: "Fabian Schmieder MBA" must not become a sign for Herr MBA.
 */
const SUFFIX_WORDS = new Set([
  "ll.m",
  "llm",
  "m.a",
  "ma",
  "b.a",
  "ba",
  "m.sc",
  "msc",
  "b.sc",
  "bsc",
  "mba",
  "phd",
  "ph.d",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "emeritus",
  "e.h",
]);

/**
 * Nobiliary and toponymic particles that belong TO the surname.
 *
 * "van der Berg" is one surname of three tokens, and setting only "Berg" large
 * would be wrong on the door of a Herr van der Berg. Deliberately conservative:
 * "of", "y" and Dutch "in" are omitted, because each is a common word in some
 * language on this list and a false positive swallows a given name.
 */
const PARTICLES = new Set([
  "von",
  "vom",
  "van",
  "de",
  "del",
  "della",
  "der",
  "den",
  "di",
  "da",
  "das",
  "dos",
  "du",
  "la",
  "le",
  "les",
  "ten",
  "ter",
  "af",
  "av",
  "zu",
  "zur",
  "zum",
  "bin",
  "ibn",
  "al",
  "el",
  "'t",
]);

/** Lowercase, and drop ONE trailing dot, so "LL.M." and "llm" both look up. */
function normalize(token: string): string {
  return token.toLowerCase().replace(/\.$/, "");
}

function isTitle(token: string): boolean {
  const t = normalize(token);
  if (TITLE_WORDS.has(t)) return true;
  /* Any other dotted abbreviation is a title, EXCEPT a single letter: "F." is an
   * initial and belongs to the given name, while "Dr." and "rer." do not. */
  return token.endsWith(".") && t.length >= 3;
}

/** True when every token of this fragment is a degree or generational marker. */
function isSuffix(fragment: string): boolean {
  const tokens = fragment.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => SUFFIX_WORDS.has(normalize(t)));
}

/** A token written entirely in capitals, as some directories set the surname. */
function isShout(token: string): boolean {
  return /^\p{Lu}[\p{Lu}\p{M}'’-]{2,}$/u.test(token);
}

/**
 * Put the fragments of a comma-separated name into reading order.
 *
 * A comma does one of two jobs and they have to be told apart. In "Schmieder,
 * Fabian" it reverses the order; in "Fabian Schmieder, LL.M." it introduces a
 * degree. Trailing degree fragments are dropped first, and only then does a
 * remaining comma mean reversal.
 */
function readingOrder(input: string): string {
  const parts = input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  while (parts.length > 1 && isSuffix(parts[parts.length - 1])) parts.pop();
  if (parts.length >= 2) return `${parts[1]} ${parts[0]}`;
  return parts[0] ?? "";
}

/**
 * Take a display name apart into titles, given name and surname.
 *
 * Never throws and never returns an empty surname for a non-empty input: the
 * surname is what the sign is for, so when the rules cannot decide, the whole
 * remaining string becomes the surname and the sign degrades to what it did
 * before this function existed.
 */
export function splitName(raw: string): NameRanks {
  const input = raw.replace(/\s+/g, " ").trim();
  if (!input) return { titles: "", given: "", surname: "" };

  const tokens = readingOrder(input).split(" ").filter(Boolean);
  if (tokens.length === 0) return { titles: "", given: "", surname: "" };

  /* Front, then back. Both loops keep at least one token, so a name that is
   * nothing but a title still has a surname to draw. */
  const titles: string[] = [];
  while (tokens.length > 1 && isTitle(tokens[0])) {
    const head = tokens.shift();
    if (head) titles.push(head);
  }
  while (tokens.length > 1 && isSuffix(tokens[tokens.length - 1])) tokens.pop();

  const shouted = shoutedSurname(tokens);
  const start = shouted === null ? surnameStart(tokens) : 0;
  if (shouted !== null) {
    return {
      titles: titles.join(" "),
      given: tokens.filter((tk) => tk !== shouted).join(" "),
      surname: shouted,
    };
  }

  return {
    titles: titles.join(" "),
    given: tokens.slice(0, start).join(" "),
    surname: tokens.slice(start).join(" "),
  };
}

/**
 * The one shouted token, when there is exactly one.
 *
 * A single upper-case token is the surname wherever it stands, which is how
 * "SCHMIEDER Fabian" is meant to be read. Two of them means the whole name is
 * upper-case, and then the position rule applies as usual, so this returns null.
 */
function shoutedSurname(tokens: string[]): string | null {
  if (tokens.length < 2) return null;
  const shouted = tokens.filter(isShout);
  return shouted.length === 1 ? shouted[0] : null;
}

/**
 * Where the surname begins: the last token, plus every particle in front of it.
 *
 * The walk may reach index 0, which is what makes "van der Berg" with no given
 * name come out whole instead of losing "van" to the given rank.
 */
function surnameStart(tokens: string[]): number {
  let start = tokens.length - 1;
  while (start > 0 && PARTICLES.has(normalize(tokens[start - 1]))) start--;
  return start;
}
