import { Router, type IRouter } from "express";
import { registerBusinessLeases, registerStores } from "./stores/stores-routes";
import { registerShifts } from "./stores/shifts";
import { registerStoresStock } from "./stores/stores-stock";
import { registerSales } from "./stores/sales";
import { registerCatalogPurchase } from "./stores/catalog-purchase";
import { registerRipperdocs } from "./stores/ripperdocs-routes";
import { registerStockOffers } from "./stores/stock-offers";
import { registerVenueAccounts } from "./stores/venue-accounts";

// This module was split out of a single ~2,500-line file into cohesive modules
// under ./stores/. This barrel preserves the original ../routes/stores import
// path and, crucially, the route REGISTRATION ORDER — Express matches routes in
// the order they are registered, and every route is gated per-route with
// requireAuth exactly as before. Each register* call below appends its routes to
// the shared router in the same sequence the original file used.
const router: IRouter = Router();

registerBusinessLeases(router);
registerStores(router);
registerShifts(router);
registerStoresStock(router);
registerSales(router);
registerCatalogPurchase(router);
registerRipperdocs(router);
registerStockOffers(router);
registerVenueAccounts(router);

// Re-export the shared helpers so any consumer importing them from the original
// module path keeps working.
export * from "./stores/venue-shared";

export default router;
