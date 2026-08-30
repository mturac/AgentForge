/**
 * Agent chat + group command-chain (Chief of Staff routes to specialists).
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import type { ProviderApi } from "./providers.js";
import type { VmApi } from "./vm.js";
import type { ToolApi } from "./tools.js";
import type { EventApi } from "./events.js";
import { tryOpenHandsBridge } from "./openhands.js";
import {
  CONVERSATION_MSG_CAP,
  type AgentRecord,
  type ChatMessage,
  type ConversationRecord,
} from "./types.js";

function wantsTools(message: string, flag?: boolean): boolean {
  if (flag === false) return false;
  if (flag === true) return true;
  return (
    planHint(message) ||
    /\b(TOOL\s+\w+|execute_bash|str_replace|workspace|list files|run `|delegat)/i.test(
      message,
    )
  );
}

function planHint(message: string): boolean {
  return /^(ls|list|cat|read|view|run|bash|exec|write|create|replace|fetch|browse)\b/i.test(
    message.trim(),
  );
}

function contractPrompt(a: AgentRecord): string {
  const c = a.contract;
  const lines = [
    `You are ${a.name} (${a.title}), role=${a.role}.`,
    `Screen id: ${a.screenId}. You share one account-scoped VM with other bots — screens are not isolation.`,
    `OpenHands-style tools available: execute_bash, str_replace_editor, think, finish, fetch, browser, delegate.`,
    `To call a tool explicitly: TOOL execute_bash {"command":"ls -la"}`,
  ];
  if (c) {
    lines.push(
      `Job: ${c.job}`,
      `Sources: ${c.sources.join("; ")}`,
      `Output: ${c.output}`,
      `Evidence: ${c.evidence}`,
      `Approvals required: ${c.approvalsRequired.join("; ") || "none listed"}`,
      `Stop and ask: ${c.stopAndAsk}`,
      `No-data rule: ${c.noDataRule}`,
    );
  }
  return lines.join("\n");
}

function scoreRoute(agent: AgentRecord, text: string): number {
  const hay = `${agent.name} ${agent.title} ${agent.role} ${agent.contract?.job || ""}`.toLowerCase();
  const needle = text.toLowerCase();
  let score = 0;
  if (agent.role === "specialist") score += 3;
  if (agent.role === "worker") score += 1;
  if (agent.role === "chief_of_staff") score -= 5;
  for (const token of needle.split(/\W+/).filter((t) => t.length > 3)) {
    if (hay.includes(token)) score += 2;
  }
  if (/inbox|email|mail|triage/.test(needle) && /inbox|mail|email/.test(hay)) {
    score += 5;
  }
  if (/calendar|schedule|meeting/.test(needle) && /calendar|schedul/.test(hay)) {
    score += 5;
  }
  if (/research|review|evidence/.test(needle) && /research|review/.test(hay)) {
    score += 4;
  }
  return score;
}

export function createChatApi(
  store: ForgeStore,
  providers: ProviderApi,
  vm: VmApi,
  tools: ToolApi,
  events: EventApi,
) {
  function listConversations(filter?: {
    agentId?: string;
    groupId?: string;
  }): ConversationRecord[] {
    let rows = Object.values(store.load().conversations);
    if (filter?.agentId) {
      rows = rows.filter((c) => c.agentId === filter.agentId);
    }
    if (filter?.groupId) {
      rows = rows.filter((c) => c.groupId === filter.groupId);
    }
    return rows
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ ...c, messages: [...c.messages] }));
  }

  function getConversation(id: string): ConversationRecord | null {
    const c = store.load().conversations[id];
    return c ? { ...c, messages: [...c.messages] } : null;
  }

  function resolveProviderId(agent: AgentRecord): string {
    if (agent.providerId && store.load().providers[agent.providerId]) {
      return agent.providerId;
    }
    const mock = store.load().providers.mock;
    if (mock?.enabled) return "mock";
    const any = Object.values(store.load().providers).find(
      (p) => p.enabled && (p.kind === "mock" || p.apiKey),
    );
    if (any) return any.id;
    throw new Error("no_provider_configured");
  }

  async function agentChat(input: {
    agentId: string;
    message: string;
    conversationId?: string;
    useTools?: boolean;
    openHands?: boolean;
  }): Promise<{
    conversation: ConversationRecord;
    reply: ChatMessage;
    events: ReturnType<EventApi["list"]>;
    toolsUsed: boolean;
    openHands?: { ok: boolean; detail: string } | null;
    route?: undefined;
  }> {
    const text = String(input.message || "").trim();
    if (!text) throw new Error("missing_message");
    const state0 = store.load();
    const agent = state0.agents[input.agentId];
    if (!agent) throw new Error(`unknown_agent:${input.agentId}`);

    let convId = input.conversationId || "";
    let conv = convId ? state0.conversations[convId] : null;
    if (convId && !conv) throw new Error("unknown_conversation");
    if (!conv) {
      const now = Date.now();
      convId = newId("conv");
      conv = {
        id: convId,
        groupId: null,
        agentId: agent.id,
        title: text.slice(0, 60),
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    const userMsg: ChatMessage = {
      id: newId("msg"),
      role: "user",
      agentId: null,
      content: text,
      at: Date.now(),
    };

    let replyText = "";
    let toolsUsed = false;
    let openHandsResult: { ok: boolean; detail: string } | null = null;
    const meta: Record<string, unknown> = {};

    if (input.openHands || /\bopenhands\b/i.test(text)) {
      const bridge = await tryOpenHandsBridge({
        message: text,
        workspaceHint: vm.root,
      });
      if (bridge) {
        openHandsResult = { ok: bridge.ok, detail: bridge.detail };
        events.append({
          agentId: agent.id,
          conversationId: convId,
          kind: bridge.ok ? "observation" : "error",
          tool: "openhands_bridge",
          summary: bridge.mode,
          detail: bridge.detail,
          ok: bridge.ok,
        });
      }
    }

    if (wantsTools(text, input.useTools)) {
      toolsUsed = true;
      const loop = await tools.runLoop({
        agentId: agent.id,
        conversationId: convId,
        message: text,
      });
      replyText = loop.finalText;
      meta.tools = loop.results.map((r) => ({
        tool: r.tool,
        ok: r.ok,
      }));
      // Follow-up LLM summary when tools ran but reply empty
      if (!replyText) {
        replyText = "(no tool output)";
      }
      vm.pushScreen(agent.id, "tools", `ran ${loop.results.length} step(s)`);
    } else {
      const history = [
        { role: "system" as const, content: contractPrompt(agent) },
        ...conv.messages
          .filter((m) => m.role !== "system")
          .slice(-20)
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        { role: "user" as const, content: text },
      ];

      const providerId = resolveProviderId(agent);
      vm.pushScreen(agent.id, "chat.in", text.slice(0, 200));
      const result = await providers.complete({
        providerId,
        model: agent.modelId || undefined,
        messages: history,
      });
      replyText = result.text;
      meta.providerId = providerId;
      meta.model = result.model;
      meta.kind = result.kind;
      vm.pushScreen(
        agent.id,
        "chat.out",
        `${result.kind}/${result.model}: ${result.text.slice(0, 160)}`,
      );

      // If model emitted TOOL calls, execute them
      const planned = tools.plan(result.text);
      if (planned.length) {
        toolsUsed = true;
        const loop = await tools.runLoop({
          agentId: agent.id,
          conversationId: convId,
          message: result.text,
          calls: planned,
        });
        replyText = `${result.text}\n\n---\n${loop.finalText}`;
        meta.tools = loop.results.map((r) => ({ tool: r.tool, ok: r.ok }));
      }
    }

    if (openHandsResult) {
      replyText = `${replyText}\n\n[openhands bridge]\n${openHandsResult.detail}`.trim();
      meta.openHands = openHandsResult;
    }

    const assistantMsg: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      agentId: agent.id,
      content: replyText,
      at: Date.now(),
      meta,
    };

    let out: ConversationRecord | null = null;
    store.update((state) => {
      const c = state.conversations[convId] || {
        ...conv!,
        messages: [],
      };
      c.messages.push(userMsg, assistantMsg);
      if (c.messages.length > CONVERSATION_MSG_CAP) {
        c.messages = c.messages.slice(-CONVERSATION_MSG_CAP);
      }
      c.updatedAt = Date.now();
      state.conversations[c.id] = c;
      const a = state.agents[agent.id];
      if (a && a.status === "idle") a.status = "busy";
      out = { ...c, messages: [...c.messages] };
      pushAudit(state, "chat.agent", agent.id, {
        conversationId: c.id,
        toolsUsed,
      });
    });
    return {
      conversation: out!,
      reply: assistantMsg,
      events: events.list(agent.id, 80),
      toolsUsed,
      openHands: openHandsResult,
    };
  }

  async function groupChat(input: {
    groupId: string;
    message: string;
    fromAgentId?: string;
    conversationId?: string;
    /** Pin specialist; else chief routes. */
    assignTo?: string;
    useTools?: boolean;
  }): Promise<{
    conversation: ConversationRecord;
    route: { targetAgentId: string; reason: string; chiefId: string | null };
    reply: ChatMessage;
    events: ReturnType<EventApi["list"]>;
    toolsUsed: boolean;
  }> {
    const text = String(input.message || "").trim();
    if (!text) throw new Error("missing_message");
    const state0 = store.load();
    const group = state0.groups[input.groupId];
    if (!group) throw new Error(`unknown_group:${input.groupId}`);
    if (group.status !== "open") throw new Error("group_closed");

    const members = group.memberIds
      .map((id) => state0.agents[id])
      .filter(Boolean) as AgentRecord[];
    const chief =
      members.find((a) => a.role === "chief_of_staff") ||
      members.find((a) => a.id === group.ownerId) ||
      null;

    let target: AgentRecord | null = null;
    let reason = "";
    if (input.assignTo) {
      target = members.find((a) => a.id === input.assignTo) || null;
      if (!target) throw new Error(`not_member:${input.assignTo}`);
      reason = "explicit assignTo";
    } else {
      const pool = members.filter((a) => a.role !== "observer");
      const ranked = [...pool].sort(
        (a, b) => scoreRoute(b, text) - scoreRoute(a, text),
      );
      target =
        ranked.find((a) => a.role !== "chief_of_staff") || ranked[0] || null;
      reason = target
        ? `command-chain score; best fit ${target.title}`
        : "no target";
    }
    if (!target) throw new Error("no_available_agents");

    store.update((state) => {
      const g = state.groups[group.id];
      if (!g) return;
      const from = input.fromAgentId || chief?.id || group.ownerId;
      if (!g.memberIds.includes(from)) return;
      g.messages.push({
        id: newId("gmsg"),
        groupId: g.id,
        fromAgentId: from,
        toAgentId: target!.id,
        body: text,
        createdAt: Date.now(),
      });
      g.updatedAt = Date.now();
    });

    let convId = input.conversationId || "";
    if (convId && !store.load().conversations[convId]) {
      throw new Error("unknown_conversation");
    }
    if (!convId) {
      const now = Date.now();
      convId = newId("conv");
      store.update((state) => {
        state.conversations[convId] = {
          id: convId,
          groupId: group.id,
          agentId: null,
          title: `group:${group.name} — ${text.slice(0, 40)}`,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
      });
    }

    const routeNote = chief
      ? `[command-chain] ${chief.name} → ${target.name}: ${reason}`
      : `[command-chain] → ${target.name}: ${reason}`;

    if (chief) vm.pushScreen(chief.id, "route", routeNote);

    const nested = await agentChat({
      agentId: target.id,
      message: text,
      conversationId: convId,
      useTools: input.useTools,
    });

    const assistantMsg: ChatMessage = {
      ...nested.reply,
      meta: { ...(nested.reply.meta || {}), route: routeNote },
    };

    let out: ConversationRecord | null = null;
    store.update((state) => {
      const c = state.conversations[convId];
      if (!c) return;
      const last = c.messages[c.messages.length - 1];
      if (last && last.role === "assistant") {
        last.meta = { ...(last.meta || {}), route: routeNote };
      }
      const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        lastUser.meta = { ...(lastUser.meta || {}), route: routeNote };
      }
      c.groupId = group.id;
      c.updatedAt = Date.now();
      state.conversations[c.id] = c;
      out = { ...c, messages: [...c.messages] };
      pushAudit(state, "chat.group", target!.id, {
        groupId: group.id,
        conversationId: c.id,
        route: routeNote,
      });
    });

    return {
      conversation: out!,
      route: {
        targetAgentId: target.id,
        reason,
        chiefId: chief?.id || null,
      },
      reply: assistantMsg,
      events: nested.events,
      toolsUsed: nested.toolsUsed,
    };
  }

  return { listConversations, getConversation, agentChat, groupChat };
}

export type ChatApi = ReturnType<typeof createChatApi>;
