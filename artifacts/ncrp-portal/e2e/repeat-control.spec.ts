/**
 * Focused e2e for the Repeat / recurrenceRule control added to the fixer
 * event create form. Runs against the live dev environment.
 */
import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Suppress Vite error overlay so it never intercepts clicks.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "vite-error-overlay{display:none!important;pointer-events:none!important;}";
    document.head.appendChild(s);
  });
});

test.use({ storageState: stateFile("fixer") });

test.describe("Repeat control — event create form", () => {
  test("default state: repeat select present, defaults to none, interval hidden", async ({
    page,
  }) => {
    await page.goto("/fixer/events");
    // Wait for the NEW EVENT form to appear.
    await expect(page.locator('[data-testid="input-event-title"]')).toBeVisible();

    const modeSelect = page.locator('[data-testid="select-repeat-mode"]');
    await expect(modeSelect).toBeVisible();
    // Default value should be "none".
    await expect(modeSelect).toHaveValue("none");

    // Interval input must not be visible while mode is "none".
    const intervalInput = page.locator('[data-testid="input-repeat-interval"]');
    await expect(intervalInput).not.toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/repeat-default-state.png", fullPage: false });
  });

  test("switching to Weekly reveals interval input with default=1", async ({ page }) => {
    await page.goto("/fixer/events");
    await expect(page.locator('[data-testid="input-event-title"]')).toBeVisible();

    const modeSelect = page.locator('[data-testid="select-repeat-mode"]');
    await modeSelect.selectOption("weekly");

    const intervalInput = page.locator('[data-testid="input-repeat-interval"]');
    await expect(intervalInput).toBeVisible();
    await expect(intervalInput).toHaveValue("1");

    // Help text should mention anchoring / open-ended.
    await expect(page.getByText(/anchor/i)).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/repeat-weekly-interval-visible.png", fullPage: false });
  });

  test("interval input accepts a custom value (4 weeks)", async ({ page }) => {
    await page.goto("/fixer/events");
    await expect(page.locator('[data-testid="input-event-title"]')).toBeVisible();

    await page.locator('[data-testid="select-repeat-mode"]').selectOption("weekly");
    const intervalInput = page.locator('[data-testid="input-repeat-interval"]');
    await expect(intervalInput).toBeVisible();

    await intervalInput.fill("4");
    await expect(intervalInput).toHaveValue("4");

    await page.screenshot({ path: "e2e/screenshots/repeat-interval-4.png", fullPage: false });
  });

  test("session event type disables the Repeat select", async ({ page }) => {
    await page.goto("/fixer/events");
    await expect(page.locator('[data-testid="input-event-title"]')).toBeVisible();

    // First enable Weekly so we can confirm it collapses when type switches.
    await page.locator('[data-testid="select-repeat-mode"]').selectOption("weekly");
    await expect(page.locator('[data-testid="input-repeat-interval"]')).toBeVisible();

    // Switch event type to "session".
    await page.locator('[data-testid="select-event-type"]').selectOption("session");

    const modeSelect = page.locator('[data-testid="select-repeat-mode"]');
    // Select must be disabled for sessions.
    await expect(modeSelect).toBeDisabled();
    // Interval input should be gone (session forces mode to "none" display-side).
    await expect(page.locator('[data-testid="input-repeat-interval"]')).not.toBeVisible();
    // The label note should mention sessions / not applicable.
    await expect(page.getByText(/not applicable/i)).toBeVisible();

    await page.screenshot({ path: "e2e/screenshots/repeat-session-disabled.png", fullPage: false });
  });
});
