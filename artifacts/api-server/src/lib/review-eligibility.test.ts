import { describe, it, expect } from "vitest";
import { isReviewer, isEligibleReviewer } from "./review";
import type { User } from "@workspace/db";

// Minimal User stub — isReviewer only inspects `roles`.
function userWith(roles: string[]): User {
  return { roles } as unknown as User;
}

describe("isReviewer (Trial Fixer exclusion)", () => {
  it("includes a real fixer / cs-approver / admin", () => {
    expect(isReviewer(userWith(["fixer"]))).toBe(true);
    expect(isReviewer(userWith(["cs approver"]))).toBe(true);
    expect(isReviewer(userWith(["admin"]))).toBe(true);
  });

  it("excludes a plain player", () => {
    expect(isReviewer(userWith(["member"]))).toBe(false);
  });

  it("excludes a trial fixer", () => {
    expect(isReviewer(userWith(["trial-fixer"]))).toBe(false);
  });

  it("excludes a trial fixer even with a lingering fixer name (stale stored roles)", () => {
    // Robustness: roles not yet re-synced after the trial-fixer rollout could
    // still carry "fixer". The trial marker must win so they never vote.
    expect(isReviewer(userWith(["fixer", "trial-fixer"]))).toBe(false);
  });
});

describe("isEligibleReviewer (approver pool — admins excluded)", () => {
  it("includes a fixer / cs-approver", () => {
    expect(isEligibleReviewer(userWith(["fixer"]))).toBe(true);
    expect(isEligibleReviewer(userWith(["cs approver"]))).toBe(true);
  });

  it("excludes a pure admin (no fixer/cs-approver role)", () => {
    // The bug: an admin-without-fixer must NOT appear as an eligible approver
    // or be able to cast a counted vote. They act through OVERRIDE instead.
    expect(isEligibleReviewer(userWith(["admin"]))).toBe(false);
  });

  it("still includes an admin who ALSO holds the fixer role", () => {
    expect(isEligibleReviewer(userWith(["admin", "fixer"]))).toBe(true);
  });

  it("excludes a plain player", () => {
    expect(isEligibleReviewer(userWith(["member"]))).toBe(false);
  });

  it("excludes a trial fixer even with a lingering fixer name", () => {
    expect(isEligibleReviewer(userWith(["fixer", "trial-fixer"]))).toBe(false);
  });
});
