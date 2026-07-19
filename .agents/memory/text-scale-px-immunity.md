---
name: Text-scale px immunity
description: Portal text-size setting scales rem-based sizes only; px-literal Tailwind sizes don't scale and read as complaints about "setting not working".
---

The Settings → Text Size feature works by setting `font-size: 110%/120%` on `<html>` (classes `text-scale-lg`/`text-scale-xl`), so only rem-based sizes scale. Any `text-[7px]`…`text-[11px]` literal is both immune to the setting and tiny by default.

**Why:** User reported the calendar text didn't resize — DirectoryCalendar used px literals for event chips, badges, and day headers.

**How to apply:** New micro-text must use rem arbitrary values (e.g. `text-[0.6875rem]`) instead of px literals. Many pages still contain intentional `text-[10px]`/`text-[11px]` metadata labels; when a user says "X doesn't resize", grep that component for px literals first.
