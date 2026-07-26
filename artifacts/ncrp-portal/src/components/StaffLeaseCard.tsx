import { useState } from "react";
import { formatEddies } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRentListings,
  useLeaseHousing,
  getGetCharacterHousingQueryKey,
  getGetCharacterQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Home } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Staff-only direct property leasing surfaced on the character-detail Property
// tab. Lets fixers/admins lease any catalog listing onto this character without
// opening the edit dialog. The lease applies immediately; already-occupied
// listings are rejected by the API.
export default function StaffLeaseCard({
  characterId,
  characterName,
}: {
  characterId: number;
  characterName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: listings } = useListRentListings();
  const lease = useLeaseHousing();
  const [listingId, setListingId] = useState("");

  async function assignProperty() {
    const l = (listings ?? []).find((x) => String(x.id) === listingId);
    if (!l) {
      toast({ title: "Pick a property", variant: "destructive" });
      return;
    }
    try {
      await lease.mutateAsync({ data: { catalogRentId: l.id, characterId } });
      await qc.invalidateQueries({ queryKey: getGetCharacterHousingQueryKey(characterId) });
      await qc.invalidateQueries({ queryKey: getGetCharacterQueryKey(characterId) });
      toast({ title: "Property leased", description: `${l.name} leased to ${characterName}.` });
      setListingId("");
    } catch (err) {
      const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
      toast({ title: "Lease failed", description: data?.error ?? "Could not lease property.", variant: "destructive" });
    }
  }

  return (
    <Card className="rounded-none border-nc-magenta/40 bg-card/50" data-testid="card-staff-lease">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-magenta flex items-center gap-2">
          <Home className="w-4 h-4" /> STAFF: LEASE PROPERTY
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label className="text-xs tracking-widest text-nc-cyan">SELECT A LISTING</Label>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
          <select
            value={listingId}
            onChange={(e) => setListingId(e.target.value)}
            className="flex h-10 w-full rounded-none border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-nc-cyan"
            data-testid="select-staff-lease-property"
          >
            <option value="">Select a property…</option>
            {(listings ?? []).map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}{l.district ? ` — ${l.district}` : ""} ({formatEddies(l.monthlyRent)}/mo)
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            className="rounded-none font-display text-xs bg-nc-cyan text-background"
            disabled={lease.isPending || !listingId}
            onClick={assignProperty}
            data-testid="button-staff-lease"
          >
            <Home className="w-3 h-3 mr-1" /> LEASE
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Leases the listing to this character immediately. Already-occupied listings are rejected.
        </p>
      </CardContent>
    </Card>
  );
}
