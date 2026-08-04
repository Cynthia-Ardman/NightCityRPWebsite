/**
 * Typed href-builder functions for in-portal bell notifications.
 *
 * Every href produced here must match a real portal route. The companion test
 * (notification-hrefs.test.ts) imports both this module and PORTAL_ROUTES and
 * verifies all builders produce URLs that match at least one route pattern —
 * so adding a notification without adding a builder (or adding a builder for a
 * non-existent route) is caught automatically.
 *
 * Rule: add a builder whenever a new createNotification call site needs a new
 * href shape. Never write raw href strings inside createNotification calls.
 */

/**
 * Portal route patterns extracted verbatim from
 * artifacts/ncrp-portal/src/App.tsx (the <Switch> block).
 *
 * Keep in sync with App.tsx. The regression test verifies every href builder
 * resolves against this list, catching drift in either direction.
 * Redirect-only routes (e.g. /sheets/pending) are included so completeness is
 * enforced; the test only cares whether an href lands on *some* route.
 */
export const PORTAL_ROUTES: readonly string[] = [
  "/",
  "/login/error",
  "/logout/error",
  "/characters",
  "/characters/:id",
  "/sheets",
  "/sheets/new",
  "/sheets/pending",
  "/sheets/:id/edit",
  "/sheets/:id",
  "/pending-edits",
  "/pending-edits/:id",
  "/submissions",
  "/inbox",
  "/requests/mine",
  "/offers/mine",
  "/tickets/mine",
  "/breach/mine",
  "/breach/practice",
  "/breach/play/:id",
  "/breach/watch/:id",
  "/breach",
  "/requests",
  "/ledger",
  "/directory/stores",
  "/directory/stores/:id",
  "/directory/ripperdocs",
  "/directory/ripperdocs/:id",
  "/directory/characters",
  "/directory/map",
  "/directory/lore",
  "/directory/lore/section/:category",
  "/directory/lore/mine",
  "/directory/lore/new",
  "/directory/lore/import",
  "/directory/lore/:id/edit",
  "/directory/lore/:id",
  "/guidebook",
  "/guidebook/mine",
  "/guidebook/new",
  "/guidebook/import",
  "/guidebook/weapons",
  "/guidebook/rules",
  "/guidebook/:id/edit",
  "/guidebook/:id",
  "/directory/characters/:id",
  "/catalog/guns",
  "/catalog/cyberware",
  "/catalog/rent",
  "/stores",
  "/stores/:id",
  "/clinics",
  "/clinics/:id",
  "/ripperdoc",
  "/fixer",
  "/fixer/characters/new",
  "/fixer/missions",
  "/fixer/analytics",
  "/fixer/reports",
  "/fixer/pay-actors",
  "/fixer/items",
  "/fixer/players",
  "/fixer/cyberware-violations",
  "/fixer/off-map-properties",
  "/fixer/tag-roles",
  "/fixer/cyberpsycho",
  "/ncpd",
  "/ncpd/characters/:id",
  "/laws",
  "/items/:uuid",
  "/settings",
  "/dice",
  "/missions",
  "/missions/:id",
  "/fixers/:id",
  "/directory/calendar",
  "/events/:id",
  "/fixer/events",
  "/admin",
  "/admin/users/:userId",
] as const;

// ---------------------------------------------------------------------------
// Href builders — one per distinct notification href shape. Call sites import
// these instead of writing raw strings; the companion test verifies each one.
// ---------------------------------------------------------------------------

/** Player ledger — wallet-movement notifications (charges, fixer pay). */
export function hrefLedger(): string {
  return "/ledger";
}

/** Mission detail page. Falls back to ledger when missionId is nullish. */
export function hrefMissionOrLedger(missionId: number | null | undefined): string {
  return missionId != null ? `/missions/${missionId}` : "/ledger";
}

/** Mission detail page (always-present id). */
export function hrefMission(missionId: number | string): string {
  return `/missions/${missionId}`;
}

/** Player inbox — offers, NCPD fines, event tickets, sale offers. */
export function hrefInbox(): string {
  return "/inbox";
}

/** Player submissions page — custom request decisions. */
export function hrefSubmissions(): string {
  return "/submissions";
}

/**
 * Character detail — player-facing route (/characters/:id).
 * NOTE: do NOT use /directory/characters/:id for player-targeted notifications;
 * that route is staff-only (StaffArchiveGuard) and would redirect a player home.
 */
export function hrefCharacter(characterId: number | string): string {
  return `/characters/${characterId}`;
}

/** Character sheet detail. */
export function hrefSheet(sheetId: number | string): string {
  return `/sheets/${sheetId}`;
}

/** Breach Protocol play page. */
export function hrefBreachPlay(breachId: number | string): string {
  return `/breach/play/${breachId}`;
}

/** Lore entry detail page. */
export function hrefLoreEntry(loreId: number | string): string {
  return `/directory/lore/${loreId}`;
}

/** Staff lore submissions list (submitter is always staff). */
export function hrefLoreMine(): string {
  return "/directory/lore/mine";
}

/** Admin dashboard — for admin-targeted notifications (e.g. VRChat session). */
export function hrefAdmin(): string {
  return "/admin";
}
