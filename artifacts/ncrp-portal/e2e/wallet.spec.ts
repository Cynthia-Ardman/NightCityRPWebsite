import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";
import { STARTING_FUNDS_MEMO, GEAR_PURCHASE_MEMO } from "./seed";

// Wallet / ledger journey: the player's ledger renders and lists the seeded
// transaction rows (memo + eddies), which come straight from the database.

test.describe("wallet & ledger (player)", () => {
  test.use({ storageState: stateFile("player") });

  test("ledger lists the seeded transactions", async ({ page }) => {
    await page.goto("/ledger");
    await expect(page.getByTestId("text-ledger-title")).toBeVisible();
    // Each memo renders twice in the DOM (hidden mobile card + desktop
    // table), so assert on the visible occurrence rather than a unique match.
    await expect(page.getByText(STARTING_FUNDS_MEMO).locator("visible=true")).toBeVisible();
    await expect(page.getByText(GEAR_PURCHASE_MEMO).locator("visible=true")).toBeVisible();
    // The credited amount is rendered in eddies on the same ledger.
    await expect(page.getByText("50,000 €$").locator("visible=true").first()).toBeVisible();
  });
});
