import { postToChannel, startThreadFromMessage } from "./discord";

// Shared "announce a review submission to Discord" sequence used by all three
// review pipelines (character sheets, pending character edits, custom/misc
// requests): post the summary message to the channel, start a thread from it
// (the read-only mirror shown on the portal), and let the caller persist the
// ids on its own table.
//
// Each pipeline keeps its own channel copy, embed fields, thread title, and
// error handling at the call site — only the mechanical post → thread →
// persist sequence lives here. The persist callback receives threadId=null on
// a hard thread failure; callers only store discordThreadId when a thread
// genuinely exists, so a later backfill can thread from the stored message id.
export async function announceWithThread(opts: {
  channelId: string;
  content: string;
  embeds: unknown[];
  threadTitle: string;
  persist: (ids: { msgId: string; threadId: string | null }) => Promise<void>;
}): Promise<void> {
  const msgId = await postToChannel(opts.channelId, opts.content, opts.embeds);
  if (msgId) {
    const threadId = await startThreadFromMessage(opts.channelId, msgId, opts.threadTitle);
    await opts.persist({ msgId, threadId });
  }
}
