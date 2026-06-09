import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Commerce / catalog journey: the three player-facing catalogs (guns, cyberware,
// property) each render their heading and search affordance.

test.describe("catalogs (player)", () => {
  test.use({ storageState: stateFile("player") });

  test("guns catalog renders", async ({ page }) => {
    await page.goto("/catalog/guns");
    await expect(page.getByTestId("text-catalog-guns-title")).toBeVisible();
    await expect(page.getByTestId("input-search-guns")).toBeVisible();
  });

  test("cyberware catalog renders", async ({ page }) => {
    await page.goto("/catalog/cyberware");
    await expect(page.getByTestId("text-catalog-cyberware-title")).toBeVisible();
    await expect(page.getByTestId("input-search-cyberware")).toBeVisible();
  });

  test("property/rent catalog renders", async ({ page }) => {
    await page.goto("/catalog/rent");
    await expect(page.getByTestId("text-catalog-rent-title")).toBeVisible();
    await expect(page.getByTestId("input-search-rent")).toBeVisible();
  });
});
