import { test, expect, request as playwrightRequest } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// End-to-end verification of the logged-out public rules pages.
// All tests run WITHOUT a session (no storageState) except where noted in
// comments (admin API calls to seed/verify non-public page data).
//
// Test coverage:
//  1. /guidebook shows the MUST READ row publicly.
//  2. /start-here "Rules at a Glance" link navigates to /guidebook/rules.
//  3. /guidebook/rules hub loads; each "read the full …" card link deep-links
//     to the correct heading anchor on the detail pages and the target heading
//     element exists and is scrolled into view.
//  4. Table-of-contents jump links on the RP Rules detail page scroll to the
//     correct headings. (Avatar Restrictions has only 2 headings → TOC
//     threshold of 3 not met → no TOC rendered — verified as expected behaviour.)
//  5. Anchor-scroll verification repeated on mobile viewport (390×844).
//  6. Non-public guidebook pages are inaccessible to anonymous visitors: the
//     API list excludes them and direct detail URLs return 404/not-found UI.

// IDs in the dev DB (verified stable). If a re-import changes them the tests
// will fail on the anchor-navigate steps, making the drift obvious.
const RP_RULES_ID = 3;
const AVATAR_RESTRICTIONS_ID = 4;

// Anchor ids on the RP Rules page — derived by the same slugifyHeading() that
// the Markdown renderer uses (emoji and ** stripped, spaces → hyphens).
const ANCHOR_SERVER_RULES = "server-rules";
const ANCHOR_SAFETY_RULES = "platform-content-safety-rules";
const ANCHOR_RP_RULES = "rp-rules";

// ── Shared helper ─────────────────────────────────────────────────────────────

/**
 * After navigating to a page with a hash, the component waits 100 ms then
 * calls scrollIntoView. We wait for the element to exist in the DOM and then
 * check its bounding rect is within the viewport.
 */
async function assertAnchorScrolled(page: import("@playwright/test").Page, anchorId: string) {
  const heading = page.locator(`#${anchorId}`).first();
  await expect(heading).toBeAttached({ timeout: 8_000 });
  // Give the 100-ms deferred scroll time to complete.
  await page.waitForTimeout(500);
  const inView = await heading.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    // The heading should be at or near the top of the viewport (within 200px)
    // and not below the fold entirely.
    return rect.top >= -10 && rect.top < vh * 0.6;
  });
  expect(inView, `Heading #${anchorId} should be scrolled into view`).toBe(true);
}

// ── 1. Guidebook index shows MUST READ publicly ───────────────────────────────

test.describe("guidebook public visibility", () => {
  // No storageState → anonymous/logged-out visitor.

  test("1. /guidebook shows MUST READ row without login", async ({ page }) => {
    await page.goto("/guidebook");
    // Must Read section rendered
    await expect(page.getByTestId("section-guidebook-must-read")).toBeVisible();
    // The Rules-at-a-Glance hub card is inside it
    await expect(page.getByTestId("card-guidebook-rules-hub").first()).toBeVisible();
  });
});

// ── 2. Start Here / Home "Rules at a Glance" link ────────────────────────────

test.describe("start-here rules link", () => {
  // StartHere renders at "/" for logged-out visitors (Home redirects there
  // when !user). There is no /start-here URL; navigating to "/" is correct.
  test("2. / landing page 'Rules at a Glance' link navigates to /guidebook/rules", async ({ page }) => {
    await page.goto("/");
    // Wait for the StartHere page to render (not the loading spinner)
    const link = page.getByTestId("link-start-rules");
    await expect(link).toBeVisible({ timeout: 10_000 });

    // The link element from wouter is an <a>; the testid is on the <a> itself.
    await expect(link).toHaveAttribute("href", /\/guidebook\/rules/);

    await link.click();
    await expect(page).toHaveURL(/\/guidebook\/rules/);
    // Rules hub title renders
    await expect(page.getByTestId("text-rules-hub-title")).toBeVisible();
  });
});

// ── 3. /guidebook/rules hub card links + anchor scrolling (desktop) ───────────
//
// NOTE: data-testid="link-rules-full-*" is on the inner <Button>, not the
// wrapping wouter <Link> (<a>). We therefore get the href by traversing to
// the ancestor <a> element, then navigate directly so the hash triggers the
// deferred scrollIntoView.

