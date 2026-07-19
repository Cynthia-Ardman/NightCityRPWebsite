// Phone-width (390x844) layout regression guard. Loads the pages whose mobile
// layouts were verified manually (Ledger cards, character Breach tab, Missions
// All-tab filter bar) and asserts (a) no horizontal overflow and (b) the mobile
// card lists actually render — so a future change can't silently reintroduce
// sideways scrolling or hide the stacked card views.

import { test, expect, type Page } from "@playwright/test";
import { stateFile } from "./fixtures/roles";
import { withPool } from "./seed";

const PHONE = { width: 390, height: 844 };
const BREACH_SEED_LABEL = "E2E mobile layout seed";

let characterId: number;

test.beforeAll(async () => {
  await withPool(async (pool) => {
    const char = await pool.query<{ id: number }>(
      `select id from characters where owner_id = 'e2e-player' and name = 'E2E Test Runner' limit 1`,
    );
    if (!char.rows[0]) throw new Error("Seeded e2e character not found (global setup should have created it).");
    characterId = char.rows[0].id;

    // Idempotently seed one breach puzzle assigned to the character so the
    // Breach tab renders its mobile card list.
    await pool.query(`delete from breach_puzzles where context_label = $1`, [BREACH_SEED_LABEL]);
    await pool.query(
      `insert into breach_puzzles
         (created_by, assigned_user_id, assigned_character_id, assigned_character_name,
          difficulty, time_limit_seconds, grid, daemons, buffer_size, solution_count,
          context_label, status)
       values
         ('e2e-admin', 'e2e-player', $1, 'E2E Test Runner',
          'easy', 60, $2::jsonb, $3::jsonb, 4, 1, $4, 'sent')`,
      [
        characterId,
        JSON.stringify([
          ["1C", "55", "BD"],
          ["E9", "1C", "55"],
          ["BD", "E9", "1C"],
        ]),
        JSON.stringify([["1C", "55"]]),
        BREACH_SEED_LABEL,
      ],
    );
  });
});

async function assertNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBe(clientWidth);
}

test.describe("phone width — player pages", () => {
  test.use({ storageState: stateFile("player"), viewport: PHONE });

  test("ledger renders mobile cards with no horizontal overflow", async ({ page }) => {
    await page.goto("/ledger");
    await expect(page.getByTestId("text-ledger-title")).toBeVisible();
    // The stacked <li> card list (mobile-only) must render the seeded rows.
    await expect(page.locator('li[data-testid^="card-ledger-"]').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test("character breach tab renders mobile cards with no horizontal overflow", async ({ page }) => {
    await page.goto(`/characters/${characterId}#breach`);
    await expect(page.getByTestId("tab-breach")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="char-breach-card-"]').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

test.describe("phone width — fixer pages", () => {
  test.use({ storageState: stateFile("fixer"), viewport: PHONE });

  test("missions All tab filter bar fits with no horizontal overflow", async ({ page }) => {
    await page.goto("/missions");
    await expect(page.getByRole("heading", { name: "MISSIONS", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /ALL MISSIONS/ }).click();
    await expect(page.getByTestId("input-all-search")).toBeVisible();
    await expect(page.getByTestId("text-all-count")).toBeVisible();
    await expect(page.locator('[data-testid^="row-mission-"]').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});
