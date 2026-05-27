import { logger } from "./logger";
import { DISCORD_GUILD_ID } from "./discord";

const TOKEN = process.env.UNBELIEVABOAT_TOKEN ?? process.env.UNBELIEVABOAT_API_TOKEN ?? "";
const API = "https://unbelievaboat.com/api/v1";

export interface UbBalance {
  cash: number;
  bank: number;
  total: number;
  source: "unbelievaboat" | "local";
}

export async function getBalance(discordUserId: string): Promise<UbBalance | null> {
  if (!TOKEN || !DISCORD_GUILD_ID) return null;
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/users/${discordUserId}`, {
      headers: { Authorization: TOKEN },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "UB balance fetch failed");
      return null;
    }
    const data = (await res.json()) as { cash: number; bank: number; total: number };
    return { cash: data.cash, bank: data.bank, total: data.total, source: "unbelievaboat" };
  } catch (err) {
    logger.error({ err }, "UB getBalance error");
    return null;
  }
}

export async function patchBalance(
  discordUserId: string,
  delta: { cash?: number; bank?: number; reason?: string },
): Promise<UbBalance | null> {
  if (!TOKEN || !DISCORD_GUILD_ID) return null;
  try {
    const res = await fetch(`${API}/guilds/${DISCORD_GUILD_ID}/users/${discordUserId}`, {
      method: "PATCH",
      headers: { Authorization: TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(delta),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, "UB patch failed");
      return null;
    }
    const data = (await res.json()) as { cash: number; bank: number; total: number };
    return { cash: data.cash, bank: data.bank, total: data.total, source: "unbelievaboat" };
  } catch (err) {
    logger.error({ err }, "UB patchBalance error");
    return null;
  }
}
