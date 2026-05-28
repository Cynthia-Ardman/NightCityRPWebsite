type LifeStatus = "active" | "dead" | "missing" | "loa" | "retired" | string;

const META: Record<string, { label: string; dot: string; text: string }> = {
  active:  { label: "ACTIVE",  dot: "bg-nc-cyan animate-pulse shadow-[0_0_5px_currentColor]", text: "text-nc-cyan" },
  dead:    { label: "DEAD",    dot: "bg-destructive shadow-[0_0_5px_currentColor]",            text: "text-destructive" },
  missing: { label: "MISSING", dot: "bg-yellow-500 shadow-[0_0_5px_currentColor]",             text: "text-yellow-500" },
  loa:     { label: "LOA",     dot: "bg-blue-400 shadow-[0_0_5px_currentColor]",               text: "text-blue-400" },
  retired: { label: "RETIRED", dot: "bg-muted",                                                text: "text-muted-foreground" },
};

export default function LifeStatusPill({ status }: { status: LifeStatus }) {
  const meta = META[status] ?? META.active;
  return (
    <span className={`flex items-center gap-1 font-mono text-xs ${meta.text}`} data-testid={`life-status-${status}`}>
      <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}
