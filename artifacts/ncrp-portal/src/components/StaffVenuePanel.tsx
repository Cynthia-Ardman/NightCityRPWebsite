import { useState } from "react";
import { useLocation } from "wouter";
import {
  useUpdateStore,
  useDeleteStore,
  useUpdateRipperdoc,
  useDeleteRipperdoc,
  useListArchiveUsers,
  getListArchiveUsersQueryKey,
  useListBusinessLeases,
  getListBusinessLeasesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, UserCog, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";

// Staff-only (admin/fixer) management block shared by the store and ripperdoc
// management pages: reassign ownership to another user and delete the venue.
// Both actions are audit-logged server-side. Rendered only when the caller has
// the fixer/admin role.
export default function StaffVenuePanel({
  kind,
  venueId,
  currentOwnerName,
  currentOwnerCharacterName,
  currentHousingId,
  currentLeaseLabel,
  onChanged,
}: {
  kind: "store" | "ripperdoc";
  venueId: number;
  currentOwnerName?: string | null;
  currentOwnerCharacterName?: string | null;
  currentHousingId?: number | null;
  currentLeaseLabel?: string | null;
  onChanged: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [ownerSearch, setOwnerSearch] = useState("");
  const [ownerChar, setOwnerChar] = useState<CharacterPickerValue>(null);
  const [leaseSel, setLeaseSel] = useState<string>("");
  const [confirming, setConfirming] = useState(false);

  const params = { q: ownerSearch || undefined };
  const { data: results } = useListArchiveUsers(params, {
    query: {
      queryKey: getListArchiveUsersQueryKey(params),
      enabled: ownerSearch.trim().length > 0,
    },
  });

  const { data: leases } = useListBusinessLeases({
    query: { queryKey: getListBusinessLeasesQueryKey() },
  });

  const updateStore = useUpdateStore();
  const deleteStore = useDeleteStore();
  const updateRipperdoc = useUpdateRipperdoc();
  const deleteRipperdoc = useDeleteRipperdoc();

  const reassign = (ownerId: string, username: string) => {
    const onSuccess = () => {
      toast({ title: "Owner reassigned", description: `Now owned by ${username}.` });
      setOwnerSearch("");
      onChanged();
    };
    const onError = () =>
      toast({ title: "Reassign failed", description: "Could not change owner.", variant: "destructive" });
    if (kind === "store") updateStore.mutate({ id: venueId, data: { ownerId } }, { onSuccess, onError });
    else updateRipperdoc.mutate({ id: venueId, data: { ownerId } }, { onSuccess, onError });
  };

  // The owner CHARACTER (distinct from the owner user) is what drives Open
  // Shop and venue payouts. Legacy-imported venues often have an owner user
  // but no linked character, so staff need to set it here.
  const assignOwnerCharacter = () => {
    if (!ownerChar?.id) return;
    const onSuccess = () => {
      toast({ title: "Owner character set", description: `Linked to ${ownerChar.name}.` });
      setOwnerChar(null);
      onChanged();
    };
    const onError = () =>
      toast({ title: "Update failed", description: "Could not set the owner character.", variant: "destructive" });
    const data = { ownerCharacterId: ownerChar.id };
    if (kind === "store") updateStore.mutate({ id: venueId, data }, { onSuccess, onError });
    else updateRipperdoc.mutate({ id: venueId, data }, { onSuccess, onError });
  };

  // Associate the venue with a business lease (or clear it with null). Pinning
  // the venue location to the building is handled server-side.
  const setLease = (housingId: number | null) => {
    const onSuccess = () => {
      toast({
        title: housingId == null ? "Lease cleared" : "Lease associated",
        description: housingId == null ? "Venue is no longer linked to a lease." : "Venue location pinned to the lease.",
      });
      setLeaseSel("");
      onChanged();
    };
    const onError = () =>
      toast({ title: "Update failed", description: "Could not update the lease.", variant: "destructive" });
    const data = { housingId };
    if (kind === "store") updateStore.mutate({ id: venueId, data }, { onSuccess, onError });
    else updateRipperdoc.mutate({ id: venueId, data }, { onSuccess, onError });
  };

  const doDelete = () => {
    const onSuccess = () => {
      toast({ title: "Venue deleted" });
      navigate(kind === "store" ? "/directory/stores" : "/directory/ripperdocs");
    };
    const onError = () =>
      toast({ title: "Delete failed", description: "Could not delete venue.", variant: "destructive" });
    if (kind === "store") deleteStore.mutate({ id: venueId }, { onSuccess, onError });
    else deleteRipperdoc.mutate({ id: venueId }, { onSuccess, onError });
  };

  return (
    <Card className="rounded-none border-destructive/40 bg-card/50" data-testid="panel-staff-controls">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-destructive flex items-center gap-2">
          <UserCog className="w-4 h-4" /> STAFF CONTROLS
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {currentOwnerName !== undefined && (
            <p className="font-mono text-xs text-muted-foreground">
              Owner: <span className="text-foreground">{currentOwnerName ?? "—"}</span>
            </p>
          )}
          <Input
            placeholder="Search user to reassign owner..."
            value={ownerSearch}
            onChange={(e) => setOwnerSearch(e.target.value)}
            data-testid="input-reassign-owner"
          />
          {ownerSearch.trim() && (results ?? []).length > 0 && (
            <div className="border border-border bg-card max-h-40 overflow-y-auto">
              {(results ?? []).map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => reassign(u.id, u.username)}
                  className="block w-full text-left px-3 py-2 font-mono text-sm hover:bg-nc-cyan/10"
                  data-testid={`option-owner-${u.id}`}
                >
                  {u.username}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-2 pt-2 border-t border-border/30">
          {currentOwnerCharacterName !== undefined && (
            <p className="font-mono text-xs text-muted-foreground">
              Owner character:{" "}
              <span className="text-foreground">{currentOwnerCharacterName ?? "—"}</span>
            </p>
          )}
          <p className="font-mono text-[11px] text-muted-foreground">
            The owner character drives Open Shop and venue payouts. Set it for legacy venues with no linked character.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <CharacterPicker value={ownerChar} onChange={setOwnerChar} testId="input-owner-character" />
            </div>
            <Button
              type="button"
              onClick={assignOwnerCharacter}
              disabled={!ownerChar?.id || updateStore.isPending || updateRipperdoc.isPending}
              className="rounded-none bg-nc-cyan text-background font-display"
              data-testid="button-set-owner-character"
            >
              SET OWNER CHARACTER
            </Button>
          </div>
        </div>
        <div className="space-y-2 pt-2 border-t border-border/30">
          <p className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
            <Building2 className="w-3.5 h-3.5" /> Lease:{" "}
            <span className="text-foreground">{currentLeaseLabel ?? "—"}</span>
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            Associate this venue with an on-map business lease. The venue location is pinned to the building.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <Select value={leaseSel} onValueChange={setLeaseSel}>
                <SelectTrigger className="rounded-none font-mono" data-testid="select-lease">
                  <SelectValue placeholder="Select a business lease..." />
                </SelectTrigger>
                <SelectContent>
                  {(leases ?? []).map((l) => (
                    <SelectItem key={l.id} value={String(l.id)} data-testid={`option-lease-${l.id}`}>
                      {l.address}
                      {l.tier ? ` · ${l.tier}` : ""} · €${l.monthlyRent.toLocaleString()}/mo
                      {l.characterName ? ` · ${l.characterName}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => leaseSel && setLease(Number(leaseSel))}
              disabled={!leaseSel || updateStore.isPending || updateRipperdoc.isPending}
              className="rounded-none bg-nc-cyan text-background font-display"
              data-testid="button-associate-lease"
            >
              ASSOCIATE LEASE
            </Button>
            {currentHousingId != null && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setLease(null)}
                disabled={updateStore.isPending || updateRipperdoc.isPending}
                className="rounded-none"
                data-testid="button-clear-lease"
              >
                CLEAR
              </Button>
            )}
          </div>
        </div>
        <div className="pt-2 border-t border-border/30">
          {!confirming ? (
            <Button
              variant="ghost"
              onClick={() => setConfirming(true)}
              className="text-destructive rounded-none"
              data-testid="button-delete-venue"
            >
              <Trash2 className="w-4 h-4 mr-2" /> DELETE VENUE
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-destructive">
                Permanently delete this venue and all its stock &amp; staff?
              </span>
              <Button variant="destructive" onClick={doDelete} className="rounded-none" data-testid="button-confirm-delete">
                CONFIRM DELETE
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} className="rounded-none">
                CANCEL
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
