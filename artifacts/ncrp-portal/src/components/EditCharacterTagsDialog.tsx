import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTagOptions,
  useUpdateCharacterTags,
  getListTagOptionsQueryKey,
} from "@workspace/api-client-react";
import { invalidateCharacterQueries } from "@/lib/characterQueries";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Owner/staff tag editor for a character. Unlike the staff archive
// AddTagsDialog (add-only, commit-message-required), this edits the FULL tag
// set — click a current tag to remove it, click an available registry tag to
// add it — and saves via PATCH /characters/:id/tags (instant, no review).
// Vocabulary is locked to the shared tag-option registry.
export default function EditCharacterTagsDialog({
  characterId,
  characterName,
  currentTags,
  open,
  onOpenChange,
}: {
  characterId: number;
  characterName: string;
  currentTags: string[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [desired, setDesired] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  // Re-seed the working set each time the dialog opens (currentTags may have
  // changed since the last edit).
  const [seededOpen, setSeededOpen] = useState(false);
  if (open && !seededOpen) {
    setDesired(currentTags);
    setFilter("");
    setSeededOpen(true);
  } else if (!open && seededOpen) {
    setSeededOpen(false);
  }

  const { data: options } = useListTagOptions({
    query: { queryKey: getListTagOptionsQueryKey(), enabled: open },
  });

  const desiredLower = useMemo(() => new Set(desired.map((t) => t.toLowerCase())), [desired]);

  const available = useMemo(() => {
    const lower = filter.trim().toLowerCase();
    return (options ?? [])
      .filter((o) => !desiredLower.has(o.name.toLowerCase()))
      .filter((o) => (lower ? o.name.toLowerCase().includes(lower) : true));
  }, [options, desiredLower, filter]);

  const update = useUpdateCharacterTags();

  const dirty =
    desired.length !== currentTags.length ||
    desired.some((t, i) => t.toLowerCase() !== currentTags[i]?.toLowerCase());

  const save = () => {
    update.mutate(
      { id: characterId, data: { tags: desired } },
      {
        onSuccess: () => {
          toast({ title: "Tags updated", description: `Updated ${characterName}.` });
          void invalidateCharacterQueries(qc, characterId);
          onOpenChange(false);
        },
        onError: (e: unknown) => {
          const msg =
            (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            "Could not save tags.";
          toast({ title: "Failed to update tags", description: msg, variant: "destructive" });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">
            EDIT TAGS — {characterName.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Click a tag to remove it; pick from the shared tag list to add. Changes apply instantly.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Current tags</Label>
            {desired.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic mt-1">No tags.</p>
            ) : (
              <div className="flex flex-wrap gap-1 mt-1" data-testid="list-edittags-current">
                {desired.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setDesired((cur) => cur.filter((x) => x !== t))}
                    className="px-2 py-1 border border-nc-cyan/60 text-nc-cyan font-mono text-[10px] uppercase tracking-wider inline-flex items-center gap-1 hover:border-destructive hover:text-destructive transition"
                    data-testid={`tag-edittags-current-${t}`}
                  >
                    {t}
                    <X className="w-3 h-3" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Available tags</Label>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tags…"
              className="rounded-none mt-1"
              data-testid="input-edittags-filter"
            />
            {!options || options.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic mt-2">No tags defined yet.</p>
            ) : available.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic mt-2">No matching tags.</p>
            ) : (
              <div className="flex flex-wrap gap-1 mt-2 max-h-56 overflow-y-auto" data-testid="list-edittags-options">
                {available.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    disabled={desired.length >= 30}
                    onClick={() => setDesired((cur) => (cur.length >= 30 ? cur : [...cur, o.name]))}
                    className="px-2 py-1 border border-border text-muted-foreground font-mono text-[10px] uppercase tracking-wider hover:border-nc-yellow/60 hover:text-nc-yellow transition disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid={`option-edittags-${o.id}`}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" className="rounded-none" onClick={() => onOpenChange(false)} data-testid="button-edittags-cancel">
            Cancel
          </Button>
          <Button className="rounded-none" disabled={!dirty || update.isPending} onClick={save} data-testid="button-edittags-save">
            {update.isPending ? "Saving…" : "Save Tags"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
