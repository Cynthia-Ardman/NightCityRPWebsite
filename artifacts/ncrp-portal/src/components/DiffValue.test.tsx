import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import DiffValue from "./DiffValue";

// The review diff screens surface portrait / stat-sheet scans as thumbnails.
// These must be clickable so reviewers can open a large, readable view — and
// non-image URL fields (wiki / Discord prefab links) must NOT be treated as
// images, or they'd render as broken thumbnails.

const PORTRAIT = "/api/storage/objects/uploads/abc123";
const PORTRAIT_2 = "/api/storage/objects/uploads/def456";
const WIKI = "https://cyberpunk.fandom.com/wiki/Some_Gun";

function zoomButtons() {
  return screen.getAllByRole("button", { name: /view full-size image/i });
}

describe("DiffValue clickable images", () => {
  it("renders image-URL array thumbnails as clickable zoom buttons", () => {
    render(<DiffValue before={[]} after={[PORTRAIT, PORTRAIT_2]} />);
    expect(zoomButtons()).toHaveLength(2);
  });

  it("opens a large lightbox view when a thumbnail is clicked", () => {
    render(<DiffValue before={null} after={[PORTRAIT]} />);
    fireEvent.click(zoomButtons()[0]);
    const dialog = screen.getByRole("dialog");
    // The enlarged image is the only <img> inside the dialog overlay.
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", PORTRAIT);
  });

  it("renders a single image-URL string field as a clickable thumbnail", () => {
    render(<DiffValue before="" after={PORTRAIT} />);
    const buttons = zoomButtons();
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute("src", PORTRAIT);
  });

  it("shows removed + added thumbnails when a single image field changes", () => {
    render(<DiffValue before={PORTRAIT} after={PORTRAIT_2} />);
    expect(zoomButtons()).toHaveLength(2);
  });

  it("does NOT treat a non-image URL string as a clickable image", () => {
    render(<DiffValue before="" after={WIKI} />);
    expect(screen.queryByRole("button", { name: /view full-size image/i })).toBeNull();
  });

  it("renders single-image thumbnails in the split (plain) view too", () => {
    render(<DiffValue before={null} after={PORTRAIT} view="split" />);
    expect(zoomButtons().length).toBeGreaterThanOrEqual(1);
  });
});
