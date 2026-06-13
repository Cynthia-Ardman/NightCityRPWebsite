import { describe, it, expect } from "vitest";
import { applyRoleIdGrants, hasRole, TRIAL_FIXER_ROLE_ID } from "./discord";

describe("applyRoleIdGrants (Trial Fixer)", () => {
  it("tags the Trial Fixer role id with the marker but NOT canonical fixer", () => {
    // Trial fixers are a NARROW role: they may author/propose missions but get
    // none of the full-fixer staff tools, so they must NOT be granted "fixer".
    const names = ["member"];
    const result = applyRoleIdGrants(names, [TRIAL_FIXER_ROLE_ID]);
    expect(result).not.toContain("fixer");
    expect(hasRole(result, "FIXER")).toBe(false);
  });

  it("tags a trial fixer with the TRIAL_FIXER marker (display-only)", () => {
    const result = applyRoleIdGrants(["member"], [TRIAL_FIXER_ROLE_ID]);
    expect(hasRole(result, "TRIAL_FIXER")).toBe(true);
  });

  it("does not tag an established fixer as trial", () => {
    // A real Fixer (resolved role name only, no Trial Fixer id) is a full
    // fixer but must NOT be flagged as on-trial.
    const result = applyRoleIdGrants(["fixer"], ["999"]);
    expect(hasRole(result, "FIXER")).toBe(true);
    expect(hasRole(result, "TRIAL_FIXER")).toBe(false);
  });

  it("does not grant or tag anything when the Trial Fixer role id is absent", () => {
    const names = ["member"];
    const result = applyRoleIdGrants(names, ["999"]);
    expect(result).toEqual(["member"]);
    expect(hasRole(result, "FIXER")).toBe(false);
    expect(hasRole(result, "TRIAL_FIXER")).toBe(false);
  });

  it("is idempotent for the trial marker (no duplicate)", () => {
    const names = ["trial-fixer"];
    const result = applyRoleIdGrants(names, [TRIAL_FIXER_ROLE_ID]);
    expect(result.filter((r) => r === "trial-fixer")).toHaveLength(1);
  });

  it("does not confer coordinator-only access", () => {
    const result = applyRoleIdGrants(["member"], [TRIAL_FIXER_ROLE_ID]);
    expect(hasRole(result, "COORDINATOR")).toBe(false);
  });

  it("strips a lingering fixer/coordinator name from a trial fixer (dual-role grant)", () => {
    // A transitional or mistaken dual grant (Trial Fixer id PLUS a "fixer" or
    // "coordinator" role name) must collapse to the narrow trial tier — the id
    // is authoritative, so the FIXER/COORDINATOR group checks stay false.
    const result = applyRoleIdGrants(["member", "fixer", "coordinator"], [TRIAL_FIXER_ROLE_ID]);
    expect(hasRole(result, "FIXER")).toBe(false);
    expect(hasRole(result, "COORDINATOR")).toBe(false);
    expect(hasRole(result, "TRIAL_FIXER")).toBe(true);
    expect(result).toContain("member");
  });

  it("leaves names untouched when no ids supplied", () => {
    expect(applyRoleIdGrants(["member"], [])).toEqual(["member"]);
  });
});
