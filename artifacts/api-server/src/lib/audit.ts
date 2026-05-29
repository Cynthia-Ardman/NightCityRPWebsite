import type { Request } from "express";
import { db, auditLog } from "@workspace/db";

// Single category enum — keep in sync with the AdminDashboard "Audit Log"
// sub-tabs. New categories are cheap to add; pick the closest existing one
// before inventing a new bucket.
export type AuditCategory =
  | "auth"
  | "wallet"
  | "character"
  | "inventory"
  | "housing"
  | "attendance"
  | "shop"
  | "catalog"
  | "sheet"
  | "admin"
  | "mission";

export interface RecordAuditInput {
  req?: Request;
  category: AuditCategory;
  action: string;
  actorId?: string | null;
  actorName?: string | null;
  targetType?: string | null;
  targetId?: string | number | null;
  message?: string;
  before?: unknown;
  after?: unknown;
}

// Fire-and-forget audit writer. Never throws — audit failures must not
// break the request they wrap. Pulls IP from x-forwarded-for so it works
// behind the Replit proxy; falls back to req.ip.
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const u = input.req?.user;
    const actorId = input.actorId ?? u?.id ?? null;
    const actorName = input.actorName ?? u?.username ?? null;
    const fwd = input.req?.headers["x-forwarded-for"];
    const ip = (Array.isArray(fwd) ? fwd[0] : (fwd?.toString().split(",")[0] ?? input.req?.ip)) ?? null;
    const ua = input.req?.headers["user-agent"]?.toString().slice(0, 500) ?? null;
    await db.insert(auditLog).values({
      category: input.category,
      action: input.action,
      actorId,
      actorName,
      actorIp: ip,
      actorUa: ua,
      targetType: input.targetType ?? null,
      targetId: input.targetId != null ? String(input.targetId) : null,
      message: input.message ?? null,
      beforeJson: input.before === undefined ? null : (input.before as never),
      afterJson: input.after === undefined ? null : (input.after as never),
    });
  } catch (err) {
    console.error("[audit] failed to record event", input.category, input.action, err);
  }
}
