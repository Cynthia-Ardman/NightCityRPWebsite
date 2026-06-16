import { useGetPendingEdit } from "@workspace/api-client-react";
import DiffValue from "@/components/DiffValue";
import { valuesDiffer } from "@/lib/textDiff";

// Fetches the full pending edit (which carries the `before` snapshot the list
// summary lacks) and shows a per-field unified diff so a player can see exactly
// what their edit changed without scanning two full copies.
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
  const fields = Object.keys(diff).filter((f) => valuesDiffer(before[f], diff[f]));
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
          <DiffValue before={before[f]} after={diff[f]} compact />
        </div>
      ))}
    </div>
  );
}
