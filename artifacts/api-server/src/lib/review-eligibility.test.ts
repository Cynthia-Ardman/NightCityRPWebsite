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

describe("isEligibleReviewer (approver pool — CS_APPROVER only)", () => {
  it("includes a cs-approver", () => {
    expect(isEligibleReviewer(userWith(["cs approver"]))).toBe(true);
  });

  it("excludes a fixer who is not a cs-approver", () => {
    // Holding a fixer role does NOT make you an approver. Fixers retain staff
    // view access (isReviewer) but can no longer cast a counted vote anywhere.
    expect(isEligibleReviewer(userWith(["fixer"]))).toBe(false);
  });

  it("excludes a pure admin (no cs-approver role)", () => {
    // An admin without the cs-approver role must NOT appear as an eligible
    // approver or be able to cast a counted vote. They act through OVERRIDE.
    expect(isEligibleReviewer(userWith(["admin"]))).toBe(false);
  });

  it("excludes an admin/fixer combo lacking cs-approver", () => {
    expect(isEligibleReviewer(userWith(["admin", "fixer"]))).toBe(false);
  });

  it("includes anyone holding cs-approver regardless of other roles", () => {
    // Not being a fixer must not exclude you; being a fixer must not add you.
    expect(isEligibleReviewer(userWith(["cs approver", "fixer"]))).toBe(true);
    expect(isEligibleReviewer(userWith(["cs approver", "admin"]))).toBe(true);
  });

  it("excludes a plain player", () => {
    expect(isEligibleReviewer(userWith(["member"]))).toBe(false);
  });
});
