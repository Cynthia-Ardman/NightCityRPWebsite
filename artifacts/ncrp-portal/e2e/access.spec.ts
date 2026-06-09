import { test, expect } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Verifies role-based route guards by VISIBLE outcome: a normal player is
// bounced from staff-only routes back to the dashboard, while staff roles can
// reach their respective hubs.

test.describe("role-based route access", () => {
  test.describe("as player", () => {
    test.use({ storageState: stateFile("player") });

    test("cannot open the staff requests queue", async ({ page }) => {
      await page.goto("/requests");
      // The guard redirects home; the pending-requests title never renders.
      await expect(page.getByTestId("text-dashboard-title")).toBeVisible();
      await expect(page.getByTestId("text-pending-requests-title")).toHaveCount(0);
    });

    test("cannot open the fixer player lookup", async ({ page }) => {
      await page.goto("/fixer/players");
      await expect(page.getByTestId("text-dashboard-title")).toBeVisible();
      await expect(page.getByTestId("text-fixer-title")).toHaveCount(0);
    });
  });

  test.describe("as admin", () => {
    test.use({ storageState: stateFile("admin") });

    test("can open the admin dashboard", async ({ page }) => {
      await page.goto("/admin");
      await expect(page.getByTestId("text-admin-title")).toBeVisible();
    });

    test("can open the staff requests queue", async ({ page }) => {
      await page.goto("/requests");
      await expect(page.getByTestId("text-pending-requests-title")).toBeVisible();
    });
  });

  test.describe("as fixer", () => {
    test.use({ storageState: stateFile("fixer") });

    test("can open the fixer hub", async ({ page }) => {
      await page.goto("/fixer");
      await expect(page.getByTestId("text-fixer-title")).toBeVisible();
    });

    test("can open the breach hub", async ({ page }) => {
      await page.goto("/breach");
      await expect(page.getByTestId("picker-character")).toBeVisible();
    });
  });

  test.describe("as archivist", () => {
    test.use({ storageState: stateFile("archivist") });

    test("is signed in and lands in the app shell (no gate)", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("link-brand-desktop")).toBeVisible();
      await expect(page.getByTestId("text-dashboard-title")).toBeVisible();
    });
  });
});
