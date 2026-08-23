// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { describe, it, expect } from "vitest";
import { splitName } from "../name-split";

describe("splitName", () => {
  it("takes the case this exists for apart", () => {
    expect(splitName("Prof. Dr. Fabian Schmieder")).toEqual({
      titles: "Prof. Dr.",
      given: "Fabian",
      surname: "Schmieder",
    });
  });

  it("leaves a bare surname as the surname", () => {
    expect(splitName("Schmieder")).toEqual({ titles: "", given: "", surname: "Schmieder" });
  });

  it("keeps every given name in the middle rank", () => {
    expect(splitName("Maria Anna Schmieder")).toMatchObject({
      given: "Maria Anna",
      surname: "Schmieder",
    });
  });

  it("treats a hyphenated surname as one token", () => {
    expect(splitName("Karl Müller-Lüdenscheidt")).toMatchObject({
      surname: "Müller-Lüdenscheidt",
    });
  });

  /* An initial is not a title, even though both end in a dot. Getting this wrong
   * puts "F." in the smallest rank and leaves the middle one empty. */
  it("reads a single letter as an initial and a longer abbreviation as a title", () => {
    expect(splitName("Prof. Dr. F. Schmieder")).toEqual({
      titles: "Prof. Dr.",
      given: "F.",
      surname: "Schmieder",
    });
  });

  it("absorbs German compound titles", () => {
    expect(splitName("Dr. rer. nat. Fabian Schmieder")).toEqual({
      titles: "Dr. rer. nat.",
      given: "Fabian",
      surname: "Schmieder",
    });
  });

  describe("particles belong to the surname", () => {
    it("keeps a two-particle Dutch surname whole", () => {
      expect(splitName("Jan van der Berg")).toEqual({
        titles: "",
        given: "Jan",
        surname: "van der Berg",
      });
    });

    /* The walk has to be allowed to reach index 0, or the first particle is
     * mistaken for a given name and the sign reads "Herr der Berg". */
    it("keeps a particle surname whole when there is no given name", () => {
      expect(splitName("van der Berg")).toEqual({
        titles: "",
        given: "",
        surname: "van der Berg",
      });
    });

    it("handles zu, von and de alike", () => {
      expect(splitName("Karl-Theodor zu Guttenberg").surname).toBe("zu Guttenberg");
      expect(splitName("Alexander von Humboldt").surname).toBe("von Humboldt");
      expect(splitName("Ana de la Cruz").surname).toBe("de la Cruz");
    });
  });

  describe("commas", () => {
    it("reverses the order when the comma separates the name", () => {
      expect(splitName("Schmieder, Fabian")).toEqual({
        titles: "",
        given: "Fabian",
        surname: "Schmieder",
      });
    });

    it("drops a degree instead of reversing on it", () => {
      expect(splitName("Fabian Schmieder, LL.M.")).toEqual({
        titles: "",
        given: "Fabian",
        surname: "Schmieder",
      });
    });

    it("copes with both jobs in one string", () => {
      expect(splitName("Schmieder, Fabian, LL.M.")).toEqual({
        titles: "",
        given: "Fabian",
        surname: "Schmieder",
      });
    });

    it("reverses a particle surname too", () => {
      expect(splitName("van der Berg, Jan")).toMatchObject({
        given: "Jan",
        surname: "van der Berg",
      });
    });
  });

  describe("degrees written without a comma", () => {
    /* The failure this prevents is specific: without the suffix rule, "MBA" is
     * the last token AND the only shouted one, so it would have been set large. */
    it("never makes a degree the surname", () => {
      expect(splitName("Fabian Schmieder MBA")).toMatchObject({ surname: "Schmieder" });
      expect(splitName("Fabian Schmieder LL.M.")).toMatchObject({ surname: "Schmieder" });
    });
  });

  describe("a shouted surname", () => {
    it("is the surname wherever it stands", () => {
      expect(splitName("SCHMIEDER Fabian")).toEqual({
        titles: "",
        given: "Fabian",
        surname: "SCHMIEDER",
      });
      expect(splitName("Fabian SCHMIEDER")).toMatchObject({ surname: "SCHMIEDER" });
    });

    it("does not apply when the whole name is upper-case", () => {
      expect(splitName("FABIAN SCHMIEDER")).toMatchObject({
        given: "FABIAN",
        surname: "SCHMIEDER",
      });
    });
  });

  describe("degenerate input", () => {
    it("returns three empty ranks for an empty string", () => {
      expect(splitName("   ")).toEqual({ titles: "", given: "", surname: "" });
    });

    it("never leaves the surname empty for a non-empty name", () => {
      for (const s of ["Dr.", "von", "A", "Prof. Dr.", "LL.M."]) {
        expect(splitName(s).surname).not.toBe("");
      }
    });

    it("collapses runs of whitespace", () => {
      expect(splitName("  Prof.   Dr.\tFabian   Schmieder ")).toEqual({
        titles: "Prof. Dr.",
        given: "Fabian",
        surname: "Schmieder",
      });
    });
  });

  /* Documented limitation, asserted so that a future change to the rules has to
   * confront it deliberately rather than by accident. A surname written first
   * WITHOUT a comma cannot be told from the usual order. */
  it("cannot detect surname-first order without a comma", () => {
    expect(splitName("Ćurić Nikola").surname).toBe("Nikola");
  });
});
