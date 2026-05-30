import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyCharacters,
  useSubmitCustomRequest,
  useListMyCustomRequests,
  getListMyCustomRequestsQueryKey,
  type CustomRequest,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";

type VenueType = "store" | "ripperdoc";

// Player-facing request flow for a new store or ripperdoc. Unlike the catalog
// request section (gun/cyberware/property), venue requests collect a required
// name, character, purpose, location, and description, all validated before
// submit. purpose/location ride in the `details` payload server-side.
export default function VenueRequestSection({
  type,
  buttonLabel,
  dialogTitle,
  dialogDescription,
  nameLabel,
  namePlaceholder,
}: {
  type: VenueType;
  buttonLabel: string;
  dialogTitle: string;
  dialogDescription: string;
  nameLabel: string;
  namePlaceholder: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: characters } = useListMyCharacters();
  const { data: mine } = useListMyCustomRequests({ type });
  const [open, setOpen] = useState(false);
  const [characterId, setCharacterId] = useState<string>("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");

  // Only the player's own, non-archived characters can run a venue.
  const ownChars = (characters ?? []).filter((c) => !c.archived);

  const reset = () => {
    setName("");
    setPurpose("");
    setLocation("");
    setDescription("");
    setCharacterId("");
  };

  const submit = useSubmitCustomRequest({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey({ type }) });
        toast({ title: "Request submitted", description: "Staff will review it shortly." });
        setOpen(false);
        reset();
      },
      onError: (err) => {
        toast({
          title: "Could not submit",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const canSubmit =
    !!characterId &&
    !!name.trim() &&
    !!purpose.trim() &&
    !!location.trim() &&
    !!description.trim() &&
    !submit.isPending;

  const myRequests = (mine ?? []) as CustomRequest[];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          className="rounded-none font-display tracking-widest bg-nc-magenta text-background hover:bg-nc-magenta/80"
          onClick={() => setOpen(true)}
          data-testid={`button-request-${type}`}
        >
          {buttonLabel}
        </Button>
      </div>

      {myRequests.length > 0 && (
        <div className="border border-border bg-card/30 p-4 space-y-2" data-testid={`my-requests-${type}`}>
          <div className="font-display text-sm tracking-widest text-nc-cyan uppercase">Your Requests</div>
          {myRequests.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 border-b border-border/30 py-2 last:border-0"
              data-testid={`my-request-row-${r.id}`}
            >
              <div className="min-w-0">
                <div className="font-mono text-sm text-foreground truncate">{r.title}</div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {r.characterName} · {new Date(r.createdAt).toLocaleDateString()}
                  {r.reviewerNote ? ` · "${r.reviewerNote}"` : ""}
                </div>
              </div>
              <div className="shrink-0"><RequestStatusBadge status={r.status} /></div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">{dialogTitle}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Character</Label>
              <Select value={characterId} onValueChange={setCharacterId}>
                <SelectTrigger className="rounded-none font-mono" data-testid={`select-character-${type}`}>
                  <SelectValue placeholder="Choose a character" />
                </SelectTrigger>
                <SelectContent>
                  {ownChars.length === 0 ? (
                    <SelectItem value="__none__" disabled>
                      No eligible characters
                    </SelectItem>
                  ) : (
                    ownChars.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{nameLabel}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                className="rounded-none font-mono"
                data-testid={`input-name-${type}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Purpose</Label>
              <Input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="What this venue is for"
                className="rounded-none font-mono"
                data-testid={`input-purpose-${type}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Location</Label>
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="In-world location / district"
                className="rounded-none font-mono"
                data-testid={`input-location-${type}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the venue and why you want it."
                className="rounded-none font-mono min-h-[100px]"
                data-testid={`input-description-${type}`}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              className="rounded-none font-display"
              onClick={() => setOpen(false)}
            >
              CANCEL
            </Button>
            <Button
              className="rounded-none font-display tracking-widest bg-nc-cyan text-background hover:bg-nc-cyan/80"
              disabled={!canSubmit}
              onClick={() =>
                submit.mutate({
                  data: {
                    type,
                    characterId: parseInt(characterId, 10),
                    title: name.trim(),
                    description: description.trim(),
                    purpose: purpose.trim(),
                    location: location.trim(),
                  },
                })
              }
              data-testid={`button-submit-${type}`}
            >
              {submit.isPending ? "SUBMITTING..." : "SUBMIT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
