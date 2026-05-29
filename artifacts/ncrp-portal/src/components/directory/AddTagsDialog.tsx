import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTagOptions,
  useUpdateArchiveCharacter,
  getListTagOptionsQueryKey,
  getListArchiveCharactersQueryKey,
  getListPublicCharacterTagsQueryKey,
  getListPublicCharactersQueryKey,
  type ArchiveCharacterSummary,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

// Per-character tag assignment. Staff multi-select from the GLOBAL tag-option
// registry (managed in CreateTagsDialog). The selected set is merged with any
// tags the character already has and sent as the full desired list; the server
// stores additions in the manual column so re-import can't wipe them. The API
// requires a non-empty commit message for every edit.
export default function AddTagsDialog({
  character,
  open,
  onOpenChange,
}: {
  character: ArchiveCharacterSummary | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [selected, setSelected] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [filter, setFilter] = useState("");

  const { data: options } = useListTagOptions({
    query: { queryKey: getListTagOptionsQueryKey(), enabled: open },
  });

  const existing = useMemo(
    () => new Set((character?.tags ?? []).map((t) => t.toLowerCase())),
    [character],
  );

  // Re-seed local state whenever a different character is opened.
  const seedKey = character?.id ?? -1;
  const [seededFor, setSeededFor] = useState(-1);
  if (open && seededFor !== seedKey) {
    setSelected([]);
    setCommitMessage("");
    setFilter("");
    setSeededFor(seedKey);
  }

  const available = useMemo(() => {
    const lower = filter.trim().toLowerCase();
    return (options ?? [])
      .filter((o) => !existing.has(o.name.toLowerCase()))
      .filter((o) => (lower ? o.name.toLowerCase().includes(lower) : true));
  }, [options, existing, filter]);

  const update = useUpdateArchiveCharacter();

  const toggle = (name: string) => {
    setSelected((cur) =>
      cur.some((x) => x.toLowerCase() === name.toLowerCase())
        ? cur.filter((x) => x.toLowerCase() !== name.toLowerCase())
        : [...cur, name],
    );
  };

  const canSave =
    character !== null && selected.length > 0 && commitMessage.trim().length > 0 && !update.isPending;

  const save = () => {
    if (!character || selected.length === 0 || commitMessage.trim().length === 0) return;
    const desired = [...(character.tags ?? []), ...selected];
    update.mutate(
      { id: character.id, data: { tags: desired, commitMessage: commitMessage.trim() } },
      {
        onSuccess: () => {
          toast({ title: "Tags added", description: `Updated ${character.name}.` });
          void qc.invalidateQueries({ queryKey: getListArchiveCharactersQueryKey() });
          void qc.invalidateQueries({ queryKey: getListPublicCharacterTagsQueryKey() });
          void qc.invalidateQueries({ queryKey: getListPublicCharactersQueryKey() });
          onOpenChange(false);
        },
        onError: () => toast({ title: "Failed to add tags", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">
            ADD TAGS{character ? ` — ${character.name.toUpperCase()}` : ""}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Select from the shared tag list. Manage that list with "Create Tags".
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {(character?.tags ?? []).length > 0 && (
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Current tags</Label>
              <div className="flex flex-wrap gap-1 mt-1">
                {(character?.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="px-2 py-1 border border-border text-muted-foreground font-mono text-[10px] uppercase tracking-wider"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Available tags</Label>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tags…"
              className="rounded-none mt-1"
              data-testid="input-addtags-filter"
            />
            {!options || options.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic mt-2">
                No tags defined yet. Use "Create Tags" to add some.
              </p>
            ) : available.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic mt-2">No matching tags.</p>
            ) : (
              <div className="flex flex-wrap gap-1 mt-2 max-h-56 overflow-y-auto" data-testid="list-addtags-options">
                {available.map((o) => {
                  const active = selected.some((x) => x.toLowerCase() === o.name.toLowerCase());
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => toggle(o.name)}
                      className={`px-2 py-1 border font-mono text-[10px] uppercase tracking-wider transition ${
                        active
                          ? "border-nc-yellow text-nc-yellow bg-nc-yellow/10"
                          : "border-border text-muted-foreground hover:border-nc-yellow/40"
                      }`}
                      data-testid={`option-addtags-${o.id}`}
                    >
                      {o.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Reason (required)</Label>
            <Input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Why are you adding these tags?"
              className="rounded-none"
              data-testid="input-addtags-commit"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" className="rounded-none" onClick={() => onOpenChange(false)} data-testid="button-addtags-cancel">
            Cancel
          </Button>
          <Button className="rounded-none" disabled={!canSave} onClick={save} data-testid="button-addtags-save">
            {update.isPending ? "Saving…" : "Add Tags"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
