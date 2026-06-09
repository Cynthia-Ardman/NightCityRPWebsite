import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Verifies the three onboarding gates that sit in front of the app shell:
// logged-out landing, the age-verification wall, and the rules splash.

test.describe("auth & onboarding gates", () => {
  test("logged-out visitor sees the Discord login landing", async ({ page }) => {
    // No storageState -> anonymous session.
    await page.goto("/");
    await expect(page.getByTestId("button-login-hero")).toBeVisible();
  });

  test("unverified member is held at the age-verification wall", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("unverified") });
    const page = await ctx.newPage();
    await page.goto("/");
    // The only screen an un-18+ member can reach: help-channel link, no app nav.
    await expect(page.getByTestId("link-help-channel")).toBeVisible();
    await expect(page.getByTestId("button-refresh-verification")).toBeVisible();
    await expect(page.getByTestId("link-brand-desktop")).toHaveCount(0);
    await ctx.close();
  });

  test("fresh member must accept the rules, then reaches the dashboard", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("fresh") });
    const page = await ctx.newPage();
    await page.goto("/");
    const accept = page.getByTestId("button-accept-rules");
    await expect(accept).toBeVisible();
    await accept.click();
    // Accepting persists rulesAccepted=true and drops the user into the app shell.
    await expect(page.getByTestId("text-dashboard-title")).toBeVisible();
    await expect(page.getByTestId("button-accept-rules")).toHaveCount(0);
    await ctx.close();
  });
});
