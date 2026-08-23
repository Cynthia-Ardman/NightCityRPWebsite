---
name: Responsive editing dialogs
description: Product rule for deciding which portal dialogs should scale on ultrawide and mobile screens.
---

Substantial multi-field editing and request dialogs should use available desktop width up to a sensible maximum, reflow to one column on mobile, stay within the viewport with internal scrolling, and give long-form textareas meaningful height plus vertical resizing. Short confirmations, simple selectors, and one-purpose transaction prompts should remain compact.

**Why:** The user specifically wants editing workflows to use otherwise-wasted ultrawide space; the previous narrow item editor exposed only a few lines of notes at a time. Broadening every prompt would instead weaken hierarchy and make simple actions feel oversized.

**How to apply:** Use this pattern for forms with several fields, long notes/descriptions, uploads, or repeated editing. Preserve compact widths for destructive confirmations and short pickers. When overriding the shared dialog component, use matching responsive max-width variants so its built-in desktop width cannot take precedence.

A fixed pixel cap is not enough on ultrawide monitors — the user wants these dialogs to take roughly a third of the screen there. The agreed sizing is proportional: `width: min(100vw - 2rem, max(<floor>, 33vw))` (floor 64rem for the big editors, 56rem for mid-size ones), written in Tailwind as `w-[min(100vw_-_2rem,max(64rem,33vw))] max-w-none sm:max-w-none`. This keeps phones full-width, normal desktops at the floor, and ultrawides at ~33vw. When e2e-measuring dialog width, measure the dialog/card element itself — inner wrappers report misleading sizes.