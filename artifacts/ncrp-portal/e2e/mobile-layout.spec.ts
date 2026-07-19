import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

test.use({
  storageState: stateFile("admin"),
  viewport: { width: 390, height: 844 },
});

async function assertNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBe(clientWidth);
}

test("mission board cards fit at 390px", async ({ page }) => {
  await page.goto("/missions");
  await expect(page.getByRole("heading", { name: "MISSIONS", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /ALL MISSIONS/ }).click();
  await expect(page.locator('[data-testid^="row-mission-"]').first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.locator('[data-testid^="row-mission-"]').first().screenshot({ path: "/tmp/missions-390.png" });
});

test("character inventory rows stack at 390px", async ({ page }) => {
  await page.goto("/characters/11");
  await expect(page.getByRole("tab", { name: /INVENTORY/i })).toBeVisible({ timeout: 15000 });
  await page.getByRole("tab", { name: /INVENTORY/i }).click();
  await expect(page.locator('[data-testid^="row-item-"]').first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.locator('[data-testid="list-inventory"]').screenshot({ path: "/tmp/inventory-390.png" });
});
