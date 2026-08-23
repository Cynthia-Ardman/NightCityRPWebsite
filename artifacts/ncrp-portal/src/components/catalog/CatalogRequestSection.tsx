import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyCharacters,
  useSubmitCustomRequest,
  useListMyCustomRequests,
  getListMyCustomRequestsQueryKey,
  useListStores,
  useListRipperdocs,
  getListStoresQueryKey,
  getListRipperdocsQueryKey,
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
import MultiImageUpload from "@/components/MultiImageUpload";

type RequestType = "property" | "gun" | "cyberware" | "item";

const CUSTOM_SOURCE = "__custom__";

// When the dialog lets the player pick what kind of thing they're requesting
// (gun / cyberware / general item), these drive the per-type wording so the
// labels match the chosen category instead of staying stuck on the entry point.
const TYPE_CHOICE_META: Record<
  RequestType,
  { choiceLabel: string; dialogTitle: string; titleLabel: string; titlePlaceholder: string }
> = {
  item: {
    choiceLabel: "General item",
    dialogTitle: "Request Custom Item",
    titleLabel: "Item",
    titlePlaceholder: "e.g. Encrypted Agent, Med Kit, Vehicle Keys",
  },
  gun: {
    choiceLabel: "Gun / weapon",
    dialogTitle: "Request Custom Gun",
    titleLabel: "Gun",
    titlePlaceholder: "e.g. Militech M-10AF Lexington",
  },
  cyberware: {
    choiceLabel: "Cyberware",
    dialogTitle: "Request Custom Cyberware",
    titleLabel: "Cyberware",
    titlePlaceholder: "e.g. Militech Berserk MK.4",
  },
  property: {
    choiceLabel: "Property",
    dialogTitle: "Request Property",
    titleLabel: "Property",
    titlePlaceholder: "e.g. Apartment in Watson",
  },
};

