// Keep in sync with AUTOBILL_FLAGS in api-server/src/lib/jobs.ts.
export const HOUSING_AUTOBILL_KEY = "housing_autobill_enabled";

export const CYBERWARE_AUTOBILL_KEY = "cyberware_autobill_enabled";

export const MISSION_AUTOPAY_KEY = "mission_autopay_enabled";

// Master economy kill switch (ECONOMY_ENABLED_KEY in api-server/src/lib/economy.ts).
// While OFF the entire economy is disabled — wallet moves, the income WORK/SLUT
// commands, and UnbelievaBoat sync all return "disabled" and do nothing.
export const ECONOMY_ENABLED_KEY = "economy_enabled";

// New-character submission kill switch (CHARACTER_SUBMISSIONS_DISABLED_KEY in
// api-server/src/lib/characterSubmissions.ts). When true, players can't submit
// new PCs; edits and NPC creation are unaffected. Defaults OFF (absent row).
export const CHARACTER_SUBMISSIONS_DISABLED_KEY = "character_submissions_disabled";

// Per-system metadata for the Test/Live switchboard. Keys must match the
// LiveModeState.systems shape returned by GET /admin/live-mode.
export const LIVE_MODE_SYSTEMS: Array<{ key: "missions" | "housing" | "cyberware" | "evictions" | "economy"; label: string; desc: string }> = [
  { key: "missions", label: "Missions", desc: "Discord scheduled events, banking/NPC channel posts, mission payouts." },
  { key: "housing", label: "Housing Billing", desc: "Monthly rent + personal fees (monthly_rent job)." },
  { key: "cyberware", label: "Cyberware Humanity", desc: "Weekly cyberpsychosis med charges (cyberware_humanity job)." },
  { key: "evictions", label: "Evictions", desc: "Delinquent lease sweeps + eviction notices (eviction_sweep job)." },
  { key: "economy", label: "Economy (eddies)", desc: "Real eddie movement through UnbelievaBoat (WORK/SLUT payouts, wallet sync). Needs the Economy System enabled below." },
];
