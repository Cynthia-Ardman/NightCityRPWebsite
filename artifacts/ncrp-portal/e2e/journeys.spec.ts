import { test, expect, type Browser, type Page } from "@playwright/test";
import { stateFile, TEST_PREFIX, type RoleKey } from "./fixtures/roles";
import {
  withPool,
  JOURNEY_SHEET_NAME,
  JOURNEY_MISSION_TITLE,
  JOURNEY_LISTING_NAME,
} from "./seed";

// Full create-and-approve journeys. Each describe.serial block walks one
// multi-step write flow across roles (player → staff → player) and asserts the
// visible state change at the end, plus the durable DB row where the UI can't
// show it (wallet balances come from UnbelievaBoat and are not seedable).
//
// The suite runs with workers=1, so the serial steps inside each block always
// execute in order and a failed step skips the rest of its journey.

// Open a page as a specific seeded role (fresh context per call, cookie state
// from global-setup's test-login).
async function pageAs(browser: Browser, role: RoleKey): Promise<Page> {
  const ctx = await browser.newContext({ storageState: stateFile(role) });
  const page = await ctx.newPage();
  // The Vite dev-server error overlay pops on benign runtime errors (e.g. the
  // expected /api/me/wallet 502 when UnbelievaBoat has no e2e account) and
  // intercepts all pointer events, which breaks clicks. Strip it as it appears.
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "vite-error-overlay{display:none!important;pointer-events:none!important;}";
    const attach = () => (document.head ?? document.documentElement).appendChild(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach);
  });
  return page;
}

async function closePage(page: Page): Promise<void> {
  const ctx = page.context();
  await page.close();
  await ctx.close();
}

// A tiny valid 1x1 transparent PNG for the sheet portrait/stats uploads.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const pngFile = (name: string) => ({ name, mimeType: "image/png", buffer: TINY_PNG });

// ---------------------------------------------------------------------------
// Journey 1 — Character sheet: player submits a new sheet, an admin approves
// (override) + closes it from the review queue, and the materialized character
// shows up for the player.
// ---------------------------------------------------------------------------