export default function CatalogRequestSection({
  type,
  buttonLabel,
  dialogTitle,
  dialogDescription,
  titleLabel,
  titlePlaceholder,
  presetCharacterId,
  typeChoices,
}: {
  type: RequestType;
  buttonLabel: string;
  dialogTitle: string;
  dialogDescription: string;
  titleLabel: string;
  titlePlaceholder: string;
  // When set, the request is locked to this character: the character dropdown
  // and the "Your Requests" list are hidden (used by the per-character
  // Cyberware tab entry point).
  presetCharacterId?: number;
  // When provided with 2+ entries, the dialog shows a "kind of request" picker
  // (e.g. gun / cyberware / general item) so players who land on one entry
  // point can still file the right category. `type` is the default selection.
  typeChoices?: RequestType[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: characters } = useListMyCharacters();
  const [open, setOpen] = useState(false);
  const [characterId, setCharacterId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  // Source = which venue the player wants this from (gun→store, cyberware→
  // ripperdoc), or a free-text "Custom" value. Optional; property has no source.
  const [source, setSource] = useState<string>("");
  const [customSource, setCustomSource] = useState<string>("");

  // The category actually being requested. In single-type mode this is just
  // `type`; in choice mode the player picks it from `typeChoices`.
  const choiceMode = !!typeChoices && typeChoices.length > 1;
  const [selectedType, setSelectedType] = useState<RequestType>(type);
  const activeType = choiceMode ? selectedType : type;

  const { data: mine } = useListMyCustomRequests({ type: activeType });

  const hasSource = activeType === "gun" || activeType === "cyberware";
  const { data: stores } = useListStores({
    query: { enabled: activeType === "gun", queryKey: getListStoresQueryKey() },
  });
  const { data: ripperdocs } = useListRipperdocs({
    query: { enabled: activeType === "cyberware", queryKey: getListRipperdocsQueryKey() },
  });
  const sourceOptions =
    (activeType === "gun" ? stores : activeType === "cyberware" ? ripperdocs : []) ?? [];

  // In choice mode the wording follows the chosen category; otherwise the
  // caller-supplied props win (keeps existing single-type entry points intact).
  const meta = choiceMode ? TYPE_CHOICE_META[activeType] : null;
  const effectiveDialogTitle = meta?.dialogTitle ?? dialogTitle;
  const effectiveTitleLabel = meta?.titleLabel ?? titleLabel;
  const effectiveTitlePlaceholder = meta?.titlePlaceholder ?? titlePlaceholder;

  // Only the player's own, non-archived PCs can hold a request target.
  const ownChars = (characters ?? []).filter((c) => !c.archived);
  const presetChar = presetCharacterId
    ? (characters ?? []).find((c) => c.id === presetCharacterId)
    : undefined;
  const effectiveCharacterId = presetCharacterId ? String(presetCharacterId) : characterId;

  const submit = useSubmitCustomRequest({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey({ type: activeType }) });
        toast(
          variables?.data?.asDraft
            ? { title: "Draft saved", description: "Find it under Your Requests to finish and submit." }
            : { title: "Request submitted", description: "Staff will review it shortly." },
        );
        setOpen(false);
        setTitle("");
        setDescription("");
        setCharacterId("");
        setImageUrls([]);
        setSource("");
        setCustomSource("");
        setSelectedType(type);
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

  const resolvedSource =
    !hasSource || !source ? "" : source === CUSTOM_SOURCE ? customSource.trim() : source;
  const canSubmit = !!effectiveCharacterId && !!title.trim() && !submit.isPending;
  // A draft only needs a character + title; the rest can be filled in later.
  const canSaveDraft = !!effectiveCharacterId && !!title.trim() && !submit.isPending;

  const buildData = (asDraft: boolean) => ({
    type: activeType,
    characterId: parseInt(effectiveCharacterId, 10),
    title: title.trim(),
    description: description.trim() || undefined,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    source: resolvedSource || undefined,
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

      {!presetCharacterId ? <ActiveRequestGrid requests={myRequests} /> : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="w-[min(100vw_-_2rem,max(64rem,33vw))] max-w-none sm:max-w-none max-h-[90vh] overflow-y-auto rounded-none border-border bg-card"
          data-layout="responsive-editor"
        >
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-nc-cyan">{effectiveDialogTitle}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 py-2 md:grid-cols-2">
            {choiceMode && (
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">What are you requesting?</Label>
                <Select
                  value={selectedType}
                  onValueChange={(v) => {
                    setSelectedType(v as RequestType);
                    // Source is type-specific (store vs ripperdoc); drop any
                    // prior pick so it can't ride into a different category.
                    setSource("");
                    setCustomSource("");
                  }}
                >
                  <SelectTrigger className="rounded-none font-mono" data-testid="select-request-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(typeChoices ?? []).map((t) => (
                      <SelectItem key={t} value={t} data-testid={`request-type-option-${t}`}>
                        {TYPE_CHOICE_META[t].choiceLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {presetCharacterId ? (
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Character</Label>
                <div className="border border-border bg-card/40 px-3 py-2 font-mono text-sm text-foreground" data-testid={`preset-character-${type}`}>
                  {presetChar?.name ?? "This character"}
                </div>
              </div>
            ) : (
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
            )}
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{effectiveTitleLabel}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={effectiveTitlePlaceholder}
                className="rounded-none font-mono"
                data-testid={`input-title-${type}`}
              />
            </div>
            {hasSource && (
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                  {activeType === "gun" ? "Store (optional)" : "Ripperdoc (optional)"}
                </Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className="rounded-none font-mono" data-testid={`select-source-${type}`}>
                    <SelectValue placeholder={activeType === "gun" ? "Where do you want it from?" : "Where do you want it installed?"} />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceOptions.map((v) => (
                      <SelectItem key={v.id} value={v.name}>
                        {v.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_SOURCE}>Custom…</SelectItem>
                  </SelectContent>
                </Select>
                {source === CUSTOM_SOURCE && (
                  <Input
                    value={customSource}
                    onChange={(e) => setCustomSource(e.target.value)}
                    placeholder="Describe the source"
                    className="rounded-none font-mono mt-1.5"
                    data-testid={`input-custom-source-${type}`}
                  />
                )}
              </div>
            )}
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Tell staff what you're after and why."
                rows={8}
                className="min-h-40 resize-y rounded-none font-mono lg:min-h-56"
                data-testid={`input-description-${type}`}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Reference Images (optional)</Label>
              <MultiImageUpload value={imageUrls} onChange={setImageUrls} testIdPrefix={`request-${type}`} alt="reference" />
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
