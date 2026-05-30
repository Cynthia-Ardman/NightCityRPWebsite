import { useMemo, useState } from "react";
import {
  useListMyCustomRequests,
  useListMyHousingRequests,
  type CustomRequest,
  type HousingRequest,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";
import { ClipboardList } from "lucide-react";

// One unified shape for everything a player has submitted, so custom
// requests (property / gun / cyberware) and standard catalog leases can
// share a single chronological history table.
type HistoryRow = {
  key: string;
  category: "Property" | "Gun" | "Cyberware" | "Lease";
  title: string;
  characterName: string;
  status: string;
  createdAt: string;
  reviewedAt?: string | null;
  reviewerNote?: string | null;
};

const CUSTOM_LABEL: Record<CustomRequest["type"], HistoryRow["category"]> = {
  property: "Property",
  gun: "Gun",
  cyberware: "Cyberware",
};

const CATEGORY_FILTERS: Array<HistoryRow["category"] | "All"> = [
  "All",
  "Property",
  "Gun",
  "Cyberware",
  "Lease",
];

function categoryColor(category: HistoryRow["category"]): string {
  switch (category) {
    case "Property":
      return "text-nc-cyan";
    case "Gun":
      return "text-nc-magenta";
    case "Cyberware":
      return "text-nc-yellow";
    case "Lease":
      return "text-nc-green";
  }
}

export default function MyRequests() {
  const { data: me } = useAuthMe();
  const { data: custom, isLoading: loadingCustom } = useListMyCustomRequests();
  const { data: housing, isLoading: loadingHousing } = useListMyHousingRequests();
  const [category, setCategory] = useState<HistoryRow["category"] | "All">("All");

  const rows = useMemo<HistoryRow[]>(() => {
    const out: HistoryRow[] = [];
    for (const r of (custom ?? []) as CustomRequest[]) {
      out.push({
        key: `custom-${r.id}`,
        category: CUSTOM_LABEL[r.type] ?? "Property",
        title: r.title,
        characterName: r.characterName,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        reviewerNote: r.reviewerNote,
      });
    }
    for (const r of (housing ?? []) as HousingRequest[]) {
      out.push({
        key: `housing-${r.id}`,
        category: "Lease",
        title: r.listingName,
        characterName: r.characterName,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        reviewerNote: r.reviewerNote,
      });
    }
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return out;
  }, [custom, housing]);

  const visible = category === "All" ? rows : rows.filter((r) => r.category === category);
  const isLoading = loadingCustom || loadingHousing;

  return (
    <div className="space-y-8 max-w-4xl mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-my-requests-title"
        >
          <ClipboardList className="w-8 h-8 text-nc-magenta" /> MY REQUESTS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Every property, gun, cyberware, and lease request you've submitted — with the outcome and staff notes.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {CATEGORY_FILTERS.map((c) => (
          <Button
            key={c}
            type="button"
            size="sm"
            variant={category === c ? "default" : "outline"}
            className={`rounded-none font-display text-xs tracking-widest ${
              category === c ? "bg-nc-cyan text-background hover:bg-nc-cyan/80" : ""
            }`}
            onClick={() => setCategory(c)}
            data-testid={`filter-requests-${c.toLowerCase()}`}
          >
            {c.toUpperCase()}
          </Button>
        ))}
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan">REQUEST HISTORY</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!me ? (
            <div className="py-16 text-center text-muted-foreground font-mono text-sm">
              Log in to see your requests.
            </div>
          ) : isLoading ? (
            <div className="py-16 text-center text-nc-cyan animate-pulse font-display">LOADING...</div>
          ) : visible.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground font-mono text-sm">
              {rows.length === 0 ? "You haven't submitted any requests yet." : "No requests in this category."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[760px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Title</th>
                    <th className="text-left p-3">Character</th>
                    <th className="text-left p-3">Submitted</th>
                    <th className="text-left p-3">Decided</th>
                    <th className="text-left p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.key}
                      className="border-b border-border/30 hover:bg-card/80 align-top"
                      data-testid={`row-my-request-${r.key}`}
                    >
                      <td className={`p-3 font-bold whitespace-nowrap ${categoryColor(r.category)}`}>
                        {r.category.toUpperCase()}
                      </td>
                      <td className="p-3">
                        <div className="text-foreground">{r.title}</div>
                        {r.reviewerNote ? (
                          <div className="text-[11px] text-muted-foreground italic mt-0.5">
                            "{r.reviewerNote}"
                          </div>
                        ) : null}
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">{r.characterName}</td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="p-3">
                        <RequestStatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
