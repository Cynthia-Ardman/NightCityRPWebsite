import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Reviews / approvals journey: staff approver roles can reach the pending
// character-sheet review queue.

test.describe("review queues", () => {
  test.describe("as admin", () => {
    test.use({ storageState: stateFile("admin") });

    test("can open the pending sheets queue", async ({ page }) => {
      await page.goto("/sheets/pending");
      await expect(page.getByTestId("text-pending-title")).toBeVisible();
    });
  });

  test.describe("as cs approver", () => {
    test.use({ storageState: stateFile("csapprover") });

    test("can open the pending sheets queue", async ({ page }) => {
      await page.goto("/sheets/pending");
      await expect(page.getByTestId("text-pending-title")).toBeVisible();
    });
  });
});
