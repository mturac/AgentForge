/**
 * Multi-provider chat — z-ai, Claude, OpenAI/Codex, OpenRouter, OpenCode, mock.
 * Keys live in forge-state (0600). Never log apiKey.
 */

import type { ForgeStore } from "./store.js";
import { pushAudit } from "./store.js";
import type { ProviderKind, ProviderRecord } from "./types.js";
import { applyProviderReasoningControls } from "../wire-maps.js";

export type PublicProvider = Omit<ProviderRecord, "apiKey"> & {
  hasKey: boolean;
};

export type ChatCompletionInput = {
  providerId: string;
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
};

export type ChatCompletionResult = {
  text: string;
  model: string;
  providerId: string;
  kind: ProviderKind;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const DEFAULTS: Record<
  Exclude<ProviderKind, "mock">,
  { name: string; baseUrl: string; defaultModel: string }
> = {
  zai: {
    name: "Z.AI / BigModel",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    defaultModel: "glm-5.3-flash",
  },
  claude: {
    name: "Claude (Anthropic)",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-20250514",
  },
  openai: {
    name: "OpenAI / Codex",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
  },
  opencode: {
    name: "OpenCode",
    baseUrl: "http://127.0.0.1:4096/v1",
    defaultModel: "default",
  },
};

function publicize(p: ProviderRecord): PublicProvider {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: !!apiKey };
}

export function createProviderApi(
  store: ForgeStore,
  opts: { fetchImpl?: typeof fetch } = {},
) {
  const fetchImpl = opts.fetchImpl ?? fetch;

  function list(): PublicProvider[] {
    return Object.values(store.load().providers)
      .map(publicize)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function get(id: string): PublicProvider | null {
    const p = store.load().providers[id];
    return p ? publicize(p) : null;
  }

  function getSecret(id: string): ProviderRecord | null {
    return store.load().providers[id] || null;
  }

  function upsert(input: {
    id?: string;
    kind: ProviderKind;
    name?: string;
    baseUrl?: string;
    defaultModel?: string;
    apiKey?: string;
    enabled?: boolean;
    actorId: string;
  }): PublicProvider {
    const kind = input.kind;
    if (
      kind !== "zai" &&
      kind !== "claude" &&
      kind !== "openai" &&
      kind !== "openrouter" &&
      kind !== "opencode" &&
      kind !== "mock"
    ) {
      throw new Error("bad_provider_kind");
    }
    let out: PublicProvider | null = null;
    store.update((state) => {
      const id = input.id || kind;
      const cur = state.providers[id];
      const def =
        kind === "mock"
          ? { name: "Mock (offline)", baseUrl: "", defaultModel: "mock" }
          : DEFAULTS[kind];
      const now = Date.now();
      const row: ProviderRecord = {
        id,
        kind,
        name: String(input.name || cur?.name || def.name),
        baseUrl: String(input.baseUrl || cur?.baseUrl || def.baseUrl),
        defaultModel: String(
          input.defaultModel || cur?.defaultModel || def.defaultModel,
        ),
        apiKey:
          input.apiKey !== undefined
            ? String(input.apiKey)
            : cur?.apiKey ||
              (kind === "mock" ? "mock" : process.env[`FORGE_${kind.toUpperCase()}_KEY`] || ""),
        enabled: input.enabled !== false,
        createdAt: cur?.createdAt || now,
        updatedAt: now,
      };
      state.providers[id] = row;
      out = publicize(row);
      pushAudit(state, "provider.upsert", input.actorId, {
        providerId: id,
        kind,
      });
    });
    return out!;
  }

  function seedDefaults(actorId: string): PublicProvider[] {
    const kinds: ProviderKind[] = [
      "mock",
      "zai",
      "claude",
      "openai",
      "openrouter",
      "opencode",
    ];
    const out: PublicProvider[] = [];
    for (const kind of kinds) {
      if (!store.load().providers[kind]) {
        out.push(upsert({ kind, actorId }));
      } else {
        out.push(get(kind)!);
      }
    }
    return out;
  }

  async function complete(
    input: ChatCompletionInput,
  ): Promise<ChatCompletionResult> {
    const p = getSecret(input.providerId);
    if (!p) throw new Error(`unknown_provider:${input.providerId}`);
    if (!p.enabled) throw new Error(`provider_disabled:${p.id}`);
    const model = String(input.model || p.defaultModel || "").trim();
    if (!model) throw new Error("missing_model");

    if (p.kind === "mock") {
      const last = [...input.messages].reverse().find((m) => m.role === "user");
      const text = `[mock/${model}] acknowledged: ${String(last?.content || "").slice(0, 400)}`;
      return { text, model, providerId: p.id, kind: "mock" };
    }

    if (!p.apiKey) throw new Error(`provider_missing_key:${p.id}`);

    if (p.kind === "claude") {
      return completeClaude(p, model, input.messages, input.maxTokens);
    }
    return completeOpenAICompat(p, model, input.messages, input.maxTokens);
  }

  async function completeOpenAICompat(
    p: ProviderRecord,
    model: string,
    messages: ChatCompletionInput["messages"],
    maxTokens?: number,
  ): Promise<ChatCompletionResult> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    applyProviderReasoningControls(body, {
      modelId: model,
      baseUrl: p.baseUrl,
    });
    delete body.parameters;
    delete body.maxMode;

    const url = `${p.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`provider_http:${res.status}:${raw.slice(0, 200)}`);
    }
    let parsed: {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("provider_bad_json");
    }
    const text = String(parsed.choices?.[0]?.message?.content || "").trim();
    if (!text) throw new Error("provider_empty");
    return {
      text,
      model: String(parsed.model || model),
      providerId: p.id,
      kind: p.kind,
      usage: parsed.usage,
    };
  }

  async function completeClaude(
    p: ProviderRecord,
    model: string,
    messages: ChatCompletionInput["messages"],
    maxTokens?: number,
  ): Promise<ChatCompletionResult> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const mapped = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body = {
      model,
      max_tokens: maxTokens || 4096,
      system: system || undefined,
      messages: mapped,
    };
    const url = `${p.baseUrl.replace(/\/$/, "")}/v1/messages`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": p.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`provider_http:${res.status}:${raw.slice(0, 200)}`);
    }
    let parsed: {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("provider_bad_json");
    }
    const text = (parsed.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("")
      .trim();
    if (!text) throw new Error("provider_empty");
    return {
      text,
      model: String(parsed.model || model),
      providerId: p.id,
      kind: "claude",
      usage: {
        prompt_tokens: parsed.usage?.input_tokens,
        completion_tokens: parsed.usage?.output_tokens,
      },
    };
  }

  return {
    list,
    get,
    getSecret,
    upsert,
    seedDefaults,
    complete,
  };
}

export type ProviderApi = ReturnType<typeof createProviderApi>;
