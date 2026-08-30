/**
 * Guardrails — per-bot permission policy + approval queue.
 * Irreversible defaults to ask; fail closed on deny.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import type {
  ApprovalRequest,
  ApprovalStatus,
  GuardrailPolicy,
  PermissionAction,
  PermissionDecision,
} from "./types.js";

const DEFAULT_ACTIONS: Record<PermissionAction, PermissionDecision> = {
  read: "allow",
  write: "ask",
  exec: "ask",
  network: "ask",
  message: "allow",
  ownership: "ask",
  irreversible: "ask",
};

export function createGuardrailApi(store: ForgeStore) {
  function getPolicy(agentId: string): GuardrailPolicy {
    const state = store.load();
    if (!state.agents[agentId]) throw new Error("unknown_agent");
    return (
      state.policies[agentId] || {
        agentId,
        default: "ask",
        actions: { ...DEFAULT_ACTIONS },
        updatedAt: 0,
      }
    );
  }

  function setPolicy(
    agentId: string,
    patch: {
      default?: PermissionDecision;
      actions?: Partial<Record<PermissionAction, PermissionDecision>>;
    },
    actorId: string,
  ): GuardrailPolicy {
    let out: GuardrailPolicy | null = null;
    store.update((state) => {
      if (!state.agents[agentId]) throw new Error("unknown_agent");
      if (
        actorId !== agentId &&
        state.agents[actorId]?.role !== "chief_of_staff"
      ) {
        throw new Error("not_authorized");
      }
      const cur = state.policies[agentId] || {
        agentId,
        default: "ask" as PermissionDecision,
        actions: { ...DEFAULT_ACTIONS },
        updatedAt: 0,
      };
      if (patch.default) cur.default = patch.default;
      if (patch.actions) {
        cur.actions = { ...cur.actions, ...patch.actions };
      }
      cur.updatedAt = Date.now();
      state.policies[agentId] = cur;
      out = {
        ...cur,
        actions: { ...cur.actions },
      };
      pushAudit(state, "guardrail.policy", actorId, { agentId });
    });
    return out!;
  }

  function decide(
    agentId: string,
    action: PermissionAction,
  ): PermissionDecision {
    const p = getPolicy(agentId);
    return p.actions[action] ?? p.default;
  }

  /**
   * Check permission. Returns allow | deny | pending approval id.
   */
  function check(
    agentId: string,
    action: PermissionAction,
    summary: string,
    detail: Record<string, unknown> = {},
  ): { decision: "allow" | "deny" | "pending"; approvalId?: string } {
    if (!store.load().agents[agentId]) throw new Error("unknown_agent");
    const d = decide(agentId, action);
    if (d === "allow") return { decision: "allow" };
    if (d === "deny") {
      store.update((state) => {
        pushAudit(state, "guardrail.deny", agentId, { action, summary });
      });
      return { decision: "deny" };
    }
    let approvalId = "";
    store.update((state) => {
      const id = newId("apr");
      const row: ApprovalRequest = {
        id,
        agentId,
        action,
        summary: String(summary || "").trim() || action,
        detail,
        status: "pending",
        createdAt: Date.now(),
        resolvedAt: null,
        resolvedBy: null,
      };
      state.approvals[id] = row;
      approvalId = id;
      pushAudit(state, "guardrail.ask", agentId, { approvalId: id, action });
    });
    return { decision: "pending", approvalId };
  }

  function listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    return Object.values(store.load().approvals)
      .filter((a) => (status ? a.status === status : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function getApproval(id: string): ApprovalRequest | null {
    const a = store.load().approvals[id];
    return a ? { ...a, detail: { ...a.detail } } : null;
  }

  function resolve(
    approvalId: string,
    status: "approved" | "rejected",
    resolvedBy: string,
  ): ApprovalRequest {
    let out: ApprovalRequest | null = null;
    store.update((state) => {
      const a = state.approvals[approvalId];
      if (!a) throw new Error("unknown_approval");
      if (a.status !== "pending") throw new Error("not_pending");
      const isHuman = resolvedBy === "human";
      const isChief =
        !!state.agents[resolvedBy] &&
        state.agents[resolvedBy]!.role === "chief_of_staff";
      if (!isHuman && !isChief) throw new Error("not_authorized");
      a.status = status;
      a.resolvedAt = Date.now();
      a.resolvedBy = resolvedBy;
      out = { ...a, detail: { ...a.detail } };
      pushAudit(state, "guardrail.resolve", resolvedBy, {
        approvalId,
        status,
      });
    });
    return out!;
  }

  return {
    getPolicy,
    setPolicy,
    decide,
    check,
    listApprovals,
    getApproval,
    resolve,
  };
}

export type GuardrailApi = ReturnType<typeof createGuardrailApi>;
