import { describe, it, expect } from "vitest";
import { looseGunKey, bestGunSuggestion } from "./gunMatch";

const CATALOG = [
  "Militech M-10AF Lexington",
  "Malorian Arms 3516",
  "Constitutional Arms Unity",
  "Tsunami Nue",
];

describe("looseGunKey", () => {
  it("collapses case, whitespace, and punctuation to one key", () => {
    expect(looseGunKey(" Militech  M-10AF Lexington, ")).toBe("militechm10aflexington");
    expect(looseGunKey("MILITECH M10AF LEXINGTON")).toBe("militechm10aflexington");
  });
});

describe("bestGunSuggestion", () => {
  it("returns null for exact loose matches (already catalog)", () => {
    expect(bestGunSuggestion("militech m-10af lexington", CATALOG)).toBeNull();
  });

  it("suggests the catalog entry for a close typo", () => {
    expect(bestGunSuggestion("Malorian Arms 3517", CATALOG)).toBe("Malorian Arms 3516");
    expect(bestGunSuggestion("Tsunami Nuee", CATALOG)).toBe("Tsunami Nue");
  });

  it("suggests via containment for partial names", () => {
    expect(bestGunSuggestion("Lexington", CATALOG)).toBe("Militech M-10AF Lexington");
    expect(bestGunSuggestion("Unity", CATALOG)).toBe("Constitutional Arms Unity");
  });

  it("returns null for unrelated custom names and tiny inputs", () => {
    expect(bestGunSuggestion("Frankengun Mk0", CATALOG)).toBeNull();
    expect(bestGunSuggestion("ab", CATALOG)).toBeNull();
    expect(bestGunSuggestion("", CATALOG)).toBeNull();
  });
});
