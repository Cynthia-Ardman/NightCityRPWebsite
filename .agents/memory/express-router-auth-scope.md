---
name: Express sub-router auth scope
description: Mounting a sub-router at root and calling `router.use(requireAuth)` inside it gates every later sibling route, not just that sub-router's paths.
---

When a sub-router is mounted at the app root (e.g. `app.use("/", adminRouter)` or `routes/index.ts` adding it to a shared root router), an internal `router.use(requireAuth)` with NO path argument turns into a middleware that runs for any request that reaches this router — including paths owned by sibling routers registered after it. The result is sporadic 401s on routes that should be public (`/storage/uploads/request-url`, `/healthz`, etc).

**Why:** Express middleware order matters across mounted routers, and a path-less `router.use(mw)` matches every path the router can see, not only paths defined later in *this* file.

**How to apply:**
- Always path-scope auth middleware in shared sub-routers: `router.use("/admin", requireAuth)` instead of `router.use(requireAuth)`.
- Or attach the middleware per-route: `router.get("/admin/foo", requireAuth, handler)`.
- When debugging unexpected 401s on a route you didn't add auth to, grep for `router.use(requireAuth)` and `router.use(adminOnly)` with no path arg in every sub-router file.
