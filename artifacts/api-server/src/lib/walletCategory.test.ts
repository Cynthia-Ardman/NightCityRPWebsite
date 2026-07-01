import { describe, it, expect } from "vitest";
import { classifyWalletCategory } from "@workspace/db";

describe("classifyWalletCategory", () => {
  it("classifies structured live kinds", () => {
    expect(classifyWalletCategory("rent", null)).toBe("rent");
    expect(classifyWalletCategory("business_rent", null)).toBe("rent");
    expect(classifyWalletCategory("meds", null)).toBe("cyberware");
    expect(classifyWalletCategory("trauma_team", null)).toBe("membership");
    expect(classifyWalletCategory("xanadu_gold", null)).toBe("membership");
    expect(classifyWalletCategory("shop_income", null)).toBe("business");
    expect(classifyWalletCategory("mission", null)).toBe("mission");
    expect(classifyWalletCategory("transfer", null)).toBe("transfer");
    expect(classifyWalletCategory("sink", null)).toBe("sink");
    expect(classifyWalletCategory("store_deposit", null)).toBe("purchase");
    expect(classifyWalletCategory("lifestyle_unpaid", null)).toBe("fee");
  });

  it("falls back to memo for legacy kind='historical' rows", () => {
    expect(classifyWalletCategory("historical", "[legacy-bal:100] Housing Rent")).toBe("rent");
    expect(classifyWalletCategory("historical", "[legacy-bal:102] Business Rent")).toBe("rent");
    expect(classifyWalletCategory("historical", "Cyberware meds week 3")).toBe("cyberware");
    expect(classifyWalletCategory("historical", "CW install: Mantis Blades")).toBe("cyberware");
    expect(classifyWalletCategory("historical", "Xanadu Gold dues")).toBe("membership");
    expect(classifyWalletCategory("historical", "Mission payout: Heist")).toBe("mission");
    expect(classifyWalletCategory("historical", "Actor pay for lobby")).toBe("mission");
    expect(classifyWalletCategory("historical", "Business activity reward")).toBe("business");
    expect(classifyWalletCategory("historical", "Flat monthly fee")).toBe("fee");
  });

  it("prefers rent over other matches and membership over mission", () => {
    // "Business Rent" must read as rent, not business.
    expect(classifyWalletCategory("historical", "Business Rent")).toBe("rent");
    // Trauma Team membership shouldn't be swallowed by a generic rule.
    expect(classifyWalletCategory("historical", "Trauma Team monthly")).toBe("membership");
  });

  it("returns 'other' for unmatched rows", () => {
    expect(classifyWalletCategory("historical", "[legacy-bal:190] Gun sale: Lexington")).toBe(
      "other",
    );
    expect(classifyWalletCategory(null, null)).toBe("other");
    expect(classifyWalletCategory("", "")).toBe("other");
    expect(classifyWalletCategory(undefined, undefined)).toBe("other");
  });

  it("is case-insensitive on memo", () => {
    expect(classifyWalletCategory("historical", "HOUSING RENT")).toBe("rent");
    expect(classifyWalletCategory("historical", "CYBERWARE MEDS")).toBe("cyberware");
  });
});
