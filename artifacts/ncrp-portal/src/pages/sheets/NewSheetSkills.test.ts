import { describe, it, expect } from "vitest";
import { skillsToText } from "./NewSheet";

describe("NewSheet: skillsToText", () => {
  it("passes a plain string through unchanged", () => {
    expect(skillsToText("Handguns 8\nStealth 6")).toBe("Handguns 8\nStealth 6");
  });

  it("flattens a legacy skill->rank object into one line per skill", () => {
    const out = skillsToText({ Handguns: 8, Stealth: 6 });
    // Order follows Object.entries which preserves insertion order.
    expect(out).toBe("Handguns 8\nStealth 6");
  });

  it("omits the rank when the value is null or empty", () => {
    const out = skillsToText({ Handguns: 8, Stealth: "", Persuasion: null });
    const lines = out.split("\n");
    expect(lines).toEqual(["Handguns 8", "Stealth", "Persuasion"]);
    // The empty/null lines must not retain a trailing space after the name.
    for (const line of lines) {
      expect(line).not.toMatch(/\s+$/);
    }
  });

  it("returns an empty string for nullish / non-objects", () => {
    expect(skillsToText(undefined)).toBe("");
    expect(skillsToText(null)).toBe("");
    expect(skillsToText(42)).toBe("");
    expect(skillsToText(true)).toBe("");
  });

  it("returns an empty string for an empty object", () => {
    expect(skillsToText({})).toBe("");
  });

  it("stringifies array-like skill collections via the object branch", () => {
    // Arrays are objects; skillsToText falls into the object branch and uses
    // numeric indices as keys, matching how loadCyberware-era data was shaped.
    const out = skillsToText(["Handguns", "Stealth"]);
    expect(out.split("\n")).toEqual(["0 Handguns", "1 Stealth"]);
  });
});
