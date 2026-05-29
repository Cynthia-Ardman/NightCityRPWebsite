import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useDeleteCharacter,
  getListMyCharactersQueryKey,
  type Character,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Admin-only, irreversible character deletion. The destructive button stays
 * disabled until the admin types the character's exact name, mirroring the
 * "type the name to confirm" pattern used by destructive GitHub actions.
 */
export default function DeleteCharacterDialog({
  character,
  open,
  onOpenChange,
}: {
  character: Character;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (open) setConfirmText("");
  }, [open]);

  const del = useDeleteCharacter({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Character deleted",
          description: `${character.name} has been permanently removed.`,
        });
        qc.invalidateQueries({ queryKey: getListMyCharactersQueryKey() });
        onOpenChange(false);
        navigate("/characters");
      },
      onError: (err) => {
        const data = (err as { response?: { data?: { error?: string } } } | null)?.response?.data;
        toast({
          title: "Delete failed",
          description: data?.error ?? "Could not delete this character.",
          variant: "destructive",
        });
      },
    },
  });

  const canDelete = confirmText === character.name && !del.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[95vw] max-w-md rounded-none border-destructive bg-background"
        data-testid="dialog-delete-character"
      >
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-destructive text-xl flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" /> DELETE CHARACTER
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 font-mono text-sm">
          <p className="text-muted-foreground">
            This permanently deletes{" "}
            <span className="text-foreground font-bold">{character.name}</span> and everything tied
            to them — inventory, wallet, housing, status, and update history. This{" "}
            <span className="text-destructive font-bold">cannot be undone</span>.
          </p>

          <div>
            <Label className="text-xs">
              Type <span className="text-destructive">{character.name}</span> to confirm
            </Label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              placeholder={character.name}
              data-testid="input-delete-confirm"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              className="rounded-none font-display"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-delete"
            >
              CANCEL
            </Button>
            <Button
              type="button"
              disabled={!canDelete}
              onClick={() => del.mutate({ id: character.id })}
              className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display disabled:opacity-50"
              data-testid="button-confirm-delete"
            >
              {del.isPending ? "DELETING..." : "DELETE PERMANENTLY"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
