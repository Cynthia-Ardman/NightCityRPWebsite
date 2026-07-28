import { test } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

test.use({ storageState: stateFile("fixer") });

test("screenshot char 132 cyberware tab", async ({ page }) => {
  await page.goto("/directory/characters/132");
  await page.getByRole("tab", { name: /cyberware/i }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "/tmp/char132-cyberware.png", fullPage: true });
});