test.describe("rules hub deep-links – desktop", () => {
  async function getHubLinkHref(page: import("@playwright/test").Page, testId: string): Promise<string> {
    const button = page.getByTestId(testId);
    await expect(button).toBeVisible();
    // Walk up to the wrapping <a> (wouter renders <Link> as <a>).
    const href = await button.evaluate((el) => {
      const a = el.closest("a");
      return a ? a.getAttribute("href") : null;
    });
    if (!href) throw new Error(`No href found on ancestor <a> for [data-testid="${testId}"]`);
    return href;
  }

  test("3a. Server Rules card links to /guidebook/:id#server-rules and heading is visible", async ({ page }) => {
    await page.goto("/guidebook/rules");
    await expect(page.getByTestId("text-rules-hub-title")).toBeVisible();

    const href = await getHubLinkHref(page, "link-rules-full-server");
    expect(href).toContain(`/guidebook/${RP_RULES_ID}`);
    expect(href).toContain(`#${ANCHOR_SERVER_RULES}`);

    await page.goto(href);
    await assertAnchorScrolled(page, ANCHOR_SERVER_RULES);
  });

  test("3b. Platform & Content Safety card links to correct anchor and heading is visible", async ({ page }) => {
    await page.goto("/guidebook/rules");
    await expect(page.getByTestId("text-rules-hub-title")).toBeVisible();

    const href = await getHubLinkHref(page, "link-rules-full-safety");
    expect(href).toContain(`/guidebook/${RP_RULES_ID}`);
    expect(href).toContain(`#${ANCHOR_SAFETY_RULES}`);

    await page.goto(href);
    await assertAnchorScrolled(page, ANCHOR_SAFETY_RULES);
  });

  test("3c. RP Rules card links to correct anchor and heading is visible", async ({ page }) => {
    await page.goto("/guidebook/rules");
    await expect(page.getByTestId("text-rules-hub-title")).toBeVisible();

    const href = await getHubLinkHref(page, "link-rules-full-rp");
    expect(href).toContain(`/guidebook/${RP_RULES_ID}`);
    expect(href).toContain(`#${ANCHOR_RP_RULES}`);

    await page.goto(href);
    await assertAnchorScrolled(page, ANCHOR_RP_RULES);
  });

  test("3d. Avatar Rules card links to /guidebook/:id (no anchor) and page loads", async ({ page }) => {
    await page.goto("/guidebook/rules");
    await expect(page.getByTestId("text-rules-hub-title")).toBeVisible();

    const href = await getHubLinkHref(page, "link-rules-full-avatar");
    expect(href).toContain(`/guidebook/${AVATAR_RESTRICTIONS_ID}`);
    expect(href).not.toContain("#");

    await page.goto(href);
    await expect(page.getByTestId("text-guidebook-name")).toBeVisible({ timeout: 10_000 });
    const name = await page.getByTestId("text-guidebook-name").first().textContent();
    expect(name).toMatch(/avatar/i);
  });
});

// ── 4. Table-of-contents jump links (desktop) ─────────────────────────────────

test.describe("table-of-contents jump links – desktop", () => {
  test("4a. RP Rules page renders a TOC and jump links scroll to correct headings", async ({ page }) => {
    await page.goto(`/guidebook/${RP_RULES_ID}`);
    await expect(page.getByTestId("text-guidebook-body")).toBeVisible();

    const toc = page.getByTestId("nav-guidebook-toc");
    await expect(toc).toBeVisible();

    // Click each of the three expected TOC entries and verify scroll
    for (const anchor of [ANCHOR_SERVER_RULES, ANCHOR_SAFETY_RULES, ANCHOR_RP_RULES]) {
      const tocLink = page.getByTestId(`link-toc-${anchor}`);
      await expect(tocLink).toBeVisible();
      await tocLink.click();
      await page.waitForTimeout(400);
      await assertAnchorScrolled(page, anchor);
    }
  });

  test("4b. Avatar Restrictions page has < 3 headings so no TOC is rendered (expected)", async ({ page }) => {
    await page.goto(`/guidebook/${AVATAR_RESTRICTIONS_ID}`);
    await expect(page.getByTestId("text-guidebook-body")).toBeVisible();
    // With only 2 headings the component does not render the TOC nav — this is
    // expected behaviour. Assert it is absent so the test fails loudly if
    // content is added and the TOC threshold is crossed without updating this spec.
    await expect(page.getByTestId("nav-guidebook-toc")).toHaveCount(0);
  });
});

// ── 5. Anchor-scroll on mobile viewport (390×844) ─────────────────────────────

