import { useAdminListBotConfig, useAdminSetBotConfig, useAdminDeleteBotConfig, getAdminListBotConfigQueryKey } from "@workspace/api-client-react";
import { formatDateTime } from "@/lib/format";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";

export function FlagsTab() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getAdminListBotConfigQueryKey() });
  const { data: rows, isLoading } = useAdminListBotConfig();
  const set = useAdminSetBotConfig({ mutation: { onSuccess: invalidate } });
  const del = useAdminDeleteBotConfig({ mutation: { onSuccess: invalidate } });
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const parseValue = (raw: string): unknown => {
    const t = raw.trim();
    if (t === "") return "";
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">System Flags</CardTitle>
        <CardDescription className="font-mono">
          Key/value bot_config flags. Values are JSON — bare strings are stored as strings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        <div className="grid grid-cols-12 gap-2 items-end border-b border-border/40 pb-3">
          <div className="col-span-4">
            <Label className="text-xs">NEW KEY</Label>
            <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="e.g. trauma_team.enabled" data-testid="input-flag-key" />
          </div>
          <div className="col-span-6">
            <Label className="text-xs">VALUE (JSON)</Label>
            <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder='true / 42 / "string"' data-testid="input-flag-value" />
          </div>
          <Button
            className="col-span-2 rounded-none bg-nc-cyan text-background font-display"
            disabled={!newKey.trim() || set.isPending}
            onClick={() => {
              set.mutate(
                { key: newKey.trim(), data: { value: parseValue(newValue) } },
                {
                  onSuccess: () => {
                    setNewKey("");
                    setNewValue("");
                  },
                },
              );
            }}
            data-testid="button-flag-create"
          >
            SET
          </Button>
        </div>
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">Loading flags...</div>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan">Key</TableHead>
                  <TableHead className="font-display text-nc-cyan">Value</TableHead>
                  <TableHead className="font-display text-nc-cyan w-48">Updated</TableHead>
                  <TableHead className="font-display text-nc-cyan w-40">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="text-xs">
                {rows?.map((r) => {
                  const current = drafts[r.key] ?? JSON.stringify(r.value);
                  return (
                    <TableRow key={r.key} className="hover:bg-muted/50 border-border" data-testid={`row-flag-${r.key}`}>
                      <TableCell className="text-nc-cyan">{r.key}</TableCell>
                      <TableCell>
                        <Input
                          value={current}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.key]: e.target.value }))}
                          className="h-8"
                          data-testid={`input-flag-edit-${r.key}`}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(r.updatedAt)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            className="rounded-none bg-nc-cyan text-background font-display text-xs"
                            onClick={() => set.mutate({ key: r.key, data: { value: parseValue(drafts[r.key] ?? JSON.stringify(r.value)) } })}
                            data-testid={`button-flag-save-${r.key}`}
                          >
                            SAVE
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-none border-destructive text-destructive font-display text-xs"
                            onClick={() => {
                              if (confirm(`Delete bot_config.${r.key}?`)) del.mutate({ key: r.key });
                            }}
                            data-testid={`button-flag-delete-${r.key}`}
                          >
                            DEL
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!rows?.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground h-24">NO FLAGS</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
