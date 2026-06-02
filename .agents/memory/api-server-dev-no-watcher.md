---
name: api-server dev workflow has no file watcher
description: Why newly-added api-server routes 404 / behave stale until the workflow is restarted
---

The `artifacts/api-server` dev workflow runs `build && start` (esbuild bundle, then node) with **no file watcher / no nodemon**. Editing route or lib files does NOT hot-reload the server — the running process keeps serving the previously-bundled code.

**Symptom:** a brand-new endpoint returns 404 (and the frontend shows a generic "error fetching ...") even though the route is clearly registered in source and typecheck passes. Existing routes still work, which makes it look like a routing bug rather than a stale-process problem.

**How to apply:** after any api-server source change, `restart_workflow("artifacts/api-server: API Server")` before testing. To confirm a route is live without a session, curl `http://localhost:8080/api/<path>` and expect **401** (exists, needs auth) vs **404** (server is stale / route not registered).
