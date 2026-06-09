import { test, expect } from "@playwright/test";

// Minimal feasibility smoke test: prove a real browser launches in this
// environment and the portal renders. Real journeys live in the other specs.
test("portal shell loads and renders", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Night City RP Portal/);
});
