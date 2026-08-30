/**
 * Evidence-backed harness → upstream wire maps.
 *
 * Behavioral port of OnlyTerp/opengrok `tools/provider-maps.cjs` (MIT).
 * Laws: evidence or no ship; HTTP 200 ≠ honored; fail-closed; silence is not
 * cheap. Never fabricate maps for unverified routes.
 *
 * Authoritative facts (as of open·grok captures / docs.x.ai, 2026-08):
 *  - xAI grok-4.x: reasoning_effort in {low,medium,high,xhigh}; always-on
 *    reasoning (never emit "none").
 *  - Claude oauth shim lanes: pass-through (shim owns thinking).
 *  - Gemini: only gemini-3.6-flash has verified tiered slug suffixes.
 *  - DeepSeek thinking: top-level thinking + reasoning_effort + max_tokens floor.
 *  - GLM (bigmodel.cn coding): thinking:{type} + reasoning_effort; bare thinks.
 */

export type HarnessParameter = { id: string; value: unknown };

export type WireMapContext = {
  modelId?: string;
  baseUrl?: string;
  maxMode?: boolean;
  parameters?: HarnessParameter[];
};

export type WireRouteLabel =
  | "grok"
  | "claude-passthrough"
  | "gemini-slug"
  | "gemini-passthrough"
  | "deepseek-thinking"
  | "deepseek-passthrough"
  | "glm-fast-off"
  | "glm-effort"
  | "glm-thinking-off"
  | "glm-passthrough"
  | "none";

const EFFORT_TO_XAI: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
  xhigh: "xhigh",
  minimal: "low",
};

function param(
  parameters: HarnessParameter[] | undefined,
  id: string,
): unknown {
  if (!Array.isArray(parameters)) return undefined;
  for (const p of parameters) {
    if (p && p.id === id) return p.value;
  }
  return undefined;
}

export function isGrokRoute(modelId?: string, baseUrl?: string): boolean {
  if (/^grok[-.]/i.test(String(modelId || ""))) return true;
  return /127\.0\.0\.1:18779/.test(String(baseUrl || ""));
}

function applyGrok(
  body: Record<string, unknown>,
  maxMode: boolean,
  parameters: HarnessParameter[] | undefined,
): void {
  const effort = param(parameters, "effort");
  const fast = param(parameters, "fast");
  if (maxMode === true) {
    body.reasoning_effort = "xhigh";
    return;
  }
  if (fast === true) {
    body.reasoning_effort = "low";
    return;
  }
  if (
    effort != null &&
    Object.prototype.hasOwnProperty.call(EFFORT_TO_XAI, String(effort))
  ) {
    body.reasoning_effort = EFFORT_TO_XAI[String(effort)];
  }
  // thinking true/false and absent effort → omit → xAI default (high).
}

export function isClaudeRoute(modelId?: string, baseUrl?: string): boolean {
  if (/^claude[-.]/i.test(String(modelId || ""))) return true;
  return /127\.0\.0\.1:18776/.test(String(baseUrl || ""));
}

export function isGeminiRoute(modelId?: string, baseUrl?: string): boolean {
  if (/^gemini/i.test(String(modelId || ""))) return true;
  return /127\.0\.0\.1:18778/.test(String(baseUrl || ""));
}

const GEMINI_TIERED_FAMILY_RE = /^gemini-3\.6-flash$/i;
const GEMINI_EFFORT_TO_SLUG: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
  xhigh: "high",
};

function applyGemini(
  body: Record<string, unknown>,
  parameters: HarnessParameter[] | undefined,
): boolean {
  const m = String(body.model || "");
  if (!GEMINI_TIERED_FAMILY_RE.test(m)) return false;
  const effort = param(parameters, "effort");
  if (effort == null) return false;
  if (param(parameters, "fast") === true) return false;
  const token = GEMINI_EFFORT_TO_SLUG[String(effort)];
  if (!token) return false;
  body.model = `${m}-${token}`;
  return true;
}

export function isDeepSeekRoute(modelId?: string, baseUrl?: string): boolean {
  if (/deepseek/i.test(String(modelId || ""))) return true;
  return /(nano-gpt\.com|127\.0\.0\.1:8791)/.test(String(baseUrl || ""));
}

function applyDeepSeek(
  body: Record<string, unknown>,
  modelId: string,
  parameters: HarnessParameter[] | undefined,
): boolean {
  const slugThinking = /:thinking\s*$/i.test(modelId);
  const harnessThinking = param(parameters, "thinking");
  const enable =
    slugThinking ||
    harnessThinking === true ||
    String(harnessThinking).toLowerCase() === "true";
  if (!enable) return false;
  body.thinking = { type: "enabled" };
  if (body.reasoning_effort == null) body.reasoning_effort = "high";
  const floor = 256000;
  const cur = body.max_tokens;
  if (cur == null || (typeof cur === "number" && cur < floor)) {
    body.max_tokens = floor;
  }
  return true;
}

export function isGlmRoute(modelId?: string, baseUrl?: string): boolean {
  if (/^glm[-.\d]/i.test(String(modelId || ""))) return true;
  return /bigmodel\.cn/.test(String(baseUrl || ""));
}

function applyGlm(
  body: Record<string, unknown>,
  parameters: HarnessParameter[] | undefined,
): WireRouteLabel | null {
  const fast = param(parameters, "fast");
  if (fast === true || String(fast).toLowerCase() === "true") {
    body.thinking = { type: "disabled" };
    return "glm-fast-off";
  }
  const effort = param(parameters, "effort");
  const GLM_EFFORT: Record<string, string> = {
    low: "low",
    medium: "medium",
    high: "high",
    max: "max",
    xhigh: "max",
    maximal: "max",
  };
  const token = effort != null ? GLM_EFFORT[String(effort)] : undefined;
  if (token) {
    if (!body.thinking) body.thinking = { type: "enabled" };
    if (body.reasoning_effort == null) body.reasoning_effort = token;
    return "glm-effort";
  }
  const t = param(parameters, "thinking");
  if (t === false || String(t).toLowerCase() === "false") {
    body.thinking = { type: "disabled" };
    return "glm-thinking-off";
  }
  return null;
}

/**
 * Mutates `body` only for routes with verified evidence. Returns the route
 * label applied so callers can audit it. Unverified providers → `"none"`.
 */
export function applyProviderReasoningControls(
  body: Record<string, unknown>,
  ctx: WireMapContext = {},
): WireRouteLabel {
  const modelId = String(ctx.modelId || "");
  const baseUrl = String(ctx.baseUrl || "");

  if (isGrokRoute(modelId, baseUrl)) {
    applyGrok(body, ctx.maxMode === true, ctx.parameters);
    return "grok";
  }
  if (isClaudeRoute(modelId, baseUrl)) {
    return "claude-passthrough";
  }
  if (isGeminiRoute(modelId, baseUrl)) {
    return applyGemini(body, ctx.parameters)
      ? "gemini-slug"
      : "gemini-passthrough";
  }
  if (isDeepSeekRoute(modelId, baseUrl)) {
    return applyDeepSeek(body, modelId, ctx.parameters)
      ? "deepseek-thinking"
      : "deepseek-passthrough";
  }
  if (isGlmRoute(modelId, baseUrl)) {
    return applyGlm(body, ctx.parameters) ?? "glm-passthrough";
  }
  return "none";
}
