import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListArchiveCharacters,
  useUpdateArchiveCharacter,
  getListArchiveCharactersQueryKey,
  getListPublicCharacterTagsQueryKey,
  getListPublicCharactersQueryKey,
  type ArchiveCharacterSummary,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { X } from "lucide-react";

// Staff flow for attaching tags to a character. Tags are a single merged list;
// adds go into the manual column server-side so re-import can't wipe them. The
// API requires a non-empty commit message for every edit, so this dialog asks
// for one too.
export default function AddTagsDialog({
  open,
  onOpenChange,
  allTags,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  allTags: string[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ArchiveCharacterSummary | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [commitMessage, setCommitMessage] = useState("");

  const charSearchParams = { q: search || undefined, sort: "name" as const };
  const { data: results } = useListArchiveCharacters(charSearchParams, {
    query: {
      queryKey: getListArchiveCharactersQueryKey(charSearchParams),
      enabled: open && !selected && search.trim().length > 0,
    },
  });

  const suggestions = useMemo(() => {
    const lower = tagInput.trim().toLowerCase();
    const have = new Set([...(selected?.tags ?? []), ...pending].map((t) => t.toLowerCase()));
    return allTags
      .filter((t) => !have.has(t.toLowerCase()))
      .filter((t) => (lower ? t.toLowerCase().includes(lower) : true))
      .slice(0, 12);
  }, [allTags, tagInput, selected, pending]);

  const update = useUpdateArchiveCharacter();

  const reset = () => {
    setSearch("");
    setSelected(null);
    setPending([]);
    setTagInput("");
    setCommitMessage("");
  };

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const addPending = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, " ");
    if (!t) return;
    const existing = new Set([...(selected?.tags ?? []), ...pending].map((x) => x.toLowerCase()));
    if (existing.has(t.toLowerCase())) {
      setTagInput("");
      return;
    }
    setPending((cur) => [...cur, t]);
    setTagInput("");
  };

  const canSave =
    selected !== null && pending.length > 0 && commitMessage.trim().length > 0 && !update.isPending;

  const save = () => {
    if (!selected || pending.length === 0 || commitMessage.trim().length === 0) return;
    const desired = [...(selected.tags ?? []), ...pending];
    update.mutate(
      { id: selected.id, data: { tags: desired, commitMessage: commitMessage.trim() } },
      {
        onSuccess: () => {
          toast({ title: "Tags added", description: `Updated ${selected.name}.` });
          void qc.invalidateQueries({ queryKey: getListArchiveCharactersQueryKey() });
          void qc.invalidateQueries({ queryKey: getListPublicCharacterTagsQueryKey() });
          void qc.invalidateQueries({ queryKey: getListPublicCharactersQueryKey() });
          close(false);
        },
        onError: () => toast({ title: "Failed to add tags", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">ADD TAGS</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!selected ? (
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Find character
              </Label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name…"
                className="rounded-none"
                data-testid="input-addtags-search"
                autoFocus
              />
              {results && results.length > 0 && (
                <div className="mt-2 max-h-56 overflow-y-auto border border-border divide-y divide-border">
                  {results.slice(0, 25).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelected(c)}
                      className="w-full text-left px-3 py-2 hover:bg-nc-cyan/10 flex items-center justify-between gap-2"
                      data-testid={`option-addtags-char-${c.id}`}
                    >
                      <span className="font-mono text-sm text-foreground truncate">{c.name}</span>
                      <span className="text-[10px] font-mono uppercase text-muted-foreground">
                        {c.kind === "npc" ? "NPC" : "PC"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border border-border px-3 py-2">
                <span className="font-display text-foreground">{selected.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setPending([]);
                  }}
                  className="text-xs font-mono uppercase text-nc-magenta hover:text-nc-magenta/80"
                  data-testid="button-addtags-change-char"
                >
                  Change
                </button>
              </div>

              {(selected.tags ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(selected.tags ?? []).map((t) => (
                    <Badge key={t} variant="outline" className="rounded-none text-[10px] font-mono border-border text-muted-foreground">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}

              <div>
                <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                  New tags
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addPending(tagInput);
                      }
                    }}
                    placeholder="Type a tag and press Enter"
                    className="rounded-none"
                    data-testid="input-addtags-tag"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-none"
                    onClick={() => addPending(tagInput)}
                    data-testid="button-addtags-add"
                  >
                    Add
                  </Button>
                </div>
                {suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {suggestions.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addPending(t)}
                        className="px-2 py-1 border border-border text-muted-foreground hover:border-nc-yellow/60 font-mono text-[10px] uppercase tracking-wider"
                        data-testid={`suggest-addtags-${t}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {pending.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {pending.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 px-2 py-1 border border-nc-yellow/60 text-nc-yellow/90 font-mono text-[10px] uppercase tracking-wider"
                      >
                        {t}
                        <button
                          type="button"
                          onClick={() => setPending((cur) => cur.filter((x) => x !== t))}
                          data-testid={`remove-pending-${t}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                  Reason (required)
                </Label>
                <Input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Why are you adding these tags?"
                  className="rounded-none"
                  data-testid="input-addtags-commit"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" className="rounded-none" onClick={() => close(false)} data-testid="button-addtags-cancel">
            Cancel
          </Button>
          <Button
            className="rounded-none"
            disabled={!canSave}
            onClick={save}
            data-testid="button-addtags-save"
          >
            {update.isPending ? "Saving…" : "Add Tags"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
