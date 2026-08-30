import { describe, it, expect } from "vitest";

import {
  applyProviderReasoningControls,
  isGrokRoute,
  isGlmRoute,
  isDeepSeekRoute,
  isClaudeRoute,
  isGeminiRoute,
} from "../src/wire-maps.js";

describe("wire-maps — route detection", () => {
  it("detects grok by model and localhost shim", () => {
    expect(isGrokRoute("grok-4", "")).toBe(true);
    expect(isGrokRoute("gpt-4o", "http://127.0.0.1:18779")).toBe(true);
    expect(isGrokRoute("gpt-4o", "https://api.openai.com")).toBe(false);
  });

  it("detects claude / gemini / deepseek / glm", () => {
    expect(isClaudeRoute("claude-sonnet-4", "")).toBe(true);
    expect(isGeminiRoute("gemini-3.6-flash", "")).toBe(true);
    expect(isDeepSeekRoute("deepseek-v4:thinking", "")).toBe(true);
    expect(isGlmRoute("glm-5.3-flash", "")).toBe(true);
    expect(
      isGlmRoute("x", "https://open.bigmodel.cn/api/coding/paas/v4"),
    ).toBe(true);
  });
});

describe("wire-maps — grok", () => {
  it("maps maxMode and effort/fast to reasoning_effort", () => {
    const body: Record<string, unknown> = { model: "grok-4" };
    expect(
      applyProviderReasoningControls(body, {
        modelId: "grok-4",
        maxMode: true,
      }),
    ).toBe("grok");
    expect(body.reasoning_effort).toBe("xhigh");

    const b2: Record<string, unknown> = { model: "grok-4" };
    applyProviderReasoningControls(b2, {
      modelId: "grok-4",
      parameters: [{ id: "effort", value: "max" }],
    });
    expect(b2.reasoning_effort).toBe("xhigh");

    const b3: Record<string, unknown> = { model: "grok-4" };
    applyProviderReasoningControls(b3, {
      modelId: "grok-4",
      parameters: [
        { id: "effort", value: "high" },
        { id: "fast", value: true },
      ],
    });
    expect(b3.reasoning_effort).toBe("low");
  });

  it("omits reasoning_effort when effort absent (xAI default)", () => {
    const body: Record<string, unknown> = { model: "grok-4" };
    applyProviderReasoningControls(body, { modelId: "grok-4" });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("wire-maps — claude / gemini / deepseek / glm", () => {
  it("claude is strict pass-through", () => {
    const body: Record<string, unknown> = {
      model: "claude-sonnet-4",
      thinking: "should-stay",
    };
    expect(
      applyProviderReasoningControls(body, {
        modelId: "claude-sonnet-4",
        parameters: [{ id: "effort", value: "high" }],
      }),
    ).toBe("claude-passthrough");
    expect(body.thinking).toBe("should-stay");
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("gemini rewrites only verified tiered family", () => {
    const body: Record<string, unknown> = { model: "gemini-3.6-flash" };
    expect(
      applyProviderReasoningControls(body, {
        modelId: "gemini-3.6-flash",
        parameters: [{ id: "effort", value: "low" }],
      }),
    ).toBe("gemini-slug");
    expect(body.model).toBe("gemini-3.6-flash-low");

    const other: Record<string, unknown> = { model: "gemini-2.0-flash" };
    expect(
      applyProviderReasoningControls(other, {
        modelId: "gemini-2.0-flash",
        parameters: [{ id: "effort", value: "high" }],
      }),
    ).toBe("gemini-passthrough");
    expect(other.model).toBe("gemini-2.0-flash");
  });

  it("deepseek enables thinking harness shape and raises token floor", () => {
    const body: Record<string, unknown> = { model: "deepseek-v4:thinking" };
    expect(
      applyProviderReasoningControls(body, {
        modelId: "deepseek-v4:thinking",
      }),
    ).toBe("deepseek-thinking");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_tokens).toBe(256000);

    const low: Record<string, unknown> = {
      model: "deepseek-v4:thinking",
      max_tokens: 4096,
    };
    applyProviderReasoningControls(low, { modelId: "deepseek-v4:thinking" });
    expect(low.max_tokens).toBe(256000);
  });

  it("glm maps effort / off-switch; silent stays untouched", () => {
    const silent: Record<string, unknown> = { model: "glm-5.3-flash" };
    expect(
      applyProviderReasoningControls(silent, { modelId: "glm-5.3-flash" }),
    ).toBe("glm-passthrough");
    expect(silent.thinking).toEqual({ type: "enabled" });
    expect(effort.thinking).toEqual({ type: "enabled" });
    expect(effort.reasoning_effort).toBe("max");

    const off: Record<string, unknown> = { model: "glm-5.3-flash" };
    expect(
      applyProviderReasoningControls(off, {
        modelId: "glm-5.3-flash",
        parameters: [{ id: "thinking", value: false }],
      }),
    ).toBe("glm-thinking-off");
    expect(off.thinking).toEqual({ type: "disabled" });
  });

  it("unknown providers return none and do not fabricate fields", () => {
    const body: Record<string, unknown> = { model: "gpt-4o" };
    expect(
      applyProviderReasoningControls(body, {
        modelId: "gpt-4o",
        parameters: [{ id: "effort", value: "max" }],
      }),
    ).toBe("none");
    expect(body.reasoning_effort).toBeUndefined();
  });
});
