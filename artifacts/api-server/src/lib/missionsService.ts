// ===========================================================================
// missionsService — thin barrel.
//
// The former ~4,000-line mega-module was split into cohesive modules under
// ./missionsService/. This file preserves the original import path and its
// entire public surface so existing importers keep working unchanged. There is
// NO behavior change: each symbol is defined exactly once in its module and
// simply re-exported here.
//
//   statuses      — public constants / types / guards + buildMissionUrl
//   internal      — shared module-internal helpers (not part of the surface)
//   views         — read/query surface (summaries, detail, history, auth)
//   applications  — apply / review / roster / NPC sign-ups
//   lifecycle     — workflow transitions + Discord scheduling conflict check
//   discordSync   — thread announcements / backfill / event sync
//   payouts       — player/actor payments, auto-pay cron, reporting
// ===========================================================================

export * from "./missionsService/statuses";
export * from "./missionsService/views";
export * from "./missionsService/applications";
export * from "./missionsService/lifecycle";
export * from "./missionsService/discordSync";
export * from "./missionsService/payouts";

// `ensureMissionThread` lives in the shared internal module (it's used by both
// creation announcements and the backfill run) but was part of the original
// public surface, so re-export it explicitly.
export { ensureMissionThread } from "./missionsService/internal";
