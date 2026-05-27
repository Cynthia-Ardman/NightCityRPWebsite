import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import charactersRouter from "./characters";
import directoryRouter from "./directory";
import storesRouter from "./stores";
import fixerRouter from "./fixer";
import sheetsRouter from "./sheets";
import diceRouter from "./dice";
import adminRouter from "./admin";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";
import housingRouter from "./housing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(charactersRouter);
router.use(directoryRouter);
router.use(storesRouter);
router.use(fixerRouter);
router.use(sheetsRouter);
router.use(diceRouter);
router.use(adminRouter);
router.use(dashboardRouter);
router.use(storageRouter);
router.use(housingRouter);

export default router;
