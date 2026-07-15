import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

test.describe("city map sub-districts", () => {
  test.use({ storageState: stateFile("player") });
  test("hovering a neighborhood label highlights only that sub-district", async ({ page }) => {
    await page.goto("/directory/lore");
    const svg = page.getByTestId("svg-night-city-map");
    await expect(svg).toBeVisible();

    const kabukiLabel = page.getByTestId("rect-sublabel-kabuki");
    await kabukiLabel.hover();

    const kabukiPoly = page.getByTestId("polygon-subdistrict-kabuki");
    await expect(kabukiPoly).toHaveAttribute("fill-opacity", "0.35");
    // parent district highlight suppressed while a sub-label is hovered
    const watsonPoly = page.getByTestId("polygon-district-watson");
    await expect(watsonPoly).toHaveAttribute("fill-opacity", "0");
    // hover info box shows the sub-district name
    await expect(page.getByTestId("text-map-hover-info")).toContainText("Kabuki");
  });

  test("clicking a neighborhood label with a lore entry navigates to it", async ({ page }) => {
    await page.goto("/directory/lore");
    const dogtown = page.getByTestId("rect-sublabel-dogtown");
    await dogtown.hover();
    await expect(page.getByTestId("polygon-subdistrict-dogtown")).toHaveAttribute("fill-opacity", "0.35");
    await dogtown.click();
    await expect(page).toHaveURL(/\/directory\/lore\/\d+/);
  });

  test("district body hover still highlights the whole district", async ({ page }) => {
    await page.goto("/directory/lore");
    const watsonPoly = page.getByTestId("polygon-district-watson");
    // hover a point inside Watson but away from any label hitbox
    await watsonPoly.hover({ position: { x: 0, y: 0 }, force: true });
    await page.getByTestId("svg-night-city-map").hover({ position: { x: 100, y: 100 }, force: true });
    // move over watson polygon interior via mouse coords: use bounding box center offset
    const box = (await page.getByTestId("svg-night-city-map").boundingBox())!;
    // Watson interior point ~ (1300/3825, 700/3699) of the svg
    await page.mouse.move(box.x + box.width * 0.34, box.y + box.height * 0.19);
    await expect(watsonPoly).toHaveAttribute("fill-opacity", "0.28");
  });
});
