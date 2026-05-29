import { describe, it, expect } from "vitest";
import { REQUIRED_SHEET_FIELDS, validateSheetFields } from "./sheet-validation";

// A minimal sheet that passes every non-cyberware rule. Individual tests clone
// this and mutate just the field under test, so a failure points at one rule.
function validSheet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sheetType: "PC",
    fullName: "V",
    pronouns: "they/them",
    occupation: "Mercenary",
    psychProfile: "Reckless but loyal.",
    physicalDescription: "Chrome arm, neon tattoos.",
    background: "Grew up in Heywood.",
    age: 27,
    skills: "Handguns, Stealth, Netrunning",
    gear: ["Pistol"],
    ...overrides,
  };
}

describe("validateSheetFields - data shape", () => {
  it("rejects a null / non-object payload", () => {
    expect(validateSheetFields(null, [])).toBe("data required");
    expect(validateSheetFields(undefined, [])).toBe("data required");
    expect(validateSheetFields("not an object", [])).toBe("data required");
    expect(validateSheetFields(42, [])).toBe("data required");
  });

  it("accepts a fully valid PC sheet", () => {
    expect(validateSheetFields(validSheet(), [])).toBeNull();
  });
});

describe("validateSheetFields - required fields", () => {
  // Every string field must be present and non-blank.
  for (const field of REQUIRED_SHEET_FIELDS) {
    if (field === "sheetType") continue; // sheetType has its own enum check below
    it(`rejects a missing ${field}`, () => {
      const d = validSheet();
      delete d[field];
      expect(validateSheetFields(d, [])).toBe(`Missing required field: ${field}`);
    });

    it(`rejects a blank (whitespace-only) ${field}`, () => {
      expect(validateSheetFields(validSheet({ [field]: "   " }), [])).toBe(
        `Missing required field: ${field}`,
      );
    });

    it(`rejects a non-string ${field}`, () => {
      expect(validateSheetFields(validSheet({ [field]: 123 }), [])).toBe(
        `Missing required field: ${field}`,
      );
    });
  }
});

describe("validateSheetFields - sheetType enum", () => {
  it("rejects a missing sheetType as a required field first", () => {
    const d = validSheet();
    delete d.sheetType;
    expect(validateSheetFields(d, [])).toBe("Missing required field: sheetType");
  });

  it("rejects a sheetType that is neither PC nor NPC", () => {
    expect(validateSheetFields(validSheet({ sheetType: "BOSS" }), [])).toBe(
      "sheetType must be PC or NPC",
    );
  });

  it("accepts PC for a regular user", () => {
    expect(validateSheetFields(validSheet({ sheetType: "PC" }), ["member"])).toBeNull();
  });
});

describe("validateSheetFields - NPC role gating", () => {
  it("blocks a regular user from submitting an NPC sheet", () => {
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["member"])).toBe(
      "Only fixers can create NPC sheets",
    );
  });

  it("blocks a user with no roles from submitting an NPC sheet", () => {
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), [])).toBe(
      "Only fixers can create NPC sheets",
    );
  });

  it("allows a fixer to submit an NPC sheet", () => {
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["fixer"])).toBeNull();
  });

  it("allows an admin to submit an NPC sheet", () => {
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["admin"])).toBeNull();
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["administrator"])).toBeNull();
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["staff"])).toBeNull();
  });

  it("matches roles case-insensitively", () => {
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["Fixer"])).toBeNull();
    expect(validateSheetFields(validSheet({ sheetType: "NPC" }), ["ADMIN"])).toBeNull();
  });
});

describe("validateSheetFields - age", () => {
  it("rejects a missing age", () => {
    const d = validSheet();
    delete d.age;
    expect(validateSheetFields(d, [])).toBe("Missing required field: age (positive integer)");
  });

  it("rejects a non-number age", () => {
    expect(validateSheetFields(validSheet({ age: "27" }), [])).toBe(
      "Missing required field: age (positive integer)",
    );
  });

  it("rejects zero and negative ages", () => {
    expect(validateSheetFields(validSheet({ age: 0 }), [])).toBe(
      "Missing required field: age (positive integer)",
    );
    expect(validateSheetFields(validSheet({ age: -5 }), [])).toBe(
      "Missing required field: age (positive integer)",
    );
  });

  it("accepts a positive age", () => {
    expect(validateSheetFields(validSheet({ age: 1 }), [])).toBeNull();
  });
});

describe("validateSheetFields - skills", () => {
  it("rejects a missing skills value", () => {
    const d = validSheet();
    delete d.skills;
    expect(validateSheetFields(d, [])).toBe("Missing required field: skills");
  });

  it("rejects a blank free-text skills string", () => {
    expect(validateSheetFields(validSheet({ skills: "   " }), [])).toBe(
      "Missing required field: skills",
    );
  });

  it("rejects an empty legacy skills object", () => {
    expect(validateSheetFields(validSheet({ skills: {} }), [])).toBe(
      "Missing required field: skills",
    );
  });

  it("accepts current free-text skills", () => {
    expect(validateSheetFields(validSheet({ skills: "Handguns" }), [])).toBeNull();
  });

  it("accepts a non-empty legacy skills object", () => {
    expect(validateSheetFields(validSheet({ skills: { handguns: 5 } }), [])).toBeNull();
  });
});

describe("validateSheetFields - gear", () => {
  it("rejects a missing gear list", () => {
    const d = validSheet();
    delete d.gear;
    expect(validateSheetFields(d, [])).toBe(
      "Missing required field: gear/equipment (at least one entry)",
    );
  });

  it("rejects gear that is not an array", () => {
    expect(validateSheetFields(validSheet({ gear: "Pistol" }), [])).toBe(
      "Missing required field: gear/equipment (at least one entry)",
    );
  });

  it("rejects an empty gear array", () => {
    expect(validateSheetFields(validSheet({ gear: [] }), [])).toBe(
      "Missing required field: gear/equipment (at least one entry)",
    );
  });

  it("rejects a gear array of only blank / non-string entries", () => {
    expect(validateSheetFields(validSheet({ gear: ["", "   ", 5, null] }), [])).toBe(
      "Missing required field: gear/equipment (at least one entry)",
    );
  });

  it("accepts a gear array with at least one non-empty entry", () => {
    expect(validateSheetFields(validSheet({ gear: ["", "Katana"] }), [])).toBeNull();
  });
});
