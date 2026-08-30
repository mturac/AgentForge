/**
 * Optional OpenHands Agent Server bridge.
 * When OPENHANDS_URL is set, forward a task to the remote agent-server.
 * Fail-soft: returns null when unset or unreachable.
 */

export type OpenHandsBridgeResult = {
  ok: boolean;
  mode: "remote" | "unavailable";
  detail: string;
};

export async function tryOpenHandsBridge(input: {
  message: string;
  workspaceHint?: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenHandsBridgeResult | null> {
  const base = (process.env.OPENHANDS_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  try {
    const res = await fetchImpl(`${base}/api/conversations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.OPENHANDS_API_KEY
          ? { authorization: `Bearer ${process.env.OPENHANDS_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        initial_user_msg: input.message,
        workspace: input.workspaceHint || null,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return {
      ok: res.ok,
      mode: "remote",
      detail: `OpenHands ${res.status}: ${text.slice(0, 1500)}`,
    };
  } catch (e) {
    return {
      ok: false,
      mode: "unavailable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
