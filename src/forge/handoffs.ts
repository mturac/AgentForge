/**
 * Explicit bot-to-bot handoffs — visible ownership transfer of work.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import type { HandoffRecord, HandoffStatus } from "./types.js";

export type CreateHandoffInput = {
  fromAgentId: string;
  toAgentId: string;
  summary: string;
  workId?: string | null;
};

export function createHandoffApi(store: ForgeStore) {
  function list(status?: HandoffStatus): HandoffRecord[] {
    return Object.values(store.load().handoffs)
      .filter((h) => (status ? h.status === status : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function get(id: string): HandoffRecord | null {
    return store.load().handoffs[id] || null;
  }

  function create(input: CreateHandoffInput): HandoffRecord {
    const summary = String(input.summary || "").trim();
    if (!summary) throw new Error("missing_summary");
    let created: HandoffRecord | null = null;
    store.update((state) => {
      if (!state.agents[input.fromAgentId]) {
        throw new Error(`unknown_agent:${input.fromAgentId}`);
      }
      if (!state.agents[input.toAgentId]) {
        throw new Error(`unknown_agent:${input.toAgentId}`);
      }
      if (input.fromAgentId === input.toAgentId) {
        throw new Error("handoff_same_agent");
      }
      const workId = input.workId ? String(input.workId) : null;
      if (workId && !state.work[workId]) {
        throw new Error(`unknown_work:${workId}`);
      }
      const now = Date.now();
      const row: HandoffRecord = {
        id: newId("hand"),
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        workId,
        summary,
        result: null,
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      state.handoffs[row.id] = row;
      if (workId && state.work[workId]) {
        state.work[workId]!.assignedTo = input.toAgentId;
        state.work[workId]!.status = "assigned";
        state.work[workId]!.updatedAt = now;
        const to = state.agents[input.toAgentId];
        if (to && to.status === "idle") to.status = "busy";
      }
      created = { ...row };
      pushAudit(state, "handoff.create", input.fromAgentId, {
        handoffId: row.id,
        toAgentId: input.toAgentId,
        workId,
      });
    });
    return created!;
  }

  function resolve(
    id: string,
    status: "accepted" | "completed" | "rejected",
    actorId: string,
    result?: string,
  ): HandoffRecord {
    let out: HandoffRecord | null = null;
    store.update((state) => {
      const h = state.handoffs[id];
      if (!h) throw new Error("unknown_handoff");
      if (h.status === "completed" || h.status === "rejected") {
        throw new Error("handoff_terminal");
      }
      const isChief = state.agents[actorId]?.role === "chief_of_staff";
      if (status === "accepted") {
        if (actorId !== h.toAgentId && !isChief) throw new Error("not_authorized");
        if (h.status !== "open") throw new Error("handoff_not_open");
        h.status = "accepted";
      } else if (status === "rejected") {
        if (actorId !== h.toAgentId && actorId !== h.fromAgentId && !isChief) {
          throw new Error("not_authorized");
        }
        h.status = "rejected";
        h.result = String(result || "").trim() || "rejected";
      } else {
        // completed
        if (actorId !== h.toAgentId && !isChief) throw new Error("not_authorized");
        if (h.status !== "open" && h.status !== "accepted") {
          throw new Error("handoff_not_active");
        }
        const text = String(result || "").trim();
        if (!text) throw new Error("missing_result");
        h.status = "completed";
        h.result = text;
      }
      h.updatedAt = Date.now();
      out = { ...h };
      pushAudit(state, "handoff.resolve", actorId, {
        handoffId: id,
        status: h.status,
      });
    });
    return out!;
  }

  return { list, get, create, resolve };
}

export type HandoffApi = ReturnType<typeof createHandoffApi>;
