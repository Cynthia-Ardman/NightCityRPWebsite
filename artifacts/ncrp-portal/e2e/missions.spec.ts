import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Missions journey: the board renders its tabs for everyone, but the staff-only
// "create mission" affordance is gated to managers.

test.describe("missions board", () => {
  test.describe("as player", () => {
    test.use({ storageState: stateFile("player") });

    test("sees the open-missions tab but no create button", async ({ page }) => {
      await page.goto("/missions");
      await expect(page.getByTestId("tab-open")).toBeVisible();
      await expect(page.getByTestId("button-create-mission")).toHaveCount(0);
    });
  });

  test.describe("as admin", () => {
    test.use({ storageState: stateFile("admin") });

    test("can create missions", async ({ page }) => {
      await page.goto("/missions");
      await expect(page.getByTestId("button-create-mission")).toBeVisible();
    });
  });
});
