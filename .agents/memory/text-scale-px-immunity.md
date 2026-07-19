---
name: Text-scale px immunity
description: Portal text-size setting scales rem-based sizes only; px-literal Tailwind sizes don't scale and read as complaints about "setting not working".
---

The Settings → Text Size feature works by setting `font-size: 110%/120%` on `<html>` (classes `text-scale-lg`/`text-scale-xl`), so only rem-based sizes scale. Any `text-[7px]`…`text-[11px]` literal is both immune to the setting and tiny by default.

**Why:** User reported the calendar text didn't resize — DirectoryCalendar used px literals for event chips, badges, and day headers.

**How to apply:** New micro-text must use rem arbitrary values (e.g. `text-[0.6875rem]` = 11px base) instead of px literals. Calendar mapping used: 7px→0.5625rem, 8px→0.625rem, 9px→0.6875rem, 10px→0.75rem, 11px→0.8125rem (each also a +1–2px readability bump). Other pages still contain `text-[10px]`/`text-[11px]` literals that are intentionally tiny metadata, but if a user says "X doesn't resize", check for px literals first.
