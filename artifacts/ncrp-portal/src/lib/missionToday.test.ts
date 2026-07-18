import { describe, it, expect } from "vitest";
import { selectTodaysMissions, hasAcceptedCharacter, isSameLocalDay } from "./missionToday";

// A fixed "now" mid-afternoon local time so same-day boundaries are easy to reason about.
const now = new Date(2026, 6, 18, 15, 0, 0); // Jul 18 2026, 15:00 local

function mission(overrides: Partial<Parameters<typeof selectTodaysMissions>[0][number]> = {}) {
  return {
    id: 1,
    title: "Test Run",
    startAt: new Date(2026, 6, 18, 20, 0).toISOString(), // today 20:00 local
    status: "open",
    workflowState: "posted",
    ...overrides,
  };
}

describe("isSameLocalDay", () => {
  it("matches same local day, rejects adjacent days", () => {
    expect(isSameLocalDay(new Date(2026, 6, 18, 0, 1), now)).toBe(true);
    expect(isSameLocalDay(new Date(2026, 6, 18, 23, 59), now)).toBe(true);
    expect(isSameLocalDay(new Date(2026, 6, 17, 23, 59), now)).toBe(false);
    expect(isSameLocalDay(new Date(2026, 6, 19, 0, 0), now)).toBe(false);
  });
});

describe("selectTodaysMissions", () => {
  it("includes an open posted mission starting today", () => {
    expect(selectTodaysMissions([mission()], now)).toHaveLength(1);
  });

  it("includes a mission that already started earlier today", () => {
    const m = mission({ startAt: new Date(2026, 6, 18, 10, 0).toISOString() });
    expect(selectTodaysMissions([m], now)).toHaveLength(1);
  });

  it("excludes missions on other days", () => {
    const tomorrow = mission({ startAt: new Date(2026, 6, 19, 1, 0).toISOString() });
    const yesterday = mission({ startAt: new Date(2026, 6, 17, 23, 0).toISOString() });
    expect(selectTodaysMissions([tomorrow, yesterday], now)).toHaveLength(0);
  });

  it("excludes cancelled/completed and unposted pipeline states", () => {
    expect(selectTodaysMissions([mission({ status: "cancelled" })], now)).toHaveLength(0);
    expect(selectTodaysMissions([mission({ status: "completed" })], now)).toHaveLength(0);
    expect(selectTodaysMissions([mission({ workflowState: "draft" })], now)).toHaveLength(0);
    expect(selectTodaysMissions([mission({ workflowState: "proposal" })], now)).toHaveLength(0);
  });

  it("tolerates missing workflowState (player-visible list) and null/invalid startAt", () => {
    expect(selectTodaysMissions([mission({ workflowState: undefined })], now)).toHaveLength(1);
    expect(selectTodaysMissions([mission({ startAt: null })], now)).toHaveLength(0);
    expect(selectTodaysMissions([mission({ startAt: "not-a-date" })], now)).toHaveLength(0);
  });

  it("sorts multiple missions soonest first and carries signup flags", () => {
    const late = mission({ id: 2, startAt: new Date(2026, 6, 18, 22, 0).toISOString() });
    const early = mission({
      id: 3,
      startAt: new Date(2026, 6, 18, 17, 0).toISOString(),
      npcSignupOpen: true,
      mySignup: { state: "signed_up" },
    });
    const out = selectTodaysMissions([late, early], now);
    expect(out.map((m) => m.id)).toEqual([3, 2]);
    expect(out[0].npcSignupOpen).toBe(true);
    expect(out[0].signedUpAsNpc).toBe(true);
    expect(out[1].signedUpAsNpc).toBe(false);
  });

  it("derives playerOnMission from accepted application or rostered character", () => {
    const out = selectTodaysMissions(
      [
        mission({ id: 1, myApplication: { status: "accepted" } }),
        mission({ id: 2, myCharacterId: 42 }),
        mission({ id: 3, myApplication: { status: "pending" } }),
        mission({ id: 4 }),
      ],
      now,
    );
    expect(out.map((m) => [m.id, m.playerOnMission])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ]);
  });
});

describe("hasAcceptedCharacter", () => {
  it("true for an approved active PC", () => {
    expect(hasAcceptedCharacter([{ kind: "pc", approved: true, archived: false, lifeStatus: "active" }])).toBe(true);
  });
  it("true when lifeStatus is missing (defaults active) or loa", () => {
    expect(hasAcceptedCharacter([{ kind: "pc", approved: true }])).toBe(true);
    expect(hasAcceptedCharacter([{ kind: "pc", approved: true, lifeStatus: "loa" }])).toBe(true);
  });
  it("false for NPCs, unapproved, archived, dead or retired", () => {
    expect(hasAcceptedCharacter([{ kind: "npc", approved: true }])).toBe(false);
    expect(hasAcceptedCharacter([{ kind: "pc", approved: false }])).toBe(false);
    expect(hasAcceptedCharacter([{ kind: "pc" }])).toBe(false);
    expect(hasAcceptedCharacter([{ kind: "pc", approved: true, archived: true }])).toBe(false);
    expect(hasAcceptedCharacter([{ kind: "pc", approved: true, lifeStatus: "dead" }])).toBe(false);
    expect(hasAcceptedCharacter([{ kind: "pc", approved: true, lifeStatus: "retired" }])).toBe(false);
  });
  it("false for empty/undefined lists", () => {
    expect(hasAcceptedCharacter([])).toBe(false);
    expect(hasAcceptedCharacter(undefined)).toBe(false);
  });
});
