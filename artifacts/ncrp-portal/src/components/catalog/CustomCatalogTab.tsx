import { formatDate } from "@/lib/format";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { useListCustomCatalogItems } from "@workspace/api-client-react";

// Staff-only listing of one-off CUSTOM (off-catalog) items of a single type —
// custom guns, custom cyberware, or off-map/custom property. These never live in
// the standard catalog tables; they come from the approved custom-request flow,
// joined to the owning character. Rendered as the "Custom" tab on each catalog
// page and is only mounted for fixers/admins.
export default function CustomCatalogTab({
  type,
}: {
  type: "gun" | "cyberware" | "property";
}) {
  const { data, isLoading } = useListCustomCatalogItems({ type });
  const rows = data ?? [];

  if (isLoading) {
    return <div className="text-nc-cyan font-display animate-pulse">LOADING...</div>;
  }

  return (
    <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
      <table className="w-full font-mono text-sm min-w-[700px]">
        <thead className="border-b border-border bg-card">
          <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
            <th className="text-left p-3">Name</th>
            <th className="text-left p-3">Owner</th>
            <th className="text-left p-3">Description</th>
            <th className="text-right p-3">Granted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-border/30 hover:bg-nc-cyan/5"
              data-testid={`row-custom-${type}-${r.id}`}
            >
              <td className="p-3 font-bold">{r.title}</td>
              <td className="p-3">
                {r.characterName ? (
                  <Link
                    href={`/characters/${r.characterId}`}
                    className="text-nc-cyan hover:underline"
                    data-testid={`link-custom-owner-${r.id}`}
                  >
                    {r.characterName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="p-3 text-muted-foreground" title={r.description ?? ""}>
                {r.description ?? "—"}
              </td>
              <td className="p-3 text-right text-muted-foreground whitespace-nowrap">
                {r.createdAt ? formatDate(r.createdAt) : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="text-center p-8 text-muted-foreground">
                No custom {type === "property" ? "property" : `${type}s`} on record.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
