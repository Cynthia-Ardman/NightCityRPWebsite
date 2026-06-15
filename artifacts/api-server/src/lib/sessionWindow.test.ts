import { describe, it, expect } from "vitest";
import { sessionWeekKey, legacySessionWeekKeys } from "./sessionWindow";

describe("sessionWeekKey", () => {
  it("yields one key per Pacific Sunday session even across UTC midnight", () => {
    // Both timestamps are Sunday June 14 2026 inside the 2-9pm Pacific window,
    // but the second has already rolled into Monday UTC. A UTC-based week key
    // would split these across two weeks (the old double-claim bug).
    const earlyPT = new Date("2026-06-14T22:30:00Z"); // Sun 3:30pm PDT
    const latePT = new Date("2026-06-15T03:30:00Z"); // Sun 8:30pm PDT (Mon UTC)
    expect(sessionWeekKey(earlyPT)).toBe("2026-06-14");
    expect(sessionWeekKey(latePT)).toBe("2026-06-14");
    expect(sessionWeekKey(earlyPT)).toBe(sessionWeekKey(latePT));
  });

  it("anchors any weekday back to that week's Pacific Sunday", () => {
    // Wednesday Pacific still maps to the preceding Sunday.
    expect(sessionWeekKey(new Date("2026-06-17T19:00:00Z"))).toBe("2026-06-14");
  });
});

describe("legacySessionWeekKeys", () => {
  it("covers both UTC-Monday keys the Sunday key replaced", () => {
    // For the June 14 session a pre-cutover claim could be stored under June 8
    // (claim instant on Sunday UTC → ISO Monday = Sun−6d) or June 15 (claim
    // instant on Monday UTC → ISO Monday = Sun+1d).
    const keys = legacySessionWeekKeys(new Date("2026-06-14T22:30:00Z"));
    expect(keys).toContain("2026-06-08");
    expect(keys).toContain("2026-06-15");
  });
});
