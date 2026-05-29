import { Badge } from "@/components/ui/badge";

// Color-coded status badges for the Character Archive. Every badge carries an
// explicit text label — colour is reinforcement, never the sole signal — so the
// archive stays readable for colour-blind staff and in greyscale.

const base = "rounded-none text-[10px] font-mono uppercase tracking-wider";

export function KindBadge({ kind }: { kind: string }) {
  const isNpc = kind === "npc";
  return (
    <Badge
      variant="outline"
      className={`${base} ${isNpc ? "border-nc-magenta text-nc-magenta" : "border-nc-cyan text-nc-cyan"}`}
      data-testid="badge-kind"
    >
      {isNpc ? "NPC" : "PC"}
    </Badge>
  );
}

export function LifecycleBadge({ archived }: { archived: boolean }) {
  return (
    <Badge
      variant="outline"
      className={`${base} ${archived ? "border-nc-yellow text-nc-yellow" : "border-emerald-400 text-emerald-400"}`}
      data-testid="badge-lifecycle"
    >
      {archived ? "RETIRED" : "ACTIVE"}
    </Badge>
  );
}

export function ClaimBadge({ claimed }: { claimed: boolean }) {
  return (
    <Badge
      variant="outline"
      className={`${base} ${claimed ? "border-emerald-400 text-emerald-400" : "border-nc-magenta text-nc-magenta"}`}
      data-testid="badge-claim"
    >
      {claimed ? "CLAIMED" : "UNCLAIMED"}
    </Badge>
  );
}

export type CwpBand = "organic" | "none" | "medium" | "high" | "extreme";

const CWP_STYLES: Record<CwpBand, string> = {
  organic: "border-emerald-400 text-emerald-400",
  none: "border-muted-foreground text-muted-foreground",
  medium: "border-nc-yellow text-nc-yellow",
  high: "border-orange-400 text-orange-400",
  extreme: "border-red-500 text-red-500",
};

const CWP_LABELS: Record<CwpBand, string> = {
  organic: "ORGANIC",
  none: "CWP: NONE",
  medium: "CWP: MEDIUM",
  high: "CWP: HIGH",
  extreme: "CWP: EXTREME",
};

export function CwpBadge({ band }: { band: CwpBand }) {
  const b = (CWP_STYLES[band] ? band : "none") as CwpBand;
  return (
    <Badge variant="outline" className={`${base} ${CWP_STYLES[b]}`} data-testid="badge-cwp">
      {CWP_LABELS[b]}
    </Badge>
  );
}

export function TagPill({ tag }: { tag: string }) {
  return (
    <Badge
      variant="outline"
      className={`${base} border-nc-yellow/60 text-nc-yellow/80`}
      data-testid={`badge-tag-${tag}`}
    >
      {tag}
    </Badge>
  );
}
