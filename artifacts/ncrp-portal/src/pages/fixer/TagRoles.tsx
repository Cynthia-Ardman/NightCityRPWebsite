import { useState } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTagOptions,
  useUpdateTagOption,
  useCreateTagOption,
  getListTagOptionsQueryKey,
  type TagOption,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tag } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ErrorBoundary from "@/components/ErrorBoundary";

// Fixer console for tag → Discord role links. Each registry tag can carry a
// Discord role ID (granted to owners of characters wearing the tag) and a
// requires-approval flag (player self-adds become Misc Requests instead of
// applying instantly). New tags can be created here (name + optional role
// link); renames still happen on the Directory admin page.
const ROLE_ID_RE = /^\d{17,20}$/;

function TagRow({ option }: { option: TagOption }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateTagOption();
  const [roleId, setRoleId] = useState(option.discordRoleId ?? "");

  const trimmed = roleId.trim();
  const roleDirty = trimmed !== (option.discordRoleId ?? "");
  const roleValid = trimmed === "" || ROLE_ID_RE.test(trimmed);

  const save = (data: { discordRoleId?: string | null; requiresApproval?: boolean }) => {
    update.mutate(
      { id: option.id, data },
      {
        onSuccess: () => {
          toast({ title: "Tag updated", description: `Saved "${option.name}".` });
          void qc.invalidateQueries({ queryKey: getListTagOptionsQueryKey() });
        },
        onError: (e: unknown) => {
          toast({ title: "Failed to update tag", description: apiErrorMessage(e, "Could not save."), variant: "destructive" });
        },
      },
    );
  };

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] items-center gap-3 border border-border bg-card/40 px-4 py-3"
      data-testid={`row-tagrole-${option.id}`}
    >
      <div className="min-w-0">
        <span className="font-mono text-sm uppercase tracking-wider text-nc-cyan">{option.name}</span>
        {option.requiresApproval ? (
          <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-nc-yellow">needs approval</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          placeholder="Discord role ID"
          className={`rounded-none w-56 font-mono text-xs ${!roleValid ? "border-destructive" : ""}`}
          data-testid={`input-tagrole-roleid-${option.id}`}
        />
        <Button
          variant="outline"
          className="rounded-none"
          size="sm"
          disabled={!roleDirty || !roleValid || update.isPending}
          onClick={() => save({ discordRoleId: trimmed === "" ? null : trimmed })}
          data-testid={`button-tagrole-saverole-${option.id}`}
        >
          {trimmed === "" && option.discordRoleId ? "Unlink" : "Save"}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Approval</span>
        <Switch
          checked={option.requiresApproval}
          disabled={update.isPending}
          onCheckedChange={(v) => save({ requiresApproval: v })}
          data-testid={`switch-tagrole-approval-${option.id}`}
        />
      </div>
    </div>
  );
}

function CreateTagForm() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const create = useCreateTagOption();
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(false);

  const trimmedName = name.trim();
  const trimmedRole = roleId.trim();
  const roleValid = trimmedRole === "" || ROLE_ID_RE.test(trimmedRole);
  const canSubmit = trimmedName.length > 0 && roleValid && !create.isPending;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        data: {
          name: trimmedName,
          ...(trimmedRole ? { discordRoleId: trimmedRole } : {}),
          requiresApproval,
        },
      },
      {
        onSuccess: (created) => {
          toast({ title: "Tag created", description: `Added "${created.name}".` });
          setName("");
          setRoleId("");
          setRequiresApproval(false);
          void qc.invalidateQueries({ queryKey: getListTagOptionsQueryKey() });
        },
        onError: (e: unknown) => {
          toast({ title: "Failed to create tag", description: apiErrorMessage(e, "Could not create tag."), variant: "destructive" });
        },
      },
    );
  };

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] items-center gap-3 border border-dashed border-border bg-card/20 px-4 py-3"
      data-testid="form-tagrole-create"
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="New tag name…"
        maxLength={60}
        className="rounded-none font-mono text-xs uppercase"
        data-testid="input-tagrole-create-name"
      />
      <Input
        value={roleId}
        onChange={(e) => setRoleId(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Discord role ID (optional)"
        className={`rounded-none w-56 font-mono text-xs ${!roleValid ? "border-destructive" : ""}`}
        data-testid="input-tagrole-create-roleid"
      />
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Approval</span>
        <Switch
          checked={requiresApproval}
          onCheckedChange={setRequiresApproval}
          data-testid="switch-tagrole-create-approval"
        />
      </div>
      <Button
        className="rounded-none"
        size="sm"
        disabled={!canSubmit}
        onClick={submit}
        data-testid="button-tagrole-create"
      >
        {create.isPending ? "Creating…" : "Create tag"}
      </Button>
    </div>
  );
}

export default function TagRoles() {
  const { data: options, isLoading } = useListTagOptions();
  const [filter, setFilter] = useState("");
  const lower = filter.trim().toLowerCase();
  const shown = (options ?? []).filter((o) => (lower ? o.name.toLowerCase().includes(lower) : true));

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display" data-testid="text-tagroles-title">TAG ROLES</h1>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            <Tag className="w-4 h-4" /> TAG → DISCORD ROLE LINKS
          </CardTitle>
          <CardDescription className="font-mono text-xs leading-relaxed">
            Link a registry tag to a Discord role: owners of characters carrying the tag get the role,
            and it's removed when no character of theirs has it anymore. Turn on Approval to route
            player self-adds through the Misc Requests queue — staff edits always apply instantly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CreateTagForm />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tags…"
            className="rounded-none max-w-xs"
            data-testid="input-tagroles-filter"
          />
          <ErrorBoundary>
            {isLoading ? (
              <p className="font-mono text-xs text-muted-foreground italic">Loading…</p>
            ) : shown.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground italic" data-testid="text-tagroles-empty">
                {options?.length ? "No matching tags." : "No tags defined yet — create one above."}
              </p>
            ) : (
              <div className="space-y-2" data-testid="list-tagroles">
                {shown.map((o) => (
                  <TagRow key={o.id} option={o} />
                ))}
              </div>
            )}
          </ErrorBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
