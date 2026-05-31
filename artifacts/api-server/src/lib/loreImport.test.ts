import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, loreImportDrafts } from "@workspace/db";

// The importer bails out early when no Discord token/guild is configured (the
// test env blanks them). Provide non-empty values so the real scan/group/dedup
// path runs; everything network-facing is served by the fetch mock below.
vi.mock("./discord", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, DISCORD_BOT_TOKEN: "test-bot-token", DISCORD_GUILD_ID: "test-guild" };
});

const { runLoreImport } = await import("./loreImport");

const LORE_FORUM_CHANNEL = "1384441172180729981";

// Routes Discord REST calls to deterministic fixtures so a run produces exactly
// one candidate (group key "arasaka") with no archived threads or linked docs.
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function discordFetchMock(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();

  // Guild-level active threads: one thread parented to the main lore forum.
  if (url.includes("/threads/active")) {
    return Promise.resolve(
      jsonResponse({
        threads: [
          {
            id: "thread-arasaka",
            name: "Arasaka",
            parent_id: LORE_FORUM_CHANNEL,
            applied_tags: [],
            thread_metadata: {},
          },
        ],
      }),
    );
  }

  // Archived threads: none.
  if (url.includes("/threads/archived/public")) {
    return Promise.resolve(jsonResponse({ threads: [], has_more: false }));
  }

  // Thread messages: the OP body for our thread; everything else (story leads
  // thread, second channel) is empty.
  if (/\/channels\/thread-arasaka\/messages/.test(url)) {
    return Promise.resolve(
      jsonResponse([{ id: "m1", content: "Arasaka is a megacorporation.", author: { id: "author-1" } }]),
    );
  }
  if (/\/channels\/[^/]+\/messages/.test(url)) {
    return Promise.resolve(jsonResponse([]));
  }

  // Forum tag metadata (GET /channels/{id} with no further path segment).
  if (/\/channels\/[^/]+$/.test(url)) {
    return Promise.resolve(jsonResponse({ available_tags: [] }));
  }

  return Promise.resolve(jsonResponse({}));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(discordFetchMock as typeof fetch);
});

describe("runLoreImport idempotency / dedup", () => {
  it("creates one pending draft on the first run", async () => {
    const result = await runLoreImport();
    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(0);

    const drafts = await db
      .select()
      .from(loreImportDrafts)
      .where(eq(loreImportDrafts.status, "pending"));
    expect(drafts.length).toBe(1);
    expect(drafts[0].groupKey).toBe("arasaka");
    expect(drafts[0].proposedName).toBe("Arasaka");
  });

  it("a second run skips the still-pending group as a duplicate", async () => {
    const first = await runLoreImport();
    expect(first.created).toBe(1);

    const second = await runLoreImport();
    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(1);

    // Still exactly one pending draft — no duplicate row was inserted.
    const drafts = await db
      .select()
      .from(loreImportDrafts)
      .where(eq(loreImportDrafts.status, "pending"));
    expect(drafts.length).toBe(1);
  });

  it("two concurrent runs insert only one pending draft (partial unique index guard)", async () => {
    const [a, b] = await Promise.all([runLoreImport(), runLoreImport()]);

    // Across both runs exactly one row was created; the racer that lost the
    // onConflictDoNothing counts its group as a duplicate.
    expect(a.created + b.created).toBe(1);
    expect(a.duplicates + b.duplicates).toBe(1);

    const drafts = await db
      .select()
      .from(loreImportDrafts)
      .where(eq(loreImportDrafts.status, "pending"));
    expect(drafts.length).toBe(1);
  });

  it("re-imports a group again after the prior draft is resolved", async () => {
    const first = await runLoreImport();
    expect(first.created).toBe(1);

    // Resolve the pending draft (approved/discarded are excluded from the
    // partial unique index), so the group becomes importable again.
    await db
      .update(loreImportDrafts)
      .set({ status: "discarded" })
      .where(eq(loreImportDrafts.status, "pending"));

    const second = await runLoreImport();
    expect(second.created).toBe(1);
    expect(second.duplicates).toBe(0);

    const pending = await db
      .select()
      .from(loreImportDrafts)
      .where(eq(loreImportDrafts.status, "pending"));
    expect(pending.length).toBe(1);
  });
});
