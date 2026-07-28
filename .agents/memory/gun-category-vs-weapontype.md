---
name: Gun category vs weaponType semantics
description: In catalog_guns, the Power/Tech/Smart firing class lives in `category`, not `weaponType`.
---

Rule: any predicate about a gun's firing class (Power/Tech/Smart) must read `catalog_guns.category` (lower/trim it). `weapon_type` is the form factor (pistol, shotgun, sniper_rifle, …).

**Why:** The column names invert intuition — a "Tech weapons" filter written against `weaponType` matches nothing (shipped nearly once in the tech-starting-weapon restriction; caught by an existing test seeding `category: "Power", weaponType: "Pistol"` and confirmed against live data).

**How to apply:** Whenever gating, filtering, or reporting on Tech/Smart/Power guns (server or portal — the client gun list exposes both fields), use `category`. Data also contains junk values (e.g. category "Pleasure"), so compare case-insensitively against the specific class you need.

- Gun-store SALE offers: store_stock.category is the FIRING CLASS (Power/Tech/Smart), never an inventory kind. completeSaleOffer must materialize buyer rows as category "gun" with attrs packed into notes ("Category: X · Power: L/M/H"), or guns list as "POWER" in the stash.
