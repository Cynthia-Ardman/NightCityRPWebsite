/**
 * Backfill missing character stats images from their Discord sheet threads.
 *
 * For every character that has an importedFromThreadId but an empty
 * statsImageUrls, re-fetch the thread's messages, extract all images,
 * classify each via the Anthropic proxy, and for any classified STATS,
 * download + re-host to object storage and append to statsImageUrls.
 *
 * Re-hosting uses ObjectStorageService.uploadBuffer (same bucket the live
 * deploy serves). Discord CDN URLs are signed and expire (~24h), so each
 * image is downloaded + re-hosted within this same run.
 *
 * Env:
 *   DATABASE_URL                 target DB (set to $LIVE_PROD_DATABASE_URL)
 *   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
 *   AI_INTEGRATIONS_ANTHROPIC_BASE_URL, AI_INTEGRATIONS_ANTHROPIC_API_KEY
 *   DRY_RUN=1                    classify + report, no writes / no re-host
 *   LIMIT=<n>                    only process first n characters
 *   OFFSET=<n>                   skip first n characters
 *   CONCURRENCY=<n>              image classification concurrency (default 4)
 *
 * Usage:
 *   DATABASE_URL="$LIVE_PROD_DATABASE_URL" DRY_RUN=1 LIMIT=10 \
 *     pnpm --filter @workspace/api-server exec tsx src/_backfill-stats-images.ts
 */
import { db, characters } from "@workspace/db";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { ObjectStorageService } from "./lib/objectStorage";

const TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const API = "https://discord.com/api/v10";
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const OFFSET = process.env.OFFSET ? Number(process.env.OFFSET) : 0;
const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 4;

const ANTH_BASE = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ?? "";
const ANTH_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? "";

if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN must be set.");
  process.exit(1);
}
if (!ANTH_BASE || !ANTH_KEY) {
  console.error("AI_INTEGRATIONS_ANTHROPIC_* must be set for classification.");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL ?? "";
console.log(
  `DATABASE_URL host: ${dbUrl.replace(/:[^@]+@/, ":***@").split("@")[1]?.split("/")[0] ?? "(unknown)"}`,
);
console.log(`DRY_RUN: ${DRY_RUN}  LIMIT: ${LIMIT}  OFFSET: ${OFFSET}`);

const objectStorage = new ObjectStorageService();

// ---------- discord ----------
async function discord<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 429) {
      const retry = Number(r.headers.get("retry-after") ?? "1");
      await new Promise((res) => setTimeout(res, (retry + 0.2) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Discord ${path} -> ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }
  throw new Error(`Discord ${path} rate-limited too many times`);
}

type Attachment = {
  url: string;
  proxy_url?: string;
  filename: string;
  content_type?: string;
};
type Embed = {
  image?: { url?: string; proxy_url?: string };
  thumbnail?: { url?: string; proxy_url?: string };
};

const PER_CHAR_TIMEOUT_MS = 150_000;
const MAX_IMAGES_PER_THREAD = 30;
const MAX_RAW_BYTES = 3_600_000; // base64 inflation keeps us under the 5MB API cap

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}
type Message = {
  id: string;
  attachments: Attachment[];
  embeds: Embed[];
  message_snapshots?: { message: { attachments?: Attachment[]; embeds?: Embed[] } }[];
};

