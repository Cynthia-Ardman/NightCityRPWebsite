import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import { registerAnalytics } from "./admin/analytics";
import { registerUsers } from "./admin/users";
import { registerCharacters } from "./admin/characters";
import { registerWallet } from "./admin/wallet";
import { registerJobs } from "./admin/jobs";
import { registerAudit } from "./admin/audit";
import { registerBotConfig } from "./admin/bot-config";
import { registerEconomy } from "./admin/economy";
import { registerMaintenance } from "./admin/maintenance";

// CHECKUP_FLOOR_KEY lives with the character checkup routes; re-exported here so
// the original module path (routes/admin) keeps exposing it unchanged.
export { CHECKUP_FLOOR_KEY } from "./admin/characters";

const router: IRouter = Router();

// Most /admin routes are ADMIN-only, but the character listing + owner
// assign/clear endpoints are also exposed to FIXER (the in-fiction canon
// enforcer role). Auth is required for everything under /admin.
//
// IMPORTANT: we scope to "/admin" so this router does not intercept
// requests that fall through to sibling routers mounted after it
// (e.g. /storage/*, /housing/*). Express applies `router.use(mw)` to
// every request the sub-router sees, regardless of whether any local
// route matches — without the path scope, this would return 401 for
// every unauthenticated call on the entire API.
router.use("/admin", requireAuth);

// Route registration order below mirrors the original single-file module: each
// register* helper appends its domain's routes to the shared router in the same
// sequence, so middleware precedence and path-matching order are preserved.
registerAnalytics(router);
registerUsers(router);
registerCharacters(router);
registerWallet(router);
registerJobs(router);
registerAudit(router);
registerBotConfig(router);
registerEconomy(router);
registerMaintenance(router);

export default router;
