import { test, expect, type Page } from "@playwright/test";
import { stateFile } from "./fixtures/roles";

// Sweep dense staff pages at the Extra Large (120%) text setting and assert
// there is no horizontal overflow of the document. The XL scale is applied
// pre-paint via localStorage (same mechanism the Settings page uses).

test.use({ storageState: stateFile("admin") });

async function assertNoHorizontalOverflow(page: Page, label: string) {
  // Allow layout to settle after data loads.
  await page.waitForTimeout(300);
  // Guard: the sweep is only meaningful if the XL scale is actually applied
  // (server hydration could theoretically overwrite the local choice).
  const xlActive = await page.evaluate(() =>
    document.documentElement.classList.contains("text-scale-xl"),
  );
  expect(xlActive, `${label}: text-scale-xl must be active during the check`).toBe(true);
  const { scrollWidth, clientWidth, offenders } = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = doc.clientWidth;
    // The app's <main> is overflow-x-clip, so an oversized child gets visually
    // clipped without ever widening the document. Catch those too: any visible
    // element whose box extends past the viewport, unless it (or an ancestor)
    // is an intentional horizontal scroll container.
    const isScrollContainer = (el: Element) => {
      const o = getComputedStyle(el).overflowX;
      return o === "auto" || o === "scroll";
    };
    const insideScroller = (el: Element) => {
      let cur: Element | null = el.parentElement;
      while (cur && cur !== document.body) {
        if (isScrollContainer(cur)) return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll("main *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > viewport + 1 || r.left < -1) {
        if (insideScroller(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (cs.position === "fixed") continue;
        const id = el.getAttribute("data-testid") || el.id || "";
        bad.push(
          `<${el.tagName.toLowerCase()}${id ? ` ${id}` : ""} class="${(el.className || "").toString().slice(0, 80)}" left=${Math.round(r.left)} right=${Math.round(r.right)}>`,
        );
        if (bad.length >= 5) break;
      }
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: viewport, offenders: bad };
  });
  expect(scrollWidth, `${label}: document should not overflow horizontally`).toBeLessThanOrEqual(
    clientWidth,
  );
  expect(offenders, `${label}: elements clipped past the viewport:\n${offenders.join("\n")}`).toEqual([]);
}

const PAGES: { path: string; ready: (page: Page) => Promise<void>; label: string }[] = [
  {
    path: "/fixer",
    label: "Fixer Hub",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: /FIXER/i }).first()).toBeVisible({ timeout: 15000 });
    },
  },
  {
    path: "/admin",
    label: "Admin Dashboard",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: /ADMIN/i }).first()).toBeVisible({ timeout: 15000 });
    },
  },
  {
    path: "/requests",
    label: "Review queues",
    ready: async (page) => {
      await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 15000 });
    },
  },
  {
    // Resolve a real character id at runtime (admin can staff-read any
    // character) instead of hardcoding a seeded id.
    path: "/",
    label: "Character detail",
    ready: async (page) => {
      const res = await page.request.get("/api/directory/characters");
      expect(res.ok(), "directory characters roster should load").toBe(true);
      const body = (await res.json()) as { characters?: { id: number }[] } | { id: number }[];
      const list = Array.isArray(body) ? body : (body.characters ?? []);
      expect(list.length, "at least one character must exist").toBeGreaterThan(0);
      await page.goto(`/characters/${list[0].id}`);
      await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 15000 });
    },
  },
  {
    path: "/fixer/players",
    label: "Fixer player lookup",
    ready: async (page) => {
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15000 });
    },
  },
  {
    path: "/fixer/reports",
    label: "Fixer reports",
    ready: async (page) => {
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15000 });
    },
  },
  {
    path: "/missions",
    label: "Mission board",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "MISSIONS", exact: true })).toBeVisible({ timeout: 15000 });
    },
  },
  {
    path: "/ledger",
    label: "Ledger",
    ready: async (page) => {
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15000 });
    },
  },
];

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(`XL text @ ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("ncrp-text-scale", "xl");
        } catch {
          /* ignore */
        }
        document.documentElement.classList.add("text-scale-xl");
      });
    });

    for (const p of PAGES) {
      test(`${p.label} has no horizontal overflow`, async ({ page }) => {
        await page.goto(p.path);
        await p.ready(page);
        await assertNoHorizontalOverflow(page, `${p.label} (${viewport.name})`);
      });
    }
  });
}
