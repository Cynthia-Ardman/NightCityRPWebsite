// Canonical life-status presentation. Both the detail-header pill
// (LifeStatusPill) and the archive badge (CharacterBadges/StatusBadge) consume
// this so the same lifeStatus never renders in two different colors.

export type LifeStatus = "active" | "dead" | "missing" | "loa" | "retired";

type LifeStatusMeta = {
  label: string;
  // Tailwind tokens for each surface shape.
  text: string;
  border: string;
  dot: string;
};

export const LIFE_STATUS_META: Record<LifeStatus, LifeStatusMeta> = {
  active: { label: "ACTIVE", text: "text-emerald-400", border: "border-emerald-400", dot: "bg-emerald-400" },
  loa: { label: "LOA", text: "text-nc-cyan", border: "border-nc-cyan", dot: "bg-nc-cyan" },
  missing: { label: "MISSING", text: "text-orange-400", border: "border-orange-400", dot: "bg-orange-400" },
  dead: { label: "DEAD", text: "text-red-500", border: "border-red-500", dot: "bg-red-500" },
  retired: { label: "RETIRED", text: "text-nc-yellow", border: "border-nc-yellow", dot: "bg-nc-yellow" },
};

export function lifeStatusMeta(status: string): LifeStatusMeta {
  return LIFE_STATUS_META[(status in LIFE_STATUS_META ? status : "active") as LifeStatus];
}
