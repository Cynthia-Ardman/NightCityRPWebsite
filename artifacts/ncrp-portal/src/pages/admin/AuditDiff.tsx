import { fmtAuditValue, isPlainObject } from "./audit-constants";

// Human-readable change details: when before/after are flat-ish objects,
// render a per-field old → new table (changed fields highlighted); otherwise
// fall back to pretty-printed JSON.
export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  if (before == null && after == null) {
    return <div className="text-muted-foreground">No change details recorded.</div>;
  }
  if (isPlainObject(before) || isPlainObject(after)) {
    const b = isPlainObject(before) ? before : {};
    const a = isPlainObject(after) ? after : {};
    const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
    return (
      <div className="border border-border/60">
        <div className="grid grid-cols-[minmax(90px,1fr)_2fr_2fr] gap-x-3 px-2 py-1 bg-muted/40 text-muted-foreground uppercase text-[0.625rem] tracking-widest">
          <span>Field</span><span>Before</span><span>After</span>
        </div>
        {keys.map((k) => {
          const changed = JSON.stringify(b[k]) !== JSON.stringify(a[k]);
          return (
            <div key={k} className={`grid grid-cols-[minmax(90px,1fr)_2fr_2fr] gap-x-3 px-2 py-1 border-t border-border/40 ${changed ? "" : "opacity-60"}`}>
              <span className="text-nc-cyan break-all">{k}</span>
              <span className={`break-all whitespace-pre-wrap ${changed ? "text-destructive" : "text-muted-foreground"}`}>{k in b ? fmtAuditValue(b[k]) : "—"}</span>
              <span className={`break-all whitespace-pre-wrap ${changed ? "text-nc-yellow" : "text-muted-foreground"}`}>{k in a ? fmtAuditValue(a[k]) : "—"}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="grid md:grid-cols-2 gap-2">
      {before != null && (
        <div>
          <div className="text-muted-foreground uppercase text-[0.625rem] tracking-widest mb-1">Before</div>
          <pre className="whitespace-pre-wrap break-all bg-muted/30 p-2 border border-border/50">{JSON.stringify(before, null, 2)}</pre>
        </div>
      )}
      {after != null && (
        <div>
          <div className="text-muted-foreground uppercase text-[0.625rem] tracking-widest mb-1">After</div>
          <pre className="whitespace-pre-wrap break-all bg-muted/30 p-2 border border-border/50">{JSON.stringify(after, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