test.describe.serial("journey: character sheet create → approve → visible", () => {
  let sheetId: number;

  test("player fills out and submits a new sheet", async ({ browser }) => {
    const page = await pageAs(browser, "player");
    await page.goto("/sheets/new");
    // Identity tab (default): all the required identity fields.
    await page.getByTestId("input-fullname").fill(JOURNEY_SHEET_NAME);
    await page.getByTestId("input-pronouns").fill("they/them");
    await page.getByTestId("input-age").fill("27");
    await page.getByTestId("input-occupation").fill("Solo for hire");

    // Story tab: description / psychology / background / skills sub-tabs.
    await page.getByTestId("tab-new-story").click();
    await page.getByTestId("input-physical").fill("Tall, wiry, chrome left arm.");
    await page.getByTestId("subtab-new-psychology").click();
    await page.getByTestId("input-psych").fill("Cool under pressure, hates corps.");
    await page.getByTestId("subtab-new-background").click();
    await page.getByTestId("input-background").fill("Grew up in the combat zone running jobs.");
    await page.getByTestId("subtab-new-skills").click();
    await page.getByTestId("input-skills").fill("Marksmanship, stealth, street knowledge.");

    // Portrait + stats screenshot are required to submit (drafts aren't).
    // The uploads go through the real presigned-URL object-storage flow.
    await page.getByTestId("input-upload-sheet-portrait").setInputFiles(pngFile("portrait.png"));
    // The uploaded 1x1 test png renders at zero size, so assert attachment
    // (upload finished + card rendered) rather than visibility.
    await expect(page.getByTestId("img-card-sheet-portrait-0")).toBeAttached({ timeout: 20_000 });
    await page.getByTestId("input-upload-sheet-stats").setInputFiles(pngFile("stats.png"));
    await expect(page.getByTestId("img-card-sheet-stats-0")).toBeAttached({ timeout: 20_000 });

    await page.getByTestId("button-submit-sheet").click();
    // Successful submission navigates back to the characters page.
    await expect(page).toHaveURL(/\/characters/, { timeout: 20_000 });

    const row = await withPool((pool) =>
      pool.query<{ id: number; status: string }>(
        `select id, status from character_sheets where owner_id = $1 and name = $2 order by id desc limit 1`,
        [`${TEST_PREFIX}player`, JOURNEY_SHEET_NAME],
      ),
    );
    expect(row.rows[0]).toBeTruthy();
    expect(row.rows[0].status).toBe("pending");
    sheetId = row.rows[0].id;
    await closePage(page);
  });

  test("admin approves via override and closes from the review queue", async ({ browser }) => {
    const page = await pageAs(browser, "admin");

    // Approve: admin override bypasses the cs-approver majority vote (the pool
    // of eligible reviewers in the shared dev DB isn't deterministic).
    await page.goto(`/sheets/${sheetId}`);
    await page.getByTestId("button-override").click();
    // The override only STAGES the approval; the queue card now offers
    // "CLOSE & APPLY", which materializes the character.
    await page.goto("/requests?tab=sheets");
    await page.getByTestId(`button-close-sheet-${sheetId}`).click();
    await page.getByTestId(`button-confirm-close-sheet-${sheetId}`).click();
    await expect(page.getByTestId(`button-close-sheet-${sheetId}`)).toHaveCount(0, {
      timeout: 20_000,
    });

    const char = await withPool((pool) =>
      pool.query<{ id: number; approved: boolean }>(
        `select id, approved from characters where owner_id = $1 and name = $2 limit 1`,
        [`${TEST_PREFIX}player`, JOURNEY_SHEET_NAME],
      ),
    );
    expect(char.rows[0]).toBeTruthy();
    expect(char.rows[0].approved).toBe(true);
    await closePage(page);
  });

  test("player sees the new character on /characters", async ({ browser }) => {
    const page = await pageAs(browser, "player");
    await page.goto("/characters");
    await expect(page.getByText(JOURNEY_SHEET_NAME).first()).toBeVisible();
    await closePage(page);
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — Mission lifecycle: fixer authors + submits, admin approves,
// fixer posts, player applies, fixer accepts + completes, and the completed
// state is visible.
// ---------------------------------------------------------------------------

test.describe.serial("journey: mission create → apply → complete", () => {
  let missionId: number;
  let applicationId: number;

  test("fixer creates a mission and submits it for approval", async ({ browser }) => {
    const page = await pageAs(browser, "fixer");
    await page.goto("/fixer/missions");
    await page.getByTestId("input-mission-title").fill(JOURNEY_MISSION_TITLE);
    await page.getByTestId("select-mission-jobtype").selectOption("combat");
    await page.getByTestId("input-mission-playerpay").fill("500");
    await page.getByTestId("button-submit-approval").click();
    // The create form resets once create + submit both succeed.
    await expect(page.getByTestId("input-mission-title")).toHaveValue("", { timeout: 20_000 });

    const row = await withPool((pool) =>
      pool.query<{ id: number; workflow_state: string; player_pay: number }>(
        `select id, workflow_state, player_pay from missions where title = $1 order by id desc limit 1`,
        [JOURNEY_MISSION_TITLE],
      ),
    );
    expect(row.rows[0]).toBeTruthy();
    expect(row.rows[0].workflow_state).toBe("proposal");
    expect(row.rows[0].player_pay).toBe(500);
    missionId = row.rows[0].id;
    await closePage(page);
  });

  test("admin approves the proposal (auto-posts to the board)", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    await page.goto(`/missions/${missionId}`);
    // The workflow panel lives on the FIXER tab.
    await page.getByTestId("tab-fixer").click();
    await page.getByTestId("button-approve").click();
    // approveMission delegates to postMission, so approval lands directly in
    // the posted/live state.
    await expect(page.getByText("Live on the public board.")).toBeVisible();

    const row = await withPool((pool) =>
      pool.query<{ workflow_state: string }>(`select workflow_state from missions where id = $1`, [
        missionId,
      ]),
    );
    expect(row.rows[0].workflow_state).toBe("posted");
    await closePage(page);
  });

  test("player applies with their character", async ({ browser }) => {
    const page = await pageAs(browser, "player");
    await page.goto(`/missions/${missionId}`);
    await expect(page.getByTestId("block-apply")).toBeVisible();
    await page.getByTestId("select-apply-character").selectOption({ label: "E2E Test Runner" });
    await page.getByTestId("input-apply-comment").fill("E2E journey application");
    await page.getByTestId("button-apply-submit").click();
    // A pending application replaces the apply form with a WITHDRAW option.
    await expect(page.getByTestId("button-withdraw")).toBeVisible();

    const row = await withPool((pool) =>
      pool.query<{ id: number; status: string }>(
        `select id, status from mission_applications where mission_id = $1 and user_id = $2 order by id desc limit 1`,
        [missionId, `${TEST_PREFIX}player`],
      ),
    );
    expect(row.rows[0]).toBeTruthy();
    expect(row.rows[0].status).toBe("pending");
    applicationId = row.rows[0].id;
    await closePage(page);
  });

  test("fixer accepts the application and completes the mission", async ({ browser }) => {
    const page = await pageAs(browser, "fixer");
    await page.goto(`/missions/${missionId}`);
    await page.getByTestId("tab-fixer").click();

    await page.getByTestId(`button-accept-${applicationId}`).click();
    // Accepting moves the player onto the roster.
    await expect(page.getByTestId(`button-accept-${applicationId}`)).toHaveCount(0);
    // The roster row is also the payout ledger: the auto-pay cron settles it
    // after completion (wallet balances live in UnbelievaBoat and can't be
    // asserted here), so check the payment fields are staged for payout.
    const roster = await withPool((pool) =>
      pool.query<{ id: number; payment_status: string }>(
        `select id, payment_status from mission_assignments where mission_id = $1 and user_id = $2 limit 1`,
        [missionId, `${TEST_PREFIX}player`],
      ),
    );
    expect(roster.rows[0]).toBeTruthy();
    expect(roster.rows[0].payment_status).toBe("unpaid");

    // Completion asks for a native confirm() before locking payments.
    page.on("dialog", (d) => void d.accept());
    await page.getByTestId("button-complete-mission").click();
    await expect(page.getByTestId("text-completed-meta")).toBeVisible();

    // Completion stamps completedAt/completedBy; the status column is a
    // separate open/closed signup toggle and is not flipped by completion.
    const done = await withPool((pool) =>
      pool.query<{ completed_at: string | null; completed_by: string | null }>(
        `select completed_at, completed_by from missions where id = $1`,
        [missionId],
      ),
    );
    expect(done.rows[0].completed_at).not.toBeNull();
    expect(done.rows[0].completed_by).toBe(`${TEST_PREFIX}fixer`);

    // Post-completion payout staging: the roster row survives completion with
    // payment_status still 'unpaid' (the auto-pay cron settles it later) and
    // the mission's player pay is locked in for the cron to disburse.
    const payout = await withPool((pool) =>
      pool.query<{ payment_status: string; player_pay: number }>(
        `select a.payment_status, m.player_pay
           from mission_assignments a join missions m on m.id = a.mission_id
          where a.mission_id = $1 and a.user_id = $2`,
        [missionId, `${TEST_PREFIX}player`],
      ),
    );
    expect(payout.rows).toHaveLength(1);
    expect(payout.rows[0].payment_status).toBe("unpaid");
    expect(Number(payout.rows[0].player_pay)).toBe(500);
    await closePage(page);
  });

  test("player sees the completed mission state", async ({ browser }) => {
    const page = await pageAs(browser, "player");
    await page.goto(`/missions/${missionId}`);
    await expect(page.getByTestId("text-completed-meta")).toBeVisible();
    // The apply block is gone once the mission is closed out.
    await expect(page.getByTestId("block-apply")).toHaveCount(0);
    await closePage(page);
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — Commerce: player self-leases a seeded residential listing; the
// unit shows occupied to players and the occupant is visible to staff.
// ---------------------------------------------------------------------------

test.describe.serial("journey: residential lease → occupancy visible", () => {
  let listingId: number;
  let characterId: number;

  test.beforeAll(async () => {
    const rows = await withPool(async (pool) => {
      const listing = await pool.query<{ id: number }>(
        `select id from catalog_rent where name = $1 limit 1`,
        [JOURNEY_LISTING_NAME],
      );
      const char = await pool.query<{ id: number }>(
        `select id from characters where owner_id = $1 and name = 'E2E Test Runner' limit 1`,
        [`${TEST_PREFIX}player`],
      );
      return { listing: listing.rows[0], char: char.rows[0] };
    });
    expect(rows.listing).toBeTruthy();
    expect(rows.char).toBeTruthy();
    listingId = rows.listing.id;
    characterId = rows.char.id;
  });

  test("player signs the lease from the rent catalog", async ({ browser }) => {
    const page = await pageAs(browser, "player");
    await page.goto("/catalog/rent");
    await page.getByTestId("input-search-rent").fill(JOURNEY_LISTING_NAME);
    await page.getByTestId(`button-lease-${listingId}`).click();
    await expect(page.getByTestId("dialog-lease")).toBeVisible();
    await page.getByTestId(`option-lease-char-${characterId}`).click();
    await page.getByTestId("button-confirm-lease").click();

    // The list refreshes and the unit flips to NOT AVAILABLE for players.
    await expect(page.getByTestId(`badge-unavailable-${listingId}`)).toBeVisible({
      timeout: 20_000,
    });

    const lease = await withPool((pool) =>
      pool.query<{ id: number; kind: string }>(
        `select id, kind from housing where listing_id = $1 and character_id = $2 limit 1`,
        [listingId, characterId],
      ),
    );
    expect(lease.rows[0]).toBeTruthy();
    expect(lease.rows[0].kind).toBe("residential");
    await closePage(page);
  });

  test("staff sees the occupant on the listing", async ({ browser }) => {
    const page = await pageAs(browser, "admin");
    await page.goto("/catalog/rent");
    await page.getByTestId("input-search-rent").fill(JOURNEY_LISTING_NAME);
    await expect(page.getByTestId(`text-occupant-${listingId}`)).toContainText("E2E Test Runner");
    await closePage(page);
  });
});
