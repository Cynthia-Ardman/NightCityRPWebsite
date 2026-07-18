import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import charactersRouter from "./characters";
import directoryRouter from "./directory";
import storesRouter from "./stores";
import fixerRouter from "./fixer";
import missionsRouter from "./missions";
import sheetsRouter from "./sheets";
import pendingEditsRouter from "./pending-edits";
import diceRouter from "./dice";
import adminRouter from "./admin";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";
import housingRouter from "./housing";
import lifestyleRouter from "./lifestyle";
import attendanceRouter from "./attendance";
import requestsRouter from "./requests";
import offersRouter from "./offers";
import loreRouter from "./lore";
import guidebookRouter from "./guidebook";
import reviewRouter from "./review";
import breachRouter from "./breach";
import eventsRouter from "./events";
import economyCommandsRouter from "./economy-commands";
import vrchatRouter from "./vrchat";
import ncpdRouter from "./ncpd";
import searchRouter from "./search";

import { requireVerified, requireSiteAccess } from "../middlewares/auth";

const router: IRouter = Router();

// --- Always-open routers (must work for age-unverified users) --------------
// These are mounted BEFORE the age-verification gate so a member who lacks the
// guild "Verified 18+" role can still: check their session/identity (auth),
// read the VRChat↔Discord linking guidebook page (guidebook), and load the
// images that page references (storage). Everything else is gated below.
router.use(healthRouter);
router.use(authRouter);
router.use(guidebookRouter);
router.use(storageRouter);

// --- Age-verification gate -------------------------------------------------
// Signed-in members without the Verified 18+ role get a 403 from here on.
router.use(requireVerified);

// --- Staff-only lockdown gate ----------------------------------------------
// When an admin has restricted login, signed-in non-staff members get a 403
// (site_locked) from here on, so an already-logged-in player is locked out of
// every data route too. Staff (ADMIN / FIXER / ARCHIVIST) pass through.
router.use(requireSiteAccess);

// --- Gated routers (full portal) -------------------------------------------
router.use(charactersRouter);
router.use(directoryRouter);
router.use(storesRouter);
router.use(fixerRouter);
router.use(missionsRouter);
router.use(sheetsRouter);
router.use(pendingEditsRouter);
router.use(diceRouter);
router.use(adminRouter);
router.use(dashboardRouter);
router.use(housingRouter);
router.use(lifestyleRouter);
router.use(attendanceRouter);
router.use(requestsRouter);
router.use(offersRouter);
router.use(loreRouter);
router.use(reviewRouter);
router.use(breachRouter);
router.use(eventsRouter);
router.use(economyCommandsRouter);
router.use(vrchatRouter);
router.use(ncpdRouter);
router.use(searchRouter);

export default router;
