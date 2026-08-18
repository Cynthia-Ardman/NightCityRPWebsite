/**
 * Extract the server-provided error message from a failed API call.
 *
 * The generated client throws `ApiError` with the parsed JSON body on
 * `err.data` (e.g. `{ error: "..." }`). Some older call sites read
 * `err.response.data`, which is a raw fetch Response and never has the body —
 * use this helper instead so the server's actual reason reaches the user.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const msg = (data as { error?: unknown }).error;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
  }
  return fallback;
}
