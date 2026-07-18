---
name: Responsive dual-layout + Playwright strict mode
description: Mobile card + desktop table dual rendering duplicates text in the DOM and breaks strict-mode getByText asserts.
---

# Responsive dual layouts break strict-mode text locators

Portal mobile passes render the same data twice: a `md:hidden` stacked card list
plus a `hidden md:block` table (Ledger transactions, character Breach history).
Both live in the DOM simultaneously; only one is visible per breakpoint.

**Why:** Playwright `getByText(...)` strict mode throws on 2 matches, and
`.first()` can grab the *hidden* mobile copy at desktop viewport.

**How to apply:** in e2e specs asserting text that appears in a dual-layout
section, scope to the visible copy: `page.getByText(x).locator("visible=true")`
(add `.first()` if the visible side also repeats it). When adding a new mobile
card variant, expect existing text-based specs on that section to fail this way.
