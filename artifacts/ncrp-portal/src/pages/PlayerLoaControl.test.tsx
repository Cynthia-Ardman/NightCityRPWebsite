import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// LOA is billing-sensitive: a character flagged `loa` is skipped by the
// auto-billed rent/fee jobs. The dashboard exposes ONE switch per player that
// must fan the toggle out to EVERY one of their characters — leaving any
// character un-flagged would silently keep billing them while on leave.
//
// We back the mocked client with a mutable per-character status map so that
// `updateCharacterStatus` mutates it and the follow-up refetch (after the
// mutation's onSuccess invalidation) reads the new aggregate state — exactly
// how the real query/mutation cycle behaves.
const h = vi.hoisted(() => ({
  statuses: new Map<number, boolean>(),
  update: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    getGetCharacterStatusQueryKey: (id: number) => ["character-status", id],
    getCharacterStatus: async (id: number) => ({
      loa: h.statuses.get(id) ?? false,
      attending: false,
      openShop: false,
      statusMessage: "",
      loaReturnsAt: null,
      updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    }),
    updateCharacterStatus: async (id: number, data: { loa?: boolean }) => {
      h.update(id, data);
      if (typeof data.loa === "boolean") h.statuses.set(id, data.loa);
      return {
        loa: h.statuses.get(id) ?? false,
        attending: false,
        openShop: false,
        statusMessage: "",
        loaReturnsAt: null,
        updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      };
    },
  };
});

import { PlayerLoaControl } from "./Home";

const CHARACTERS = [
  { id: 1, name: "Vance" },
  { id: 2, name: "Mox" },
  { id: 3, name: "Riptide" },
];

function renderControl(characters = CHARACTERS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlayerLoaControl characters={characters} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.statuses.clear();
  h.update.mockReset();
});

describe("PlayerLoaControl — single switch fans out to all characters", () => {
  it("toggling on issues an LOA update for EVERY character", async () => {
    const user = userEvent.setup();
    renderControl();

    const sw = await screen.findByTestId("switch-player-loa");
    // Starts off (no one on leave) and becomes interactive once every
    // character's status has loaded.
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).not.toBeChecked();

    await user.click(sw);

    // Every character must get its own update — a missed id keeps billing.
    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(CHARACTERS.length));
    for (const c of CHARACTERS) {
      expect(h.update).toHaveBeenCalledWith(c.id, { loa: true });
    }

    // After the mutation's invalidation refetch, all characters read as on
    // leave, so the aggregate switch flips to "on".
    await waitFor(() => expect(sw).toBeChecked());
  });

  it("toggling off clears LOA for EVERY character", async () => {
    h.statuses.set(1, true);
    h.statuses.set(2, true);
    h.statuses.set(3, true);
    const user = userEvent.setup();
    renderControl();

    const sw = await screen.findByTestId("switch-player-loa");
    await waitFor(() => expect(sw).toBeChecked());

    await user.click(sw);

    await waitFor(() => expect(h.update).toHaveBeenCalledTimes(CHARACTERS.length));
    for (const c of CHARACTERS) {
      expect(h.update).toHaveBeenCalledWith(c.id, { loa: false });
    }

    await waitFor(() => expect(sw).not.toBeChecked());
  });
});

describe("PlayerLoaControl — aggregate state reflection", () => {
  it("shows ON only when ALL characters are on LOA", async () => {
    // Mixed/partial state: most are on leave but one is not.
    h.statuses.set(1, true);
    h.statuses.set(2, true);
    h.statuses.set(3, false);
    renderControl();

    const sw = await screen.findByTestId("switch-player-loa");
    await waitFor(() => expect(sw).not.toBeDisabled());
    // A partial state must read as OFF so a single toggle re-asserts the
    // player-wide intent across everyone.
    expect(sw).not.toBeChecked();
  });

  it("shows ON when every character is on LOA", async () => {
    h.statuses.set(1, true);
    h.statuses.set(2, true);
    h.statuses.set(3, true);
    renderControl();

    const sw = await screen.findByTestId("switch-player-loa");
    await waitFor(() => expect(sw).toBeChecked());
  });
});
