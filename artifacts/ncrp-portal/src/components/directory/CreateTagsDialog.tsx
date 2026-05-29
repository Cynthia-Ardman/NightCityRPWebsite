import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTagOptions,
  useCreateTagOption,
  useDeleteTagOption,
  getListTagOptionsQueryKey,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { X } from "lucide-react";

// Staff-only management of the GLOBAL reusable tag-option registry. These
// options are what per-character "Add Tags" multi-selects from. Creating or
// deleting an option here does NOT touch tags already applied to characters.
export default function CreateTagsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");

  const { data: options } = useListTagOptions({
    query: { queryKey: getListTagOptionsQueryKey(), enabled: open },
  });

  const create = useCreateTagOption({
    mutation: {
      onSuccess: () => {
        setName("");
        void qc.invalidateQueries({ queryKey: getListTagOptionsQueryKey() });
      },
      onError: (err) => {
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        toast({
          title: status === 409 ? "Tag already exists" : "Could not create tag",
          variant: "destructive",
        });
      },
    },
  });

  const remove = useDeleteTagOption({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListTagOptionsQueryKey() });
      },
      onError: () => toast({ title: "Could not delete tag", variant: "destructive" }),
    },
  });

  const submit = () => {
    const t = name.trim().replace(/\s+/g, " ");
    if (!t) return;
    create.mutate({ data: { name: t } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">CREATE TAGS</DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Manage the shared list of tags. These become selectable when adding tags to a character.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">New tag</Label>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Type a tag name and press Enter"
                className="rounded-none"
                data-testid="input-createtags-name"
                autoFocus
              />
              <Button
                type="button"
                className="rounded-none"
                disabled={create.isPending || !name.trim()}
                onClick={submit}
                data-testid="button-createtags-add"
              >
                {create.isPending ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>

          <div>
            <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
              Existing tags {options && options.length > 0 ? `(${options.length})` : ""}
            </Label>
            {!options || options.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic mt-2">No tags yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1 mt-2" data-testid="list-createtags-options">
                {options.map((o) => (
                  <span
                    key={o.id}
                    className="inline-flex items-center gap-1 px-2 py-1 border border-nc-yellow/60 text-nc-yellow/90 font-mono text-[10px] uppercase tracking-wider"
                    data-testid={`createtags-option-${o.id}`}
                  >
                    {o.name}
                    <button
                      type="button"
                      onClick={() => remove.mutate({ id: o.id })}
                      disabled={remove.isPending}
                      data-testid={`button-createtags-delete-${o.id}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" className="rounded-none" onClick={() => onOpenChange(false)} data-testid="button-createtags-close">
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
