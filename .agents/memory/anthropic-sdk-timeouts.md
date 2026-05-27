---
name: Anthropic SDK timeouts
description: Default per-call timeout is 10 min and retries are silent; batch jobs hang without explicit guards.
---

The `@anthropic-ai/sdk` defaults to a **10-minute per-call timeout** and silently retries on 429/5xx with exponential backoff. In a batch job, a single rate-limited call can stall the entire pipeline for many minutes with no log output.

For batch / classification workloads:

```js
const client = new Anthropic({ baseURL, apiKey, maxRetries: 1 });
const ctl = new AbortController();
const t = setTimeout(() => ctl.abort(), 25_000);
try {
  await client.messages.create(
    { model, max_tokens, messages },
    { signal: ctl.signal, timeout: 25_000 },
  );
} finally { clearTimeout(t); }
```

Also enforce a separate timeout on the image/attachment download via a second `AbortController` — `fetch` with no signal can hang indefinitely on a slow CDN.

**Why:** Without these guards, one slow call cascades into the whole job appearing dead, which is hard to distinguish from a real crash.

**How to apply:** Whenever calling the Anthropic SDK in a loop over user-supplied content (forum posts, attachments, etc.), set `maxRetries: 1`, pass both `signal` and `timeout`, and treat timeouts as a soft-fail (return a sentinel like `"other"`) rather than throwing.
