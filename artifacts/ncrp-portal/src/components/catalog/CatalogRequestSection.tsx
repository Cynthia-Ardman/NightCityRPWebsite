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
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";
import SingleImageUpload from "@/components/SingleImageUpload";

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

// Resolved/terminal request states hidden from the per-catalog "Your Requests"
// banner — the banner only tracks requests that still need attention.
const TERMINAL_REQUEST_STATUSES = new Set(["approved", "rejected", "closed", "cancelled"]);

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
  const [imageUrl, setImageUrl] = useState("");
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
        setImageUrl("");
        setSource("");
        setCustomSource("");
        setSelectedType(type);
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
    imageUrl: imageUrl || undefined,
    source: resolvedSource || undefined,
    ...(asDraft ? { asDraft: true } : {}),
  });

  // Only surface still-actionable requests in the per-catalog banner: drafts
  // (unsubmitted), pending review, and changes-requested. Terminal outcomes
  // (approved/rejected/closed/cancelled) drop off so the banner stays a live
  // to-do list, not a permanent history. The full history lives on My Requests.
  const myRequests = ((mine ?? []) as CustomRequest[]).filter(
    (r) => !TERMINAL_REQUEST_STATUSES.has((r.status ?? "").toLowerCase()),
  );

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

      {!presetCharacterId && myRequests.length > 0 && (
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
            <DialogTitle className="font-display tracking-widest text-nc-cyan">{effectiveDialogTitle}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Tell staff what you're after and why."
                className="rounded-none font-mono min-h-[100px]"
                data-testid={`input-description-${type}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Reference Image (optional)</Label>
              <SingleImageUpload value={imageUrl} onChange={setImageUrl} testIdPrefix={`request-${type}`} alt="reference" />
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
