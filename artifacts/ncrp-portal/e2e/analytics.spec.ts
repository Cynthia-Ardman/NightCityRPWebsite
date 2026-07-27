import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Staff analytics page: verify the new drill-down surfaces render — the
// activity-trend chart, and the dialogs behind the missions / economy /
// VRChat charts and top-world rows.
test.describe("fixer analytics drill-downs", () => {
  test.use({ storageState: stateFile("admin") });

  test("page renders charts and drill-down dialogs open", async ({ page }) => {
    await page.goto("/fixer/analytics");
    await expect(page.getByTestId("text-analytics-title")).toBeVisible();

    // Data loads (charts replace the loading pulse).
    await expect(page.getByTestId("chart-economy-weekly")).toBeVisible({ timeout: 20_000 });

    // New activity-trend chart (snapshot job has run in this env).
    await expect(page.getByTestId("chart-activity-trend")).toBeVisible();

    // Trend drill-down: click mid-chart, expect the gained/lost dialog.
    await page.getByTestId("chart-activity-trend").click({ position: { x: 300, y: 100 } });
    await expect(page.getByTestId("dialog-character-trend")).toBeVisible();
    await expect(page.getByTestId("dialog-character-trend").getByText("BECAME ACTIVE —")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("dialog-character-trend")).not.toBeVisible();

    // Missions drill-down.
    await page.getByTestId("chart-missions-weekly").click({ position: { x: 300, y: 100 } });
    await expect(page.getByTestId("dialog-missions-week")).toBeVisible();
    await expect(page.getByTestId("stat-week-player-payout")).toBeVisible();
    await page.keyboard.press("Escape");

    // Economy drill-down: week -> category list.
    await page.getByTestId("chart-economy-weekly").click({ position: { x: 300, y: 100 } });
    await expect(page.getByTestId("dialog-economy-week")).toBeVisible();
    await expect(page.getByText("CREATED (INTO WALLETS)")).toBeVisible();
    await page.keyboard.press("Escape");

    // VRChat: top-world row opens the instances dialog with per-instance stats.
    const worldButton = page.locator('[data-testid^="button-vr-world-"]').first();
    if (await worldButton.count()) {
      await worldButton.click();
      await expect(page.getByTestId("dialog-vrchat-instances")).toBeVisible();
      await expect(page.locator('[data-testid^="card-instance-"]').first()).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
    }
  });
});
