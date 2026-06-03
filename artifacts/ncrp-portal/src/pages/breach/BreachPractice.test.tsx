import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import BreachPractice from "./BreachPractice";

// The practice page is deliberately 100% client-side: it generates puzzles
// locally, keeps stats in localStorage, and must NEVER call the backend (no
// result recording, no reward payout). These tests pin that contract: generate
// -> play to a result (via the timer) -> replay, and assert no network at all.

describe("BreachPractice", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
    );
    // Spy on every plausible network surface so an accidental fetch/XHR is caught.
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("generates a puzzle, plays to a result, and replays — with no backend calls", async () => {
    render(<BreachPractice />);

    // Page shell: heading, the "not recorded" promise, and the local stats card.
    expect(screen.getByText("BREACH PRACTICE")).toBeInTheDocument();
    expect(screen.getByText(/not recorded/i)).toBeInTheDocument();
    expect(screen.getByTestId("practice-stats")).toBeInTheDocument();

    // No board until the player generates one.
    expect(screen.queryByTestId("cell-0-0")).not.toBeInTheDocument();

    // Generate a puzzle -> the code matrix renders.
    fireEvent.click(screen.getByTestId("button-generate-practice"));
    expect(screen.getByTestId("cell-0-0")).toBeInTheDocument();

    // Play to a result by letting the run's timer expire (default difficulty is
    // medium = 60s). This ends the run client-side and shows the result overlay.
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });

    const resultTitle = screen.getByText(
      /BREACH SUCCESSFUL|BREACH FAILED|TRACE COMPLETE — TIME UP/,
    );
    expect(resultTitle).toBeInTheDocument();
    const replay = screen.getByTestId("button-replay-practice");
    expect(replay).toBeInTheDocument();

    // Replay -> a fresh board, and the previous result overlay is gone.
    fireEvent.click(replay);
    expect(screen.getByTestId("cell-0-0")).toBeInTheDocument();
    expect(
      screen.queryByText(/BREACH SUCCESSFUL|BREACH FAILED|TRACE COMPLETE — TIME UP/),
    ).not.toBeInTheDocument();

    // The whole flow must be unrecorded: no network call of any kind.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
