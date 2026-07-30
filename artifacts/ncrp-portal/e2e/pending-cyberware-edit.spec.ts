import { test, expect } from "@playwright/test";
import { withPool } from "./seed";
import { stateFile } from "./fixtures/roles";

// Repro: player edits their submitted (pending) sheet and tries to
// remove/change cyberware.
test.use({ storageState: stateFile("player") });

let sheetId = 0;

test.beforeAll(async () => {
  await withPool(async (pool) => {
    const { rows: u } = await pool.query(`SELECT id FROM users WHERE id LIKE 'e2e-player%' LIMIT 1`);
    const ownerId = u[0].id;
    const data = {
      sheetType: "PC",
      fullName: "Chrome Edit Repro",
      pronouns: "they/them",
      occupation: "Merc",
      archetype: "Solo",
      gender: "n/a",
      physicalDescription: "Tall.",
      psychProfile: "Calm.",
      background: "Watson kid.",
      age: 27,
      skills: "Handguns 5",
      portraitUrls: ["https://example.com/p.png"],
      statsImageUrls: ["https://example.com/s.png"],
      cyberware: [
        { slot: "Ocular System", name: "SmartEyes", points: 2, notes: "" },
        { slot: "Neural", name: "Memory Bank", points: 2, notes: "" },
      ],
    };
    await pool.query(`DELETE FROM character_sheets WHERE name = 'Chrome Edit Repro'`);
    const { rows } = await pool.query(
      `INSERT INTO character_sheets (owner_id, name, status, data) VALUES ($1,$2,'pending',$3) RETURNING id`,
      [ownerId, "Chrome Edit Repro", JSON.stringify(data)],
    );
    sheetId = rows[0].id;
  });
});

test("owner can change an install on a pending sheet via the detail EDIT button", async ({ page }) => {
  await page.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "vite-error-overlay{display:none!important;pointer-events:none!important;}";
    document.documentElement.appendChild(s);
  });
  // Realistic entry: characters list -> pending card -> detail -> EDIT.
  await page.goto(`/sheets/${sheetId}`);
  await page.getByTestId("button-edit-sheet").click();
  await expect(page.getByTestId("text-new-sheet-title")).toHaveText(/EDIT CHARACTER/);
  await page.getByRole("tab", { name: /cyberware/i }).click();

  // Change row 0 to a different install that keeps the total under the cap.
  await page.getByTestId("select-cyberware-slot-0").selectOption("Neural");
  await page.getByTestId("select-cyberware-name-0").selectOption("Netrunner Suite (Level 1)");

  await page.waitForTimeout(4500);
  console.log("autosave status:", await page.getByTestId("text-autosave-status").textContent());

  const cw = await withPool(async (pool) => {
    const { rows } = await pool.query(`SELECT data->'cyberware' AS cw FROM character_sheets WHERE id = $1`, [sheetId]);
    return rows[0].cw;
  });
  console.log("server cyberware after change:", JSON.stringify(cw));
  expect(cw.some((c: any) => c.name === "Netrunner Suite (Level 1)")).toBe(true);
});

test("an over-cap change shows the server's reason instead of a bare failure", async ({ page }) => {
  await page.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "vite-error-overlay{display:none!important;pointer-events:none!important;}";
    document.documentElement.appendChild(s);
  });
  await page.goto(`/sheets/${sheetId}/edit`);
  await page.getByRole("tab", { name: /cyberware/i }).click();
  // Push over the 6-CWP cap (5 + existing 2).
  await page.getByTestId("select-cyberware-slot-0").selectOption("Neural");
  await page.getByTestId("select-cyberware-name-0").selectOption("Netrunner Suite (Level 3)");
  await page.waitForTimeout(4500);
  const status = await page.getByTestId("text-autosave-status").textContent();
  console.log("autosave status:", status);
  expect(status).toContain("Max 6 cyberware points");
});

test("owner can remove a cyberware row on a pending sheet and it persists", async ({ page }) => {
  await page.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "vite-error-overlay{display:none!important;pointer-events:none!important;}";
    document.documentElement.appendChild(s);
  });
  await page.goto(`/sheets/${sheetId}/edit`);
  await expect(page.getByTestId("text-new-sheet-title")).toHaveText(/EDIT CHARACTER/);

  // Go to the cyberware tab.
  await page.getByRole("tab", { name: /cyberware/i }).click();
  await expect(page.getByTestId("row-cyberware-0")).toBeVisible();
  await expect(page.getByTestId("row-cyberware-1")).toBeVisible();

  // Remove the second row.
  await page.getByTestId("button-remove-cyberware-1").click();
  await expect(page.getByTestId("row-cyberware-1")).toHaveCount(0);

  // Wait for autosave (3s debounce) or click save; then verify server state.
  await page.waitForTimeout(4500);
  const status = await page.getByTestId("text-autosave-status").textContent();
  console.log("autosave status:", status);

  const cw = await withPool(async (pool) => {
    const { rows } = await pool.query(`SELECT data->'cyberware' AS cw FROM character_sheets WHERE id = $1`, [sheetId]);
    return rows[0].cw;
  });
  console.log("server cyberware after edit:", JSON.stringify(cw));
  expect(Array.isArray(cw) ? cw.length : -1).toBe(1);
});
