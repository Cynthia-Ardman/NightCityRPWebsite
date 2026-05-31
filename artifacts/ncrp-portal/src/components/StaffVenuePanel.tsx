import { useState } from "react";
import { useLocation } from "wouter";
import {
  useUpdateStore,
  useDeleteStore,
  useUpdateRipperdoc,
  useDeleteRipperdoc,
  useListArchiveUsers,
  getListArchiveUsersQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, UserCog } from "lucide-react";
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
  onChanged,
}: {
  kind: "store" | "ripperdoc";
  venueId: number;
  currentOwnerName?: string | null;
  currentOwnerCharacterName?: string | null;
  onChanged: () => void;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [ownerSearch, setOwnerSearch] = useState("");
  const [ownerChar, setOwnerChar] = useState<CharacterPickerValue>(null);
  const [confirming, setConfirming] = useState(false);

  const params = { q: ownerSearch || undefined };
  const { data: results } = useListArchiveUsers(params, {
    query: {
      queryKey: getListArchiveUsersQueryKey(params),
      enabled: ownerSearch.trim().length > 0,
    },
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
