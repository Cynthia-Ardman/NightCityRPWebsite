import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Character lifecycle (read + create entry point) for a normal player: the
// seeded character appears in the list, its detail page renders its name, and
// the new-sheet creation form is reachable and rendered.

test.describe("character journeys (player)", () => {
  test.use({ storageState: stateFile("player") });

  test("lists my seeded character and opens its detail page", async ({ page }) => {
    await page.goto("/characters");
    await expect(page.getByTestId("text-characters-title")).toBeVisible();

    const card = page
      .locator('[data-testid^="card-character-"]')
      .filter({ hasText: "E2E Test Runner" })
      .first();
    await expect(card).toBeVisible();
    await card.click();

    await expect(page.getByTestId("text-char-name")).toHaveText("E2E Test Runner");
  });

  test("can open the new character sheet form", async ({ page }) => {
    await page.goto("/sheets/new");
    await expect(page.getByTestId("text-new-sheet-title")).toBeVisible();
    await expect(page.getByTestId("input-fullname")).toBeVisible();
  });
});
