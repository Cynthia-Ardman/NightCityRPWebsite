import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  AvailabilityGrid,
  buildDayColumns,
  cellInstant,
  rowMinutes,
  patternFromInstants,
  expandPattern,
  AVAIL_DAYS,
  AVAIL_ROWS,
} from "./AvailabilityGrid";

describe("AvailabilityGrid helpers", () => {
  it("builds a 14-day window of local midnights and 48 half-hour rows", () => {
    const days = buildDayColumns(new Date("2026-06-18T15:00:00"));
    expect(days).toHaveLength(AVAIL_DAYS);
    expect(AVAIL_ROWS).toBe(48);
    for (const d of days) {
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
    }
    // Consecutive days.
    expect(days[1].getDate() - days[0].getDate()).toBe(1);
    expect(rowMinutes(2)).toBe(60);
  });

  it("round-trips a weekly pattern through instants in the same local frame", () => {
    const days = buildDayColumns();
    // Pick two concrete cells, derive their weekly pattern, re-expand.
    const picks = [cellInstant(days[0], 20), cellInstant(days[3], 24)];
    const pattern = patternFromInstants(picks);
    const expanded = expandPattern(pattern, days);
    // Every original pick must reappear after the round-trip.
    for (const p of picks) expect(expanded).toContain(p);
  });

  it("patternFromInstants dedupes same local weekday+minute and drops junk", () => {
    const days = buildDayColumns();
    const same = cellInstant(days[0], 10);
    // days[7] is the same weekday one week later → same weekday+minute slot.
    const weekLater = cellInstant(days[7], 10);
    const pattern = patternFromInstants([same, weekLater, "garbage"]);
    expect(pattern).toHaveLength(1);
  });
});

function ControlledEdit() {
  const [value, setValue] = useState<string[]>([]);
  return (
    <div>
      <AvailabilityGrid mode="edit" value={value} onChange={setValue} />
      <span data-testid="count">{value.length}</span>
    </div>
  );
}

describe("AvailabilityGrid edit mode", () => {
  it("toggles a cell on a pointer click and off on a second click", () => {
    render(<ControlledEdit />);
    const grid = screen.getByTestId("availability-grid-edit");
    const cell = grid.querySelector("button[data-iso]") as HTMLButtonElement;
    expect(cell.getAttribute("data-on")).toBe("0");

    fireEvent.pointerDown(cell);
    fireEvent.pointerUp(grid);
    expect(screen.getByTestId("count").textContent).toBe("1");

    const cellAfter = grid.querySelector("button[data-iso]") as HTMLButtonElement;
    fireEvent.pointerDown(cellAfter);
    fireEvent.pointerUp(grid);
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("drag-paints across cells while the pointer is held down", () => {
    render(<ControlledEdit />);
    const grid = screen.getByTestId("availability-grid-edit");
    const cells = grid.querySelectorAll("button[data-iso]");
    fireEvent.pointerDown(cells[0]);
    fireEvent.pointerEnter(cells[1]);
    fireEvent.pointerEnter(cells[2]);
    fireEvent.pointerUp(grid);
    // First cell + the two dragged-over cells.
    expect(Number(screen.getByTestId("count").textContent)).toBeGreaterThanOrEqual(3);
  });

  it("toggles time labels between 24-hour and 12-hour and remembers the choice", () => {
    localStorage.removeItem("ncrp.availability.hour12");
    const { unmount } = render(<ControlledEdit />);
    // Default is 24-hour: no AM/PM markers in the time column.
    expect(screen.queryByText(/AM|PM/)).toBeNull();

    const toggle = screen.getByTestId("availability-clock-toggle");
    fireEvent.click(within(toggle).getByText("12h"));
    expect(screen.getAllByText(/AM|PM/).length).toBeGreaterThan(0);
    expect(localStorage.getItem("ncrp.availability.hour12")).toBe("1");

    // Preference persists: a freshly mounted grid starts in 12-hour mode.
    unmount();
    render(<ControlledEdit />);
    expect(screen.getAllByText(/AM|PM/).length).toBeGreaterThan(0);

    // Back to 24-hour for a clean slate.
    fireEvent.click(within(screen.getByTestId("availability-clock-toggle")).getByText("24h"));
    expect(screen.queryByText(/AM|PM/)).toBeNull();
    localStorage.removeItem("ncrp.availability.hour12");
  });
});

describe("AvailabilityGrid heatmap mode", () => {
  it("shows an empty message when nobody supplied availability", () => {
    render(<AvailabilityGrid mode="heatmap" heatmap={[]} />);
    expect(screen.getByTestId("availability-heatmap-empty")).toBeTruthy();
  });

  it("reports the peak overlap count and marks overlapping cells", () => {
    const days = buildDayColumns();
    const shared = cellInstant(days[0], 20);
    const soloA = cellInstant(days[1], 10);
    const soloB = cellInstant(days[2], 30);
    render(
      <AvailabilityGrid
        mode="heatmap"
        heatmap={[
          { name: "Alice", slots: [shared, soloA] },
          { name: "Bob", slots: [shared, soloB] },
        ]}
      />,
    );
    // 2 of 2 players overlap on the shared slot.
    expect(screen.getByTestId("availability-peak").textContent).toContain("Max 2 of 2");
    const grid = screen.getByTestId("availability-grid-heatmap");
    const sharedCell = grid.querySelector(`[data-iso="${shared}"]`) as HTMLElement;
    expect(sharedCell.getAttribute("data-count")).toBe("2");
    const soloCell = grid.querySelector(`[data-iso="${soloA}"]`) as HTMLElement;
    expect(soloCell.getAttribute("data-count")).toBe("1");
  });

  it("surfaces the overlapping players' names on hover", () => {
    const days = buildDayColumns();
    const shared = cellInstant(days[0], 20);
    render(
      <AvailabilityGrid
        mode="heatmap"
        heatmap={[
          { name: "Alice", slots: [shared] },
          { name: "Bob", slots: [shared] },
        ]}
      />,
    );
    const grid = screen.getByTestId("availability-grid-heatmap");
    const sharedCell = grid.querySelector(`[data-iso="${shared}"]`) as HTMLElement;
    fireEvent.mouseEnter(sharedCell);
    const hover = within(screen.getByTestId("availability-hover"));
    expect(hover.queryByText(/Alice, Bob|Bob, Alice/)).toBeTruthy();
  });
});
