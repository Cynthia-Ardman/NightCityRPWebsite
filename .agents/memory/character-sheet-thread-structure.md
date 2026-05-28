---
name: character-sheet thread structure
description: Forum threads in #character-sheets span multiple messages by the OP and use markdown headings, not inline "Label:" lines. Parsers must handle both.
---

Forum threads in the NCRP `#character-sheets` channel are **not** a single OP message with `Label:` lines. The real structure:

- The OP (first message in the thread) is often **just an image attachment** with no text.
- The actual sheet content lives in **2-N follow-up messages by the same author**, because each Discord message is capped at 2,000 chars.
- Sections are delimited by **markdown headings** (`# Backstory:`, `## **Real Name**:`, `### STATE A — "HUMAN"`), not the inline `Label: value` format the old parser expected.

**Why:** Corpse's import returned 0 sections / 0-char backstory from the OP, but 26 sections / 4,216-char backstory after concatenating all medusa_cascade's messages and recognizing markdown headings.

**How to apply:** Any scraper / re-importer of this forum must:
1. Fetch every message in the thread and concatenate `content` from messages whose `author.id === ops[0].author.id`, joined with `\n\n`.
2. Treat any line matching `^\s*#{1,6}\s+\S` as a section divider; strip leading `#`s, `**`, and trailing `:` to get the label.
3. Keep the inline `LABEL_RE` path as a fallback for threads that do use the labelled-line format.
4. Expect occasional dead image attachments — Discord CDN URLs are signed and expire (~24h); rehosting old archived threads will lose some images. That's a Discord limitation, not a parser bug.
