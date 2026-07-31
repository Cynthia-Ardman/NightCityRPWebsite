import { describe, expect, it } from "vitest";
import { parseDynoMessage, parseWelcomeMessage, type RawDiscordMessage } from "./membershipEvents";

const base = { id: "1400000000000000000", timestamp: "2026-07-01T12:00:00.000Z" };

describe("parseWelcomeMessage", () => {
  it("parses a type-7 system join", () => {
    const m: RawDiscordMessage = { ...base, type: 7, author: { id: "42", username: "choom" } };
    const ev = parseWelcomeMessage(m);
    expect(ev).toMatchObject({
      direction: "join",
      subjectId: "42",
      displayName: "choom",
      eventType: "welcome-system",
      sourceRef: `discord-msg:${base.id}`,
    });
    expect(ev!.occurredAt.toISOString()).toBe(base.timestamp);
  });

  it("ignores normal messages and type-7 without author", () => {
    expect(parseWelcomeMessage({ ...base, type: 0, author: { id: "42" } })).toBeNull();
    expect(parseWelcomeMessage({ ...base, type: 7 })).toBeNull();
  });
});

describe("parseDynoMessage", () => {
  const dyno = (author: string, description: string, footer?: string): RawDiscordMessage => ({
    ...base,
    type: 0,
    embeds: [{ author: { name: author }, description, footer: footer ? { text: footer } : undefined }],
  });

  it("parses a Member Joined embed via footer id", () => {
    const ev = parseDynoMessage(dyno("Member Joined", "<@!99999> some\\_user", "ID: 99999"));
    expect(ev).toMatchObject({
      direction: "join",
      subjectId: "99999",
      displayName: "some_user",
      eventType: "dyno-embed",
    });
  });

  it("parses a Member Left embed and falls back to the mention id", () => {
    const ev = parseDynoMessage(dyno("Member Left", "<@1234567890> gone\\_choom"));
    expect(ev).toMatchObject({ direction: "leave", subjectId: "1234567890", displayName: "gone_choom" });
  });

  it("ignores unrelated embeds (voice logs, confessions, audit)", () => {
    expect(parseDynoMessage(dyno("📝 Audit Log", "something"))).toBeNull();
    expect(parseDynoMessage(dyno("someuser", "<@42> joined voice"))).toBeNull();
    expect(parseDynoMessage({ ...base, type: 0 })).toBeNull();
  });

  it("skips member embeds with no resolvable id", () => {
    expect(parseDynoMessage(dyno("Member Left", "no mention here"))).toBeNull();
  });
});
