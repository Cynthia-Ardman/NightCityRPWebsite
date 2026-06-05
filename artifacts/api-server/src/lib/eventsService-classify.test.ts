import { describe, it, expect } from "vitest";
import { isMainSessionTitle, classifyImportedEventType, eventNeedsNpcs } from "./eventsService";

describe("isMainSessionTitle", () => {
  it("matches the canonical auto-generated Main Session titles", () => {
    expect(isMainSessionTitle("NCRP Main Event: Session 66")).toBe(true);
    expect(isMainSessionTitle("NCRP Main Event: Session 67")).toBe(true);
    expect(isMainSessionTitle("ncrp main event: session 100")).toBe(true);
    expect(isMainSessionTitle("Main Event - Session 5")).toBe(true);
  });

  it("does not match unrelated events", () => {
    expect(isMainSessionTitle("Open Chaos Lobby")).toBe(false);
    expect(isMainSessionTitle("Fight Night")).toBe(false);
    expect(isMainSessionTitle("Session at the bar")).toBe(false); // "session" without "main event"
    expect(isMainSessionTitle("Main Event: Boxing")).toBe(false); // "main event" without "session"
  });
});

describe("classifyImportedEventType", () => {
  it("promotes Main Sessions to 'session' and defaults everything else to 'social'", () => {
    expect(classifyImportedEventType("NCRP Main Event: Session 66")).toBe("session");
    expect(classifyImportedEventType("Open Chaos Lobby")).toBe("social");
    expect(classifyImportedEventType("Karaoke Night")).toBe("social");
  });
});

describe("eventNeedsNpcs derives off the classified type", () => {
  it("a Main Session imported as 'session' accepts NPC sign-ups even with needsNpcs off", () => {
    const t = classifyImportedEventType("NCRP Main Event: Session 66");
    expect(eventNeedsNpcs({ needsNpcs: false, eventType: t })).toBe(true);
  });
  it("a generic social import does not, unless its needsNpcs flag is set", () => {
    const t = classifyImportedEventType("Open Chaos Lobby");
    expect(eventNeedsNpcs({ needsNpcs: false, eventType: t })).toBe(false);
    expect(eventNeedsNpcs({ needsNpcs: true, eventType: t })).toBe(true);
  });
});