test.describe("anchor deep-links – mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("5a. #server-rules anchor scrolls into view on mobile", async ({ page }) => {
    await page.goto(`/guidebook/${RP_RULES_ID}#${ANCHOR_SERVER_RULES}`);
    await assertAnchorScrolled(page, ANCHOR_SERVER_RULES);
  });

  test("5b. #platform-content-safety-rules anchor scrolls into view on mobile", async ({ page }) => {
    await page.goto(`/guidebook/${RP_RULES_ID}#${ANCHOR_SAFETY_RULES}`);
    await assertAnchorScrolled(page, ANCHOR_SAFETY_RULES);
  });

  test("5c. #rp-rules anchor scrolls into view on mobile", async ({ page }) => {
    await page.goto(`/guidebook/${RP_RULES_ID}#${ANCHOR_RP_RULES}`);
    await assertAnchorScrolled(page, ANCHOR_RP_RULES);
  });

  test("5d. Rules hub card links are visible and functional on mobile", async ({ page }) => {
    await page.goto("/guidebook/rules");
    // On mobile the cards stack; all four rule-area cards should be present.
    for (const key of ["server", "safety", "rp", "avatar"]) {
      await expect(page.getByTestId(`card-rules-area-${key}`).first()).toBeVisible();
    }
  });
});

// ── 6. Non-public pages are inaccessible to anonymous visitors ────────────────

test.describe("non-public page access control", () => {
  // Track the ID of the non-public page we create so we can delete it after.
  let nonPublicPageId: number | null = null;

  test.beforeAll(async () => {
    // Create a non-public page via the admin API session.
    const adminCtx = await playwrightRequest.newContext({
      baseURL: `https://${process.env.REPLIT_DEV_DOMAIN}`,
      storageState: stateFile("admin"),
    });
    const res = await adminCtx.post("/api/guidebook", {
      data: {
        section: "rules",
        title: "E2E Test — Non-Public Page",
        description: "Created by the guidebook-public e2e spec; not for display.",
        body: "# Not for players\n\nThis page is private.",
        publicRead: false,
      },
    });
    if (!res.ok()) {
      console.warn("Could not create non-public page for test 6:", res.status(), await res.text());
    } else {
      const page = await res.json() as { id: number };
      nonPublicPageId = page.id;
    }
    await adminCtx.dispose();
  });

  test.afterAll(async () => {
    if (nonPublicPageId == null) return;
    const adminCtx = await playwrightRequest.newContext({
      baseURL: `https://${process.env.REPLIT_DEV_DOMAIN}`,
      storageState: stateFile("admin"),
    });
    await adminCtx.delete(`/api/guidebook/${nonPublicPageId}`);
    await adminCtx.dispose();
  });

  test("6a. API list endpoint excludes non-public pages when called anonymously", async ({ request }) => {
    const res = await request.get("/api/guidebook");
    expect(res.ok()).toBe(true);
    const body = await res.json() as { sections: Array<{ pages: Array<{ publicRead: boolean; title: string }> }> };
    const allPages = body.sections.flatMap((s) => s.pages);
    // Every page returned must have publicRead = true
    for (const p of allPages) {
      expect(p.publicRead, `Page "${p.title}" in anonymous list has publicRead=false`).toBe(true);
    }
    // Our non-public test page must not appear in the list
    if (nonPublicPageId != null) {
      const found = body.sections.flatMap((s) => s.pages).some((p: { title: string }) =>
        p.title === "E2E Test — Non-Public Page",
      );
      expect(found, "Non-public test page should not appear in anonymous list").toBe(false);
    }
  });

  test("6b. API detail endpoint returns 404 for a non-public page when called anonymously", async ({ request }) => {
    if (nonPublicPageId == null) {
      test.skip(true, "Non-public page was not seeded (admin API unavailable)");
      return;
    }
    const res = await request.get(`/api/guidebook/${nonPublicPageId}`);
    expect(res.status()).toBe(404);
  });

  test("6c. Navigating directly to a non-public page shows not-found UI", async ({ page }) => {
    if (nonPublicPageId == null) {
      test.skip(true, "Non-public page was not seeded (admin API unavailable)");
      return;
    }
    await page.goto(`/guidebook/${nonPublicPageId}`);
    // The component renders "GUIDEBOOK PAGE NOT FOUND" for a 404 response.
    await expect(
      page.getByText("GUIDEBOOK PAGE NOT FOUND", { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // No page body should render
    await expect(page.getByTestId("text-guidebook-body")).toHaveCount(0);
  });
});
