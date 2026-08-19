import { requireRole, requireAnyRole } from "../../middlewares/auth";
import { resolveOrProvisionUser } from "../../lib/userProvision";

export const adminOnly = requireRole("ADMIN");
export const adminOrFixer = requireAnyRole(["ADMIN", "FIXER"]);

// Provisioning a `users` stub for a Discord member who has never signed in lives
// in lib/userProvision so the actor-payment paths can share it. Staff can assign
// a character to ANYONE in the guild; if the target has no `users` row yet we
// mint one keyed on their Discord id, which their first login then adopts.
export const resolveOrProvisionOwner = resolveOrProvisionUser;
