import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTagOptions,
  useCreateTagOption,
  useUpdateTagOption,
  useDeleteTagOption,
  getListTagOptionsQueryKey,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { X, Pencil, Check } from "lucide-react";

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
  // Inline rename: which option is being edited and its draft name.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");

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

  const rename = useUpdateTagOption({
    mutation: {
      onSuccess: () => {
        setEditingId(null);
        setEditingName("");
        void qc.invalidateQueries({ queryKey: getListTagOptionsQueryKey() });
      },
      onError: (err) => {
        const status = (err as { response?: { status?: number } } | null)?.response?.status;
        toast({
          title:
            status === 409
              ? "Tag already exists"
              : status === 400
                ? "Enter a different name"
                : "Could not rename tag",
          variant: "destructive",
        });
      },
    },
  });

  const submit = () => {
    const t = name.trim().replace(/\s+/g, " ");
    if (!t) return;
    create.mutate({ data: { name: t } });
  };

  const startEdit = (id: number, current: string) => {
    setEditingId(id);
    setEditingName(current);
  };

  const saveEdit = (id: number) => {
    const t = editingName.trim().replace(/\s+/g, " ");
    if (!t) return;
    rename.mutate({ id, data: { name: t } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">MANAGE TAGS</DialogTitle>
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
              <div className="flex flex-col gap-1 mt-2" data-testid="list-createtags-options">
                {options.map((o) => {
                  const isEditing = editingId === o.id;
                  return (
                    <div
                      key={o.id}
                      className="flex items-center gap-2 px-2 py-1 border border-nc-yellow/60"
                      data-testid={`createtags-option-${o.id}`}
                    >
                      {isEditing ? (
                        <>
                          <Input
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                saveEdit(o.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingId(null);
                              }
                            }}
                            className="rounded-none h-7 font-mono text-xs uppercase tracking-wider"
                            data-testid={`input-createtags-rename-${o.id}`}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="text-nc-cyan disabled:opacity-50"
                            onClick={() => saveEdit(o.id)}
                            disabled={rename.isPending || !editingName.trim()}
                            title="Save"
                            data-testid={`button-createtags-rename-save-${o.id}`}
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground"
                            onClick={() => setEditingId(null)}
                            title="Cancel"
                            data-testid={`button-createtags-rename-cancel-${o.id}`}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="flex-1 text-nc-yellow/90 font-mono text-[10px] uppercase tracking-wider">
                            {o.name}
                          </span>
                          <button
                            type="button"
                            className="text-nc-cyan/80 hover:text-nc-cyan"
                            onClick={() => startEdit(o.id, o.name)}
                            title="Rename"
                            data-testid={`button-createtags-edit-${o.id}`}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            className="text-nc-magenta/80 hover:text-nc-magenta"
                            onClick={() => remove.mutate({ id: o.id })}
                            disabled={remove.isPending}
                            title="Delete"
                            data-testid={`button-createtags-delete-${o.id}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
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
