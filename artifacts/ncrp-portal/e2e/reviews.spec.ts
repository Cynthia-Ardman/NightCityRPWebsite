import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Reviews / approvals journey: staff approver roles can reach the unified
// character-sheet review queue. The standalone /sheets/pending page was retired
// and now redirects into the /requests queue's "sheets" (New Characters) tab.

test.describe("review queues", () => {
  test.describe("as admin", () => {
    test.use({ storageState: stateFile("admin") });

    test("legacy /sheets/pending redirects into the requests queue", async ({ page }) => {
      await page.goto("/sheets/pending");
      await expect(page).toHaveURL(/\/requests\?tab=sheets/);
      await expect(page.getByTestId("text-pending-requests-title")).toBeVisible();
      await expect(page.getByTestId("tab-sheets")).toHaveAttribute("data-state", "active");
    });
  });

  test.describe("as cs approver", () => {
    test.use({ storageState: stateFile("csapprover") });

    test("legacy /sheets/pending redirects into the requests queue", async ({ page }) => {
      await page.goto("/sheets/pending");
      await expect(page).toHaveURL(/\/requests\?tab=sheets/);
      await expect(page.getByTestId("text-pending-requests-title")).toBeVisible();
      await expect(page.getByTestId("tab-sheets")).toHaveAttribute("data-state", "active");
    });
  });
});
