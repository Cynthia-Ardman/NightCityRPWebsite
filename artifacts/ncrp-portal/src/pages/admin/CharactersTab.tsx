import { useAdminListCharacters, useAdminAssignCharacterOwner, useAdminClearCharacterOwner, getAdminListCharactersQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";

export function CharactersTab() {
  const qc = useQueryClient();
  const { data: chars, isLoading } = useAdminListCharacters();
  const [filter, setFilter] = useState<"all" | "unclaimed">("all");
  const invalidate = () => qc.invalidateQueries({ queryKey: getAdminListCharactersQueryKey() });
  const assign = useAdminAssignCharacterOwner({ mutation: { onSuccess: invalidate } });
  const clearOwner = useAdminClearCharacterOwner({ mutation: { onSuccess: invalidate } });
  const [draftOwner, setDraftOwner] = useState<Record<number, string>>({});

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Querying characters...</div>;

  const rows = (chars ?? []).filter((c) => (filter === "unclaimed" ? !c.ownerId : true));

  return (
    <div className="space-y-6">
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="font-display">All Characters</CardTitle>
          <CardDescription className="font-mono">Global registry. Assign owners to imported/unclaimed sheets.</CardDescription>
        </div>
        <div className="flex gap-2">
          {(["all", "unclaimed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`px-3 py-1 border font-display text-xs uppercase tracking-widest ${filter === s ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10" : "border-border text-muted-foreground"}`}
              data-testid={`button-admin-char-filter-${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-display text-nc-cyan">Name</TableHead>
                <TableHead className="font-display text-nc-cyan">Type / Archetype</TableHead>
                <TableHead className="font-display text-nc-cyan">Owner</TableHead>
                <TableHead className="font-display text-nc-cyan">Status</TableHead>
                <TableHead className="font-display text-nc-cyan">Claim</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-sm">
              {rows.map((c) => (
                <TableRow key={c.id} className="hover:bg-muted/50 border-border" data-testid={`row-char-${c.id}`}>
                  <TableCell className="font-medium text-foreground">
                    <Link href={`/characters/${c.id}`} className="hover:underline">{c.name}</Link>
                    {c.legacyDiscordUsername && (
                      <div className="text-[0.625rem] text-muted-foreground">legacy: {c.legacyDiscordUsername}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className={c.kind === "pc" ? "text-nc-magenta" : "text-nc-yellow"}>{c.kind.toUpperCase()}</span>
                    {c.archetype && ` / ${c.archetype}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {c.ownerName ? <span className="text-nc-cyan">@{c.ownerName}</span> : <span className="text-nc-magenta">UNCLAIMED</span>}
                  </TableCell>
                  <TableCell>
                    {c.archived && <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none text-[0.625rem] px-1 py-0 mr-1">RETIRED</Badge>}
                    {c.approved ? (
                      <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none text-[0.625rem] px-1 py-0">APPROVED</Badge>
                    ) : (
                      <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none text-[0.625rem] px-1 py-0">PENDING</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="user id"
                        value={draftOwner[c.id] ?? ""}
                        onChange={(e) => setDraftOwner((d) => ({ ...d, [c.id]: e.target.value }))}
                        className="h-7 px-2 text-xs bg-background border border-border w-28"
                        data-testid={`input-claim-owner-${c.id}`}
                      />
                      <button
                        type="button"
                        className="h-7 px-2 text-xs border border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 disabled:opacity-50"
                        disabled={!draftOwner[c.id]?.trim() || assign.isPending}
                        onClick={() => assign.mutate({ id: c.id, data: { ownerId: draftOwner[c.id].trim() } })}
                        data-testid={`button-claim-assign-${c.id}`}
                      >
                        ASSIGN
                      </button>
                      {c.ownerId && (
                        <button
                          type="button"
                          className="h-7 px-2 text-xs border border-destructive text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          disabled={clearOwner.isPending}
                          onClick={() => { if (confirm(`Clear owner of ${c.name}?`)) clearOwner.mutate({ id: c.id }); }}
                          data-testid={`button-claim-clear-${c.id}`}
                        >
                          CLEAR
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground h-24">NO DATA</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
