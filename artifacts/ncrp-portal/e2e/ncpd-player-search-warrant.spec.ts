import { test, expect } from "@playwright/test";
import { withPool } from "./seed";
import { stateFile } from "./fixtures/roles";

// NCPD: lookup by PLAYER name groups all their characters, and the warrants
// board's NEW WARRANT dialog can pick a suspect via the same search.
// Fixers have NCPD access, so we reuse the fixer fixture.
test.use({ storageState: stateFile("fixer") });

let charId = 0;

test.beforeAll(async () => {
  await withPool(async (pool) => {
    const { rows: u } = await pool.query(`SELECT id FROM users WHERE id = 'e2e-player'`);
    const ownerId = u[0].id;
    await pool.query(`DELETE FROM ncpd_warrants WHERE reason LIKE 'E2E warrant repro%'`);
    await pool.query(`DELETE FROM characters WHERE name IN ('Warrant Target One','Warrant Target Two')`);
    const { rows } = await pool.query(
      `INSERT INTO characters (owner_id, name, kind) VALUES ($1,'Warrant Target One','pc'),($1,'Warrant Target Two','pc') RETURNING id`,
      [ownerId],
    );
    charId = rows[0].id;
  });
});

test("lookup by player name shows all of the player's characters grouped", async ({ page }) => {
  await page.goto("/ncpd");
  await page.getByTestId("tab-ncpd-lookup").click();
  await page.getByTestId("input-ncpd-search").fill("E2E Player");
  await expect(page.getByText(/PLAYER: /)).toBeVisible();
  await expect(page.getByText("Warrant Target One")).toBeVisible();
  await expect(page.getByText("Warrant Target Two")).toBeVisible();
});

test("NEW WARRANT on the board: search player, pick character, issue", async ({ page }) => {
  await page.goto("/ncpd");
  await page.getByTestId("button-ncpd-new-warrant").click();
  await page.getByTestId("input-ncpd-search").fill("E2E Player");
  await page.getByTestId(`card-ncpd-char-${charId}`).click();
  await expect(page.getByTestId("text-warrant-suspect")).toHaveText("Warrant Target One");
  await page.getByTestId("input-new-warrant-reason").fill("E2E warrant repro — jaywalking");
  await page.getByTestId("button-new-warrant-submit").click();
  await expect(page.getByText("E2E warrant repro — jaywalking")).toBeVisible();
  // Persisted server-side.
  const count = await withPool(async (pool) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ncpd_warrants WHERE character_id = $1 AND reason LIKE 'E2E warrant repro%'`,
      [charId],
    );
    return rows[0].n;
  });
  expect(count).toBe(1);
});
