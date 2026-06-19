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
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: characters } = useListMyCharacters();
  const { data: mine } = useListMyCustomRequests({ type });
  const [open, setOpen] = useState(false);
  const [characterId, setCharacterId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  // Source = which venue the player wants this from (gun→store, cyberware→
  // ripperdoc), or a free-text "Custom" value. Optional; property has no source.
  const [source, setSource] = useState<string>("");
  const [customSource, setCustomSource] = useState<string>("");

  const hasSource = type === "gun" || type === "cyberware";
  const { data: stores } = useListStores({
    query: { enabled: type === "gun", queryKey: getListStoresQueryKey() },
  });
  const { data: ripperdocs } = useListRipperdocs({
    query: { enabled: type === "cyberware", queryKey: getListRipperdocsQueryKey() },
  });
  const sourceOptions = (type === "gun" ? stores : type === "cyberware" ? ripperdocs : []) ?? [];

  // Only the player's own, non-archived PCs can hold a request target.
  const ownChars = (characters ?? []).filter((c) => !c.archived);
  const presetChar = presetCharacterId
    ? (characters ?? []).find((c) => c.id === presetCharacterId)
    : undefined;
  const effectiveCharacterId = presetCharacterId ? String(presetCharacterId) : characterId;

  const submit = useSubmitCustomRequest({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey({ type }) });
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
    type,
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
            <DialogTitle className="font-display tracking-widest text-nc-cyan">{dialogTitle}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{titleLabel}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={titlePlaceholder}
                className="rounded-none font-mono"
                data-testid={`input-title-${type}`}
              />
            </div>
            {hasSource && (
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                  {type === "gun" ? "Store (optional)" : "Ripperdoc (optional)"}
                </Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className="rounded-none font-mono" data-testid={`select-source-${type}`}>
                    <SelectValue placeholder={type === "gun" ? "Where do you want it from?" : "Where do you want it installed?"} />
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
