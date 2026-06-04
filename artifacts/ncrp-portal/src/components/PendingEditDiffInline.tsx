import { useGetPendingEdit } from "@workspace/api-client-react";

// Compact before/after renderer for a single field value. Mirrors the richer
// FieldDiff on the pending-edit detail page, kept small for the inline panel
// inside My Requests.
function renderValue(v: unknown) {
  if (v === null || v === undefined || v === "") {
    return (
      <div className="font-mono text-[11px] text-muted-foreground italic p-2 border border-border/60 bg-card/30">
        (empty)
      </div>
    );
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    const arr = v as string[];
    if (arr.length === 0) {
      return (
        <div className="font-mono text-[11px] text-muted-foreground italic p-2 border border-border/60 bg-card/30">
          (empty list)
        </div>
      );
    }
    // Only treat the list as an image gallery when every entry looks like a
    // URL; otherwise it's a plain text list (e.g. tags) and broken <img> tags
    // would be misleading.
    const allUrls = arr.every((s) => /^https?:\/\//i.test(s) || s.startsWith("/"));
    if (allUrls) {
      return (
        <div className="grid grid-cols-2 gap-2 p-2 border border-border/60 bg-card/30">
          {arr.map((url, i) => (
            <img key={i} src={url} className="w-full h-20 object-contain border border-border bg-background" />
          ))}
        </div>
      );
    }
    return (
      <ul className="font-mono text-[11px] p-2 border border-border/60 bg-card/30 list-disc list-inside space-y-0.5">
        {arr.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    );
  }
  if (typeof v === "object") {
    return (
      <pre className="font-mono text-[11px] whitespace-pre-wrap p-2 border border-border/60 bg-card/30 max-h-48 overflow-y-auto">
        {JSON.stringify(v, null, 2)}
      </pre>
    );
  }
  return (
    <pre className="font-mono text-[11px] whitespace-pre-wrap p-2 border border-border/60 bg-card/30 max-h-48 overflow-y-auto">
      {String(v)}
    </pre>
  );
}

// Fetches the full pending edit (which carries the `before` snapshot the list
// summary lacks) and shows a per-field before/after diff so a player can see
// exactly what their edit changed.
export default function PendingEditDiffInline({ editId }: { editId: number }) {
  const { data, isLoading } = useGetPendingEdit(editId);
  if (isLoading) {
    return <div className="font-mono text-[11px] text-muted-foreground animate-pulse">Loading changes…</div>;
  }
  if (!data) {
    return <div className="font-mono text-[11px] text-muted-foreground italic">Couldn't load the edit.</div>;
  }
  const diff = (data.proposedDiff ?? {}) as Record<string, unknown>;
  const before = (data.before ?? {}) as Record<string, unknown>;
  const fields = Object.keys(diff);
  if (fields.length === 0) {
    return <div className="font-mono text-[11px] text-muted-foreground italic">No changed fields recorded.</div>;
  }
  return (
    <div className="space-y-3" data-testid={`edit-diff-${editId}`}>
      {fields.map((f) => (
        <div key={f} className="space-y-1" data-testid={`edit-diff-field-${f}`}>
          <div className="font-display text-[11px] tracking-widest text-nc-cyan border-b border-border/50 pb-0.5">
            {f.toUpperCase()}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <div className="font-mono text-[10px] text-destructive mb-0.5">— BEFORE</div>
              {renderValue(before[f])}
            </div>
            <div>
              <div className="font-mono text-[10px] text-nc-green mb-0.5">+ AFTER</div>
              {renderValue(diff[f])}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
