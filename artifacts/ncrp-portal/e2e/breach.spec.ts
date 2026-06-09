import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Breach Protocol journey: the practice hub renders its difficulty options,
// generate control, and the stats + leaderboard panels.

test.describe("breach practice (player)", () => {
  test.use({ storageState: stateFile("player") });

  test("practice hub renders difficulty options and panels", async ({ page }) => {
    await page.goto("/breach/practice");
    await expect(page.getByTestId("difficulty-easy")).toBeVisible();
    await expect(page.getByTestId("button-generate-practice")).toBeVisible();
    await expect(page.getByTestId("practice-stats")).toBeVisible();
    await expect(page.getByTestId("practice-leaderboard")).toBeVisible();
  });
});