async function fetchAllMessages(threadId: string): Promise<Message[]> {
  const all: Message[] = [];
  let before: string | undefined;
  while (true) {
    const path = `/channels/${threadId}/messages?limit=100${before ? `&before=${before}` : ""}`;
    let batch: Message[];
    try {
      batch = await discord<Message[]>(path);
    } catch (err) {
      // Thread may be deleted/inaccessible — treat as no messages.
      console.warn(`  thread ${threadId} fetch failed: ${(err as Error).message}`);
      return all;
    }
    all.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  return all;
}

type Img = { url: string; proxyUrl?: string; filename: string };

function extractImages(messages: Message[]): Img[] {
  const out: Img[] = [];
  const pushAttachment = (a: Attachment) => {
    if (
      (a.content_type ?? "").startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)$/i.test(a.filename)
    ) {
      out.push({ url: a.url, proxyUrl: a.proxy_url, filename: a.filename });
    }
  };
  const pushEmbed = (e: Embed) => {
    const img = e.image ?? e.thumbnail;
    const url = img?.url;
    if (url)
      out.push({
        url,
        proxyUrl: img?.proxy_url,
        filename: url.split("/").pop()?.split("?")[0] ?? "embed",
      });
  };
  for (const m of messages) {
    for (const a of m.attachments) pushAttachment(a);
    for (const e of m.embeds) pushEmbed(e);
    for (const snap of m.message_snapshots ?? []) {
      for (const a of snap.message.attachments ?? []) pushAttachment(a);
      for (const e of snap.message.embeds ?? []) pushEmbed(e);
    }
  }
  // Dedupe by URL (ignoring signed query params).
  const seen = new Set<string>();
  return out.filter((i) => {
    const key = i.url.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- classification ----------
type ImgKind = "stats" | "portrait" | "other";

async function downloadForClassify(
  url: string,
): Promise<{ buf: Buffer; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | null> {
  const dlCtl = new AbortController();
  const dlTimer = setTimeout(() => dlCtl.abort(), 15_000);
  try {
    const imgRes = await fetch(url, { signal: dlCtl.signal });
    if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
    const ct = imgRes.headers.get("content-type") ?? "image/png";
    const mediaType = (
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(ct) ? ct : "image/png"
    ) as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { buf, mediaType };
  } finally {
    clearTimeout(dlTimer);
  }
}

async function classify(url: string, proxyUrl?: string): Promise<ImgKind> {
  try {
    let dl = await downloadForClassify(url);
    // Oversized for the image API? Retry via Discord's resizing media proxy.
    if (dl && dl.buf.length > MAX_RAW_BYTES) {
      const base = proxyUrl ?? url;
      const sep = base.includes("?") ? "&" : "?";
      const resized = `${base}${sep}width=1024&height=1024`;
      const retry = await downloadForClassify(resized).catch(() => null);
      if (retry && retry.buf.length > 0 && retry.buf.length <= MAX_RAW_BYTES) dl = retry;
    }
    if (!dl || dl.buf.length === 0 || dl.buf.length > MAX_RAW_BYTES) return "other";
    const { buf, mediaType } = dl;
    const b64 = buf.toString("base64");
    // Retry on 429 (proxy rate limit) so a real STATS image isn't silently
    // dropped as "other". Throw on exhaustion so the caller skips/retries
    // the whole character rather than persisting a partial result.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await fetch(`${ANTH_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTH_KEY,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 16,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
                {
                  type: "text",
                  text: 'This image is from a character sheet for a Cyberpunk roleplay community. Classify it as exactly one of: STATS, PORTRAIT, OTHER. STATS = a VRChat or game-engine performance/stats panel showing labels like "DOWNLOAD SIZE", "TEXTURE MEMORY", "TRIANGLES", "BONES", "PHYSBONE", "MATERIAL SLOTS", "MESHES". PORTRAIT = a screenshot of a character avatar, outfit, or face. OTHER = anything else (logos, memes, maps, equipment shots). Reply with one word only.',
                },
              ],
            },
          ],
        }),
      });
      if (resp.status === 429 || resp.status >= 500) {
        lastStatus = resp.status;
        const retryAfter = Number(resp.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 20_000);
        await resp.text().catch(() => {});
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!resp.ok) {
        // Non-retryable (e.g. 400 oversized) — treat image as non-stats.
        console.warn(`  classify ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
        return "other";
      }
      const json = (await resp.json()) as { content?: { type: string; text?: string }[] };
      const block = json.content?.[0];
      const up = (block && block.type === "text" ? block.text ?? "" : "").trim().toUpperCase();
      if (up.startsWith("STATS")) return "stats";
      if (up.startsWith("PORTRAIT")) return "portrait";
      return "other";
    }
    // Exhausted retries on 429/5xx — surface so the character is retried later.
    throw new Error(`classify exhausted (last status ${lastStatus})`);
  } catch (err) {
    if ((err as Error).message?.startsWith("classify exhausted")) throw err;
    console.warn(`  classify error: ${(err as Error).message}`);
    return "other";
  }
}

async function rehost(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") ?? "image/png";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) return null;
    return await objectStorage.uploadBuffer(buf, ct);
  } catch (err) {
    console.warn(`  rehost error: ${(err as Error).message}`);
    return null;
  }
}

async function pMap<T, R>(items: T[], fn: (x: T) => Promise<R>, c: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(c, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------- per-character ----------
type CharResult =
  | { status: "none"; note: string }
  | { status: "ok"; urls: string[]; imageCount: number };

async function processCharacter(threadId: string): Promise<CharResult> {
  const messages = await fetchAllMessages(threadId);
  let images = extractImages(messages);
  if (images.length === 0) return { status: "none", note: "no images" };
  if (images.length > MAX_IMAGES_PER_THREAD) images = images.slice(0, MAX_IMAGES_PER_THREAD);
  const kinds = await pMap(images, (img) => classify(img.url, img.proxyUrl), CONCURRENCY);
  const statsImgs = images.filter((_, i) => kinds[i] === "stats");
  if (statsImgs.length === 0) return { status: "none", note: `${images.length} imgs, 0 stats` };
  if (DRY_RUN) return { status: "ok", urls: statsImgs.map((s) => s.url), imageCount: images.length };
  const rehosted = (await pMap(statsImgs, (img) => rehost(img.url), CONCURRENCY)).filter(
    (p): p is string => !!p,
  );
  if (rehosted.length === 0)
    return { status: "none", note: `${statsImgs.length} stats but rehost failed` };
  return { status: "ok", urls: rehosted, imageCount: images.length };
}

// ---------- main ----------
async function main() {
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      threadId: characters.importedFromThreadId,
    })
    .from(characters)
    .where(
      and(
        isNotNull(characters.importedFromThreadId),
        or(
          isNull(characters.statsImageUrls),
          sql`array_length(${characters.statsImageUrls}, 1) is null`,
        ),
      ),
    )
    .orderBy(characters.id);

  const targets = rows.slice(OFFSET, OFFSET + LIMIT);
  console.log(`Found ${rows.length} characters missing stats images; processing ${targets.length}.\n`);

  let updated = 0;
  let imagesAdded = 0;
  let noneFound = 0;
  const updatedNames: string[] = [];

  for (let idx = 0; idx < targets.length; idx++) {
    const c = targets[idx];
    const threadId = c.threadId!;
    process.stdout.write(`[${idx + 1}/${targets.length}] #${c.id} ${c.name} `);
    try {
      const result = await withTimeout(
        processCharacter(threadId),
        PER_CHAR_TIMEOUT_MS,
        `char #${c.id}`,
      );
      if (result.status === "none") {
        console.log(`- ${result.note}`);
        noneFound++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`- ${result.imageCount} imgs, ${result.urls.length} STATS (dry-run)`);
        imagesAdded += result.urls.length;
        updated++;
        updatedNames.push(c.name);
        continue;
      }
      await db
        .update(characters)
        .set({ statsImageUrls: result.urls })
        .where(eq(characters.id, c.id));
      console.log(`- added ${result.urls.length} stats image(s)`);
      updated++;
      imagesAdded += result.urls.length;
      updatedNames.push(c.name);
    } catch (err) {
      console.log(`- SKIPPED (${(err as Error).message})`);
      noneFound++;
    }
  }

  console.log(
    `\nDone. characters ${DRY_RUN ? "that WOULD be updated" : "updated"}: ${updated}, stats images ${DRY_RUN ? "found" : "added"}: ${imagesAdded}, no stats found: ${noneFound}.`,
  );
  if (updatedNames.length) console.log(`Names: ${updatedNames.join(", ")}`);
  await (await import("@workspace/db")).pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
