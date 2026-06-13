import { describe, it, expect } from "vitest";
import { isReviewer } from "./review";
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
