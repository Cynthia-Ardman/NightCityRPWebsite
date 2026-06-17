import { useGetPendingEdit } from "@workspace/api-client-react";
import DiffValue from "@/components/DiffValue";
import { valuesDiffer } from "@/lib/textDiff";

// Friendlier headings for fields whose raw key reads badly in all-caps.
const FIELD_LABELS: Record<string, string> = {
  portraitUrl: "PORTRAIT",
  portraitUrls: "PORTRAITS",
  statsImageUrls: "STAT SHEET IMAGES",
};

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
  let fields = Object.keys(diff).filter((f) => valuesDiffer(before[f], diff[f]));

  // The character editor always submits the legacy single `portraitUrl`
  // alongside the `portraitUrls` gallery, so a portrait swap shows up as two
  // near-identical image diffs. When the singular portrait is already part of
  // the gallery (the common case), drop the redundant `portraitUrl` row so the
  // reviewer sees the change once.
  if (fields.includes("portraitUrl") && fields.includes("portraitUrls")) {
    const after = diff.portraitUrl;
    const gallery = diff.portraitUrls;
    const redundant =
      after == null ||
      after === "" ||
      (Array.isArray(gallery) && typeof after === "string" && gallery.includes(after));
    if (redundant) fields = fields.filter((f) => f !== "portraitUrl");
  }

  if (fields.length === 0) {
    return <div className="font-mono text-[11px] text-muted-foreground italic">No changed fields recorded.</div>;
  }
  return (
    <div className="space-y-3" data-testid={`edit-diff-${editId}`}>
      {fields.map((f) => (
        <div key={f} className="space-y-1" data-testid={`edit-diff-field-${f}`}>
          <div className="font-display text-[11px] tracking-widest text-nc-cyan border-b border-border/50 pb-0.5">
            {FIELD_LABELS[f] ?? f.toUpperCase()}
          </div>
          <DiffValue before={before[f]} after={diff[f]} compact />
        </div>
      ))}
    </div>
  );
}
