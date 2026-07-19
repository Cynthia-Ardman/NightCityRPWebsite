import { test, expect } from "@playwright/test";
import { stateFile, TEST_PREFIX } from "./fixtures/roles";
import { withPool } from "./seed";

// Notification bell journey (player): a seeded unread notification shows the
// badge, opening the dropdown lists the row and marks everything read (badge
// clears), and clicking the row deep-links to its subject page.

const NOTIF_TITLE = "E2E seed: payout received";
const NOTIF_BODY = "You received 5,000 eddies from the e2e suite.";
const NOTIF_HREF = "/ledger";

test.describe("notification bell (player)", () => {
  test.use({ storageState: stateFile("player") });

  test.beforeAll(async () => {
    await withPool(async (pool) => {
      const userId = `${TEST_PREFIX}player`;
      // Idempotent: clear this user's notifications so the badge count is
      // deterministic, then seed exactly one unread row with a deep link.
      await pool.query(`delete from notifications where user_id = $1`, [userId]);
      await pool.query(
        `insert into notifications (user_id, type, title, body, href)
         values ($1, 'e2e', $2, $3, $4)`,
        [userId, NOTIF_TITLE, NOTIF_BODY, NOTIF_HREF],
      );
    });
  });

  test("badge shows, dropdown lists the row, mark-read clears, deep link navigates", async ({ page }) => {
    await page.goto("/");

    // The bell renders in both the desktop TopBar and the mobile header, so
    // always scope to the visible instance.
    const bell = page.getByTestId("button-notifications").locator("visible=true");
    const badge = page.getByTestId("badge-notifications-unread").locator("visible=true");

    await expect(bell).toBeVisible();
    await expect(badge).toHaveText("1");

    // Opening the feed lists the seeded row and fires mark-read (all: true).
    await bell.click();
    const dropdown = page.getByTestId("dropdown-notifications");
    await expect(dropdown).toBeVisible();
    const row = dropdown.getByText(NOTIF_TITLE);
    await expect(row).toBeVisible();
    await expect(dropdown.getByText(NOTIF_BODY)).toBeVisible();

    // Badge clears once the mark-read mutation settles and invalidates the
    // unread-count query (no 60s poll wait needed).
    await expect(badge).toHaveCount(0);

    // The row deep-links to its subject page.
    await row.click();
    await expect(page).toHaveURL(/\/ledger$/);
    await expect(page.getByTestId("text-ledger-title")).toBeVisible();

    // Server state agrees: the row is persisted as read.
    const readAt = await withPool(async (pool) => {
      const r = await pool.query<{ read_at: string | null }>(
        `select read_at from notifications where user_id = $1 and title = $2`,
        [`${TEST_PREFIX}player`, NOTIF_TITLE],
      );
      return r.rows[0]?.read_at ?? null;
    });
    expect(readAt).not.toBeNull();
  });
});
