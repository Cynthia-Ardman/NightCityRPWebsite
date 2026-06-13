---
name: BucketSection double-grid trap
description: BucketSection is a pure section wrapper; callers own their grid/stack layout — don't double-wrap.
---

`BucketSection` (review/ReviewLifecycleUI.tsx) renders its children directly inside a `<section>` — it does NOT impose a grid. Each caller (bucket) is responsible for its own layout container.

**Why:** It used to wrap children in `grid grid-cols-3`. PendingEditsList's active bucket also wrapped its cards in their own `grid grid-cols-3`, so the inner grid landed as a single item in one column of the outer grid → all cards collapsed into ~1/3 width (squished, truncated titles). The bug was latent until a roster change shrank the cards' intrinsic content width and exposed it.

**How to apply:** When rendering into BucketSection, supply your own layout wrapper: card buckets use `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6`; full-width row buckets (EditRow) use `space-y-2`. Never nest a grid inside another grid-cols container expecting it to span all columns — a grid child occupies one cell, not the full row.
