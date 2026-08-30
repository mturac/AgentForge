/**
 * OpenHands-style event stream — action / observation / thought / finish.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import {
  EVENT_CAP,
  type AgentEvent,
  type AgentEventKind,
} from "./types.js";

export function createEventApi(store: ForgeStore) {
  function list(agentId: string, limit = 80): AgentEvent[] {
    const all = store.load().events[agentId] || [];
    return all.slice(-Math.max(1, Math.min(limit, EVENT_CAP)));
  }

  function listByConversation(conversationId: string, limit = 120): AgentEvent[] {
    const state = store.load();
    const out: AgentEvent[] = [];
    for (const events of Object.values(state.events)) {
      for (const e of events) {
        if (e.conversationId === conversationId) out.push(e);
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(-Math.max(1, Math.min(limit, EVENT_CAP)));
  }

  function append(input: {
    agentId: string;
    conversationId?: string | null;
    kind: AgentEventKind;
    tool?: string | null;
    summary: string;
    detail?: string;
    ok?: boolean;
  }): AgentEvent {
    const row: AgentEvent = {
      id: newId("evt"),
      at: Date.now(),
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      kind: input.kind,
      tool: input.tool ?? null,
      summary: String(input.summary || "").slice(0, 400),
      detail: String(input.detail || "").slice(0, 8000),
      ok: input.ok !== false,
    };
    store.update((state) => {
      const list = state.events[input.agentId] || (state.events[input.agentId] = []);
      list.push(row);
      if (list.length > EVENT_CAP) {
        state.events[input.agentId] = list.slice(-EVENT_CAP);
      }
      pushAudit(state, `event.${input.kind}`, input.agentId, {
        tool: row.tool,
        summary: row.summary,
      });
    });
    return row;
  }

  return { list, listByConversation, append };
}

export type EventApi = ReturnType<typeof createEventApi>;
