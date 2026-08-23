import { formatEddies } from "@/lib/format";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyCharacters,
  useSubmitCustomRequest,
  useListMyCustomRequests,
  useListAvailableBusinessBuildings,
  getListMyCustomRequestsQueryKey,
  getListAvailableBusinessBuildingsQueryKey,
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
import { apiErrorMessage } from "@/lib/apiError";
import { ActiveRequestGrid } from "@/components/catalog/ActiveRequestGrid";

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
  const [locationKind, setLocationKind] = useState<"off_map" | "on_map">("off_map");
  const [location, setLocation] = useState("");
  const [listingId, setListingId] = useState<string>("");
  const [description, setDescription] = useState("");
  // Store-only business-type picker: a Gun Store is tagged so it surfaces under
  // the Guns badge in the directory. Ripperdocs are always cyberware clinics.
  const [storeKind, setStoreKind] = useState<"guns" | "mixed">("mixed");
  // Off-map venues may attach an off-map property/lease. The fixer sets the
  // rent / district / tier at CLOSE & APPLY (same flow as Off-Map Housing).
  const [attachProperty, setAttachProperty] = useState(false);

  // Available on-map buildings only load while the dialog is open (and only
  // matter for the On Map path).
  const { data: buildings } = useListAvailableBusinessBuildings({
    query: { enabled: open, queryKey: getListAvailableBusinessBuildingsQueryKey() },
  });
  const availableBuildings = buildings ?? [];

  // Only the player's own, non-archived characters can run a venue.
  const ownChars = (characters ?? []).filter((c) => !c.archived);

  const reset = () => {
    setName("");
    setPurpose("");
    setLocationKind("off_map");
    setLocation("");
    setListingId("");
    setDescription("");
    setCharacterId("");
    setStoreKind("mixed");
    setAttachProperty(false);
  };

  const submit = useSubmitCustomRequest({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey({ type }) });
        queryClient.invalidateQueries({ queryKey: getListAvailableBusinessBuildingsQueryKey() });
        toast(
          variables?.data?.asDraft
            ? { title: "Draft saved", description: "Find it under Your Requests to finish and submit." }
            : { title: "Request submitted", description: "Staff will review it shortly." },
        );
        setOpen(false);
        reset();
      },
      onError: (err) => {
        toast({
          title: "Could not submit",
          description: apiErrorMessage(err, "Please try again."),
          variant: "destructive",
        });
      },
    },
  });

  const locationOk = locationKind === "on_map" ? !!listingId : !!location.trim();
  const canSubmit =
    !!characterId &&
    !!name.trim() &&
    !!purpose.trim() &&
    locationOk &&
    !!description.trim() &&
    !submit.isPending;
  // A draft only needs a character + name; everything else can be filled in later.
  const canSaveDraft = !!characterId && !!name.trim() && !submit.isPending;

  const buildData = (asDraft: boolean) => ({
    type,
    characterId: parseInt(characterId, 10),
    title: name.trim(),
    description: description.trim(),
    purpose: purpose.trim(),
    locationKind,
    ...(locationKind === "on_map"
      ? listingId
        ? { listingId: parseInt(listingId, 10) }
        : {}
      : { location: location.trim() }),
    // Stores carry their business type so the directory can flag Gun Stores.
    ...(type === "store" ? { storeKind } : {}),
    // Only off-map venues may attach an off-map property/lease at close.
    ...(locationKind === "off_map" && attachProperty ? { attachProperty: true } : {}),
    ...(asDraft ? { asDraft: true } : {}),
  });

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

      <ActiveRequestGrid requests={myRequests} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-[calc(100vw-2rem)] max-w-5xl sm:max-w-5xl max-h-[90vh] overflow-y-auto rounded-none border-border bg-card"
          data-layout="responsive-editor"
        >
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">{dialogTitle}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 py-2 md:grid-cols-2">
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
            {type === "store" && (
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Business Type</Label>
                <Select value={storeKind} onValueChange={(v) => setStoreKind(v as "guns" | "mixed")}>
                  <SelectTrigger className="rounded-none font-mono" data-testid={`select-storekind-${type}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mixed">General Store</SelectItem>
                    <SelectItem value="guns">Gun Store</SelectItem>
                  </SelectContent>
                </Select>
                <p className="font-mono text-[10px] text-muted-foreground">
                  Gun Stores are flagged in the directory so buyers can find weapons dealers.
                </p>
              </div>
            )}
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
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={locationKind === "off_map" ? "default" : "outline"}
                  className="rounded-none font-display text-xs tracking-widest flex-1"
                  onClick={() => setLocationKind("off_map")}
                  data-testid={`button-locationkind-off_map-${type}`}
                >
                  OFF MAP
                </Button>
                <Button
                  type="button"
                  variant={locationKind === "on_map" ? "default" : "outline"}
                  className="rounded-none font-display text-xs tracking-widest flex-1"
                  onClick={() => setLocationKind("on_map")}
                  data-testid={`button-locationkind-on_map-${type}`}
                >
                  ON MAP
                </Button>
              </div>
              {locationKind === "off_map" ? (
                <>
                  <Input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="In-world location / district"
                    className="rounded-none font-mono"
                    data-testid={`input-location-${type}`}
                  />
                  <label
                    className="flex items-start gap-2 pt-1 cursor-pointer"
                    data-testid={`toggle-attach-property-${type}`}
                  >
                    <input
                      type="checkbox"
                      checked={attachProperty}
                      onChange={(e) => setAttachProperty(e.target.checked)}
                      className="mt-0.5 accent-nc-magenta"
                    />
                    <span className="font-mono text-[10px] text-muted-foreground leading-snug">
                      Attach an off-map property (lease). A fixer sets the rent, district, and tier at
                      approval. Leave unchecked for a Tier-0 venue with no property.
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <Select value={listingId} onValueChange={setListingId}>
                    <SelectTrigger className="rounded-none font-mono" data-testid={`select-building-${type}`}>
                      <SelectValue placeholder="Choose a building" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableBuildings.length === 0 ? (
                        <SelectItem value="__none__" disabled>
                          No buildings available
                        </SelectItem>
                      ) : (
                        availableBuildings.map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            {b.name}
                            {b.district ? ` — ${b.district}` : ""}
                            {b.tier ? ` · ${b.tier}` : ""} · {formatEddies(b.monthlyRent)}/mo
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    On approval a business lease for this building is added to your character.
                  </p>
                </>
              )}
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the venue and why you want it."
                rows={8}
                className="min-h-40 resize-y rounded-none font-mono lg:min-h-56"
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
              variant="outline"
              className="rounded-none font-display tracking-widest"
              disabled={!canSaveDraft}
              onClick={() => submit.mutate({ data: buildData(true) })}
              data-testid={`button-save-draft-${type}`}
            >
              {submit.isPending ? "SAVING..." : "SAVE DRAFT"}
            </Button>
            <Button
              className="rounded-none font-display tracking-widest bg-nc-cyan text-background hover:bg-nc-cyan/80"
              disabled={!canSubmit}
              onClick={() => submit.mutate({ data: buildData(false) })}
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
