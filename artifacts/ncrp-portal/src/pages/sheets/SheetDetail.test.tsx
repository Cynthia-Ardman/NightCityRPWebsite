import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

// A sheet whose long-form fields all contain markdown. The detail view must
// render these through <Markdown>, not as literal asterisks.
const SHEET_DATA = {
  fullName: "Vincent Vega",
  nickname: "V",
  archetype: "Solo",
  age: 31,
  gender: "M",
  occupation: "**Mercenary** for hire",
  physicalDescription: "Tall with a *chrome* arm",
  appearance: "Leather and **neon**",
  psychProfile: "Loyal but *reckless*",
  background: "Grew up in **Heywood**",
  skills: "*Handguns* and stealth",
  gear: ["Pistol"],
  cyberware: [],
};

vi.mock("@workspace/api-client-react", () => ({
  useGetSheet: () => ({
    data: {
      id: 7,
      name: "Vincent Vega",
      status: "pending",
      ownerId: 999,
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      decisionNote: null,
      data: SHEET_DATA,
    },
    isLoading: false,
  }),
  useDecideSheet: () => ({ mutate: vi.fn(), isPending: false }),
  useListCyberware: () => ({ data: [] }),
  useGetMe: () => ({ data: { id: 1, isCsApprover: false, isAdmin: false, isFixer: false } }),
  getGetMeQueryKey: () => ["me"],
  getGetSheetQueryKey: (id: number) => ["sheets", id],
  getListPendingSheetsQueryKey: () => ["sheets", "pending"],
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: "7" }),
  useLocation: () => ["/sheets/7", vi.fn()],
}));

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

import SheetDetail from "./SheetDetail";

// Section title -> the bold text that must render as a <strong>, and the markup
// that must NOT appear literally on screen.
const MARKDOWN_SECTIONS: Array<{ title: string; bold?: string; em?: string; literal: string }> = [
  { title: "OCCUPATION / ROLE", bold: "Mercenary", literal: "**Mercenary**" },
  { title: "PHYSICAL DESCRIPTION", em: "chrome", literal: "*chrome*" },
  { title: "PSYCHOLOGICAL PROFILE", em: "reckless", literal: "*reckless*" },
  { title: "BACKGROUND", bold: "Heywood", literal: "**Heywood**" },
  { title: "SKILLS", em: "Handguns", literal: "*Handguns*" },
];

function sectionCard(title: string): HTMLElement {
  const heading = screen.getByText(title);
  // CardTitle -> CardHeader -> Card. The Card wraps both the header and the
  // CardContent that holds the rendered markdown.
  const card = heading.parentElement?.parentElement as HTMLElement;
  expect(card).toBeTruthy();
  return card;
}

describe("SheetDetail markdown rendering", () => {
  it("renders each long-form field as formatted markdown, not literal syntax", () => {
    render(<SheetDetail />);

    for (const section of MARKDOWN_SECTIONS) {
      const card = sectionCard(section.title);
      if (section.bold) {
        const el = within(card).getByText(section.bold);
        expect(el.tagName).toBe("STRONG");
      }
      if (section.em) {
        const el = within(card).getByText(section.em);
        expect(el.tagName).toBe("EM");
      }
      expect(card.textContent).not.toContain(section.literal);
    }
  });

  it("renders bold formatting in the physical-description style sub-field", () => {
    render(<SheetDetail />);
    const card = sectionCard("PHYSICAL DESCRIPTION");
    const neon = within(card).getByText("neon");
    expect(neon.tagName).toBe("STRONG");
    expect(card.textContent).not.toContain("**neon**");
  });
});
