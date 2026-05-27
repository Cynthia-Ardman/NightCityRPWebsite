---
name: Long-running scripts on Replit
description: Replit reaps detached background processes; use workflows for jobs longer than the bash tool's 2-min cap.
---

`nohup ... &` and `setsid bash -c '...' &` both get killed by Replit's sandbox within a couple of minutes, even after `disown`, even with stdout redirected to a file. The process tree disappears with no exit log.

**Use a workflow instead** for any one-off batch job that runs longer than the bash tool's 2-minute cap:

```js
await configureWorkflow({
  name: "<descriptive one-off name>",
  command: "<the long-running command>",
  outputType: "console",      // no port needed
  autoStart: true,
});
// poll:
const s = await getWorkflowStatus({ name: "...", maxScrollbackLines: 30 });
// when state === "finished", clean up:
await removeWorkflow({ name: "..." });
```

**Why:** Workflows are explicitly supervised by Replit and survive across agent turns. Detached shells are not.

**How to apply:** Anytime you'd reach for `nohup` or `setsid` for a job >2 min, register a workflow, poll its status, then remove it when done. Always remove the workflow afterwards so it doesn't clutter the workspace.
