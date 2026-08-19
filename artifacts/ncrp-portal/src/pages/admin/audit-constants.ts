// Pre-built sub-tabs (category groupings) for the unified audit log. An
// optional `actions` list narrows a single-category fetch down to specific
// audit actions client-side (e.g. the Payouts tab pulls "mission" rows and
// keeps only the money-out actions).
const PAYOUT_ACTIONS = [
  "mission.npc_confirm",
  "mission.autopay_players",
  "mission.pay_actors",
  "actor.pay_standalone",
];

export const AUDIT_SUBTABS: Array<{ key: string; label: string; categories: string[]; actions?: string[] }> = [
  { key: "all", label: "All", categories: [] },
  { key: "auth", label: "Auth", categories: ["auth"] },
  { key: "wallet", label: "Wallet", categories: ["wallet"] },
  { key: "payouts", label: "Payouts", categories: ["mission"], actions: PAYOUT_ACTIONS },
  { key: "characters", label: "Characters", categories: ["character"] },
  { key: "sheets", label: "Sheets", categories: ["sheet"] },
  { key: "shop_attend", label: "Shop & Attend", categories: ["shop", "attendance"] },
  { key: "mission", label: "Missions", categories: ["mission"] },
  { key: "admin", label: "Admin", categories: ["admin"] },
];

// Deep-link map: given a targetType + targetId, where does clicking the entry
// take the investigator? null-returning types have no viewable page.
const AUDIT_TARGET_LINKS: Record<string, (id: string) => string | null> = {
  character: (id) => `/characters/${id}`,
  mission: (id) => `/missions/${id}`,
  user: (id) => `/admin/users/${id}`,
  store: (id) => `/stores/${id}`,
  ripperdoc: (id) => `/clinics/${id}`,
  sheet: (id) => `/sheets/${id}`,
  event: (id) => `/events/${id}`,
  custom_request: () => `/requests`,
  lore_entry: (id) => `/directory/lore/${id}`,
  guidebook_page: (id) => `/guidebook/${id}`,
  pending_character_edit: (id) => `/pending-edits/${id}`,
  catalog_gun: () => `/catalog/guns`,
  catalog_cyberware: () => `/catalog/cyberware`,
  catalog_rent: () => `/catalog/rent`,
  housing: () => `/catalog/rent`,
};

// Target types whose destination page doesn't need an id — these can link
// even when the audit row recorded no targetId.
const AUDIT_STATIC_TARGETS = new Set(["custom_request", "catalog_gun", "catalog_cyberware", "catalog_rent", "housing"]);

export function auditTargetLink(targetType?: string | null, targetId?: string | null): string | null {
  if (!targetType) return null;
  const fn = AUDIT_TARGET_LINKS[targetType];
  if (!fn) return null;
  if (!targetId && !AUDIT_STATIC_TARGETS.has(targetType)) return null;
  return fn(targetId ?? "");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function fmtAuditValue(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  const s = JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export const AUDIT_PAGE_SIZE = 100;
