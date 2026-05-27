---
name: Discord forwarded messages
description: Forwarded messages put content/attachments/embeds under message_snapshots[].message, not on the outer message.
---

When a Discord user forwards a message into a channel/thread, the API returns:
- Outer message: empty `content`, empty `attachments`, empty `embeds`, and a `message_reference` with `type: 1`.
- The actual content lives under `message_snapshots[].message` (an array — usually length 1 — each entry has its own `content`, `attachments`, `embeds`).

Code that scrapes images or text from a thread must dive into `message_snapshots` or it will silently miss anything that was forwarded (very common pattern: someone posts the OP, then forwards a VRChat stats panel from another channel as a follow-up).

**Why:** The change was added in 2024 with the message-forwarding feature and isn't widely documented; symptom is "this thread has images in the UI but my scraper sees none/few".

**How to apply:** In any extractor that walks `messages[].attachments` / `messages[].embeds`, also walk `messages[].message_snapshots?.[].message.attachments` / `.embeds`. Tag the extracted item with the outer message id so it remains addressable.
