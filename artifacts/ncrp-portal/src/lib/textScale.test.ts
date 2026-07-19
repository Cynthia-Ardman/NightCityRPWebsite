import { describe, expect, it, beforeEach } from "vitest";
import {
  TEXT_SCALE_STORAGE_KEY,
  getTextScale,
  setTextScale,
  applyTextScale,
} from "./textScale";

describe("textScale", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("text-scale-lg", "text-scale-xl");
  });

  it("defaults to 'default' when nothing is stored", () => {
    expect(getTextScale()).toBe("default");
  });

  it("falls back to 'default' on invalid stored values", () => {
    localStorage.setItem(TEXT_SCALE_STORAGE_KEY, "huge");
    expect(getTextScale()).toBe("default");
  });

  it("persists and applies lg/xl, and clears back to default", () => {
    setTextScale("xl");
    expect(getTextScale()).toBe("xl");
    expect(document.documentElement.classList.contains("text-scale-xl")).toBe(true);

    setTextScale("lg");
    expect(getTextScale()).toBe("lg");
    expect(document.documentElement.classList.contains("text-scale-lg")).toBe(true);
    expect(document.documentElement.classList.contains("text-scale-xl")).toBe(false);

    setTextScale("default");
    expect(getTextScale()).toBe("default");
    expect(localStorage.getItem(TEXT_SCALE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.className).not.toContain("text-scale");
  });

  it("applyTextScale swaps classes without touching storage", () => {
    applyTextScale("xl");
    expect(document.documentElement.classList.contains("text-scale-xl")).toBe(true);
    expect(localStorage.getItem(TEXT_SCALE_STORAGE_KEY)).toBeNull();
  });
});
