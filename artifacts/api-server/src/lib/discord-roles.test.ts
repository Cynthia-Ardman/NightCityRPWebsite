import { describe, it, expect } from "vitest";
import { applyRoleIdGrants, hasRole, TRIAL_FIXER_ROLE_ID } from "./discord";

describe("applyRoleIdGrants (Trial Fixer)", () => {
  it("grants fixer to a member holding the Trial Fixer role id", () => {
    const names = ["member"];
    const result = applyRoleIdGrants(names, [TRIAL_FIXER_ROLE_ID]);
    expect(result).toContain("fixer");
    expect(hasRole(result, "FIXER")).toBe(true);
  });

  it("does not grant fixer when the Trial Fixer role id is absent", () => {
    const names = ["member"];
    const result = applyRoleIdGrants(names, ["999"]);
    expect(result).toEqual(["member"]);
    expect(hasRole(result, "FIXER")).toBe(false);
  });

  it("is idempotent for an existing fixer (no duplicate name)", () => {
    const names = ["fixer"];
    const result = applyRoleIdGrants(names, [TRIAL_FIXER_ROLE_ID]);
    expect(result.filter((r) => r === "fixer")).toHaveLength(1);
  });

  it("does not confer coordinator-only access", () => {
    const result = applyRoleIdGrants(["member"], [TRIAL_FIXER_ROLE_ID]);
    expect(hasRole(result, "COORDINATOR")).toBe(false);
  });

  it("leaves names untouched when no ids supplied", () => {
    expect(applyRoleIdGrants(["member"], [])).toEqual(["member"]);
  });
});
