/**
 * Persistent agent registry — role contracts + screens (not isolation).
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import {
  AGENT_ROSTER_SOFT_CAP,
  type AgentRecord,
  type AgentRole,
  type AgentStatus,
  type RoleContract,
} from "./types.js";

export type CreateAgentInput = {
  name: string;
  role?: AgentRole;
  title?: string;
  modelId?: string;
  hopBaseUrl?: string;
  screenId?: string;
  skillIds?: string[];
  memory?: Record<string, unknown>;
  contract?: RoleContract | null;
  providerId?: string;
  id?: string;
};

function requireName(name: string): string {
  const n = String(name || "").trim();
  if (!n) throw new Error("missing_name");
  if (n.length > 80) throw new Error("name_too_long");
  return n;
}

function normalizeContract(raw: RoleContract | null | undefined): RoleContract | null {
  if (raw == null) return null;
  const job = String(raw.job || "").trim();
  const output = String(raw.output || "").trim();
  const evidence = String(raw.evidence || "").trim();
  const stopAndAsk = String(raw.stopAndAsk || "").trim();
  const noDataRule = String(raw.noDataRule || "").trim();
  if (!job) throw new Error("contract_missing_job");
  if (!output) throw new Error("contract_missing_output");
  if (!evidence) throw new Error("contract_missing_evidence");
  if (!stopAndAsk) throw new Error("contract_missing_stopAndAsk");
  if (!noDataRule) throw new Error("contract_missing_noDataRule");
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const approvalsRequired = Array.isArray(raw.approvalsRequired)
    ? raw.approvalsRequired.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!sources.length) throw new Error("contract_missing_sources");
  return {
    job,
    sources,
    output,
    evidence,
    approvalsRequired,
    stopAndAsk,
    noDataRule,
  };
}

export function createAgentApi(store: ForgeStore) {
  function list(): AgentRecord[] {
    return Object.values(store.load().agents).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  function get(id: string): AgentRecord | null {
    return store.load().agents[id] || null;
  }

  function getByName(name: string): AgentRecord | null {
    const n = name.trim().toLowerCase();
    return (
      Object.values(store.load().agents).find(
        (a) => a.name.toLowerCase() === n,
      ) || null
    );
  }

  function create(input: CreateAgentInput): AgentRecord {
    const name = requireName(input.name);
    const contract = normalizeContract(input.contract);
    let created: AgentRecord | null = null;
    store.update((state) => {
      const count = Object.keys(state.agents).length;
      if (count >= AGENT_ROSTER_SOFT_CAP) {
        throw new Error(`agent_roster_cap:${AGENT_ROSTER_SOFT_CAP}`);
      }
      const clash = Object.values(state.agents).find(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) throw new Error(`duplicate_name:${clash.id}`);
      const now = Date.now();
      const id = input.id || newId("agent");
      if (state.agents[id]) throw new Error(`duplicate_id:${id}`);
      const row: AgentRecord = {
        id,
        name,
        role: input.role || "worker",
        title: String(input.title || name).trim() || name,
        modelId: String(input.modelId || "").trim(),
        hopBaseUrl: String(input.hopBaseUrl || "").trim(),
        screenId: String(input.screenId || `screen-${id}`).trim(),
        status: "idle",
        memory:
          input.memory && typeof input.memory === "object"
            ? { ...input.memory }
            : {},
        skillIds: Array.isArray(input.skillIds)
          ? [...new Set(input.skillIds.map(String))]
          : [],
        providerId: String(input.providerId || "").trim(),
        contract,
        hidden: false,
        createdAt: now,
        updatedAt: now,
      };
      state.agents[id] = row;
      created = { ...row, contract: row.contract ? { ...row.contract, sources: [...row.contract.sources], approvalsRequired: [...row.contract.approvalsRequired] } : null };
      pushAudit(state, "agent.create", id, { name: row.name, role: row.role });
    });
    return created!;
  }

  function update(
    id: string,
    patch: Partial<
      Pick<
        AgentRecord,
        | "name"
        | "role"
        | "title"
        | "modelId"
        | "hopBaseUrl"
        | "screenId"
        | "status"
        | "memory"
        | "skillIds"
        | "contract"
        | "hidden"
        | "providerId"
      >
    >,
  ): AgentRecord {
    let out: AgentRecord | null = null;
    store.update((state) => {
      const row = state.agents[id];
      if (!row) throw new Error("unknown_agent");
      if (patch.name != null) {
        const name = requireName(patch.name);
        const clash = Object.values(state.agents).find(
          (a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase(),
        );
      if (clash) throw new Error(`duplicate_name:${clash.id}`);
        row.name = name;
      }
      if (patch.role != null) row.role = patch.role;
      if (patch.title != null)
        row.title = String(patch.title).trim() || row.name;
      if (patch.modelId != null) row.modelId = String(patch.modelId).trim();
      if (patch.hopBaseUrl != null)
        row.hopBaseUrl = String(patch.hopBaseUrl).trim();
      if (patch.screenId != null) row.screenId = String(patch.screenId).trim();
      if (patch.status != null) row.status = patch.status as AgentStatus;
      if (patch.memory != null && typeof patch.memory === "object") {
        row.memory = { ...patch.memory };
      }
      if (patch.skillIds != null) {
        row.skillIds = [...new Set(patch.skillIds.map(String))];
      }
      if (patch.contract !== undefined) {
        row.contract = normalizeContract(patch.contract);
      }
      if (patch.providerId != null) row.providerId = String(patch.providerId).trim();
      if (patch.hidden != null) row.hidden = !!patch.hidden;
      row.updatedAt = Date.now();
      out = {
        ...row,
        contract: row.contract
          ? {
              ...row.contract,
              sources: [...row.contract.sources],
              approvalsRequired: [...row.contract.approvalsRequired],
            }
          : null,
      };
      pushAudit(state, "agent.update", id, { keys: Object.keys(patch) });
    });
    return out!;
  }

  function setContract(id: string, contract: RoleContract, actorId: string): AgentRecord {
    let out: AgentRecord | null = null;
    store.update((state) => {
      const row = state.agents[id];
      if (!row) throw new Error("unknown_agent");
      if (
        actorId !== id &&
        state.agents[actorId]?.role !== "chief_of_staff"
      ) {
        throw new Error("not_authorized");
      }
      row.contract = normalizeContract(contract);
      row.updatedAt = Date.now();
      out = {
        ...row,
        contract: row.contract
          ? {
              ...row.contract,
              sources: [...row.contract.sources],
              approvalsRequired: [...row.contract.approvalsRequired],
            }
          : null,
      };
      pushAudit(state, "agent.contract", actorId, { agentId: id });
    });
    return out!;
  }

  function remove(id: string): void {
    store.update((state) => {
      if (!state.agents[id]) throw new Error("unknown_agent");
      for (const g of Object.values(state.groups)) {
        if (g.memberIds.includes(id)) {
          throw new Error(
            g.status === "open"
              ? `agent_in_open_group:${g.id}`
              : `agent_in_group:${g.id}`,
          );
        }
      }
      for (const r of Object.values(state.routines)) {
        if (r.agentId === id) throw new Error(`agent_has_routine:${r.id}`);
      }
      for (const s of Object.values(state.skills)) {
        if (s.createdBy === id) throw new Error(`agent_owns_skill:${s.id}`);
        if (s.sharedWith.includes(id)) {
          throw new Error(`agent_in_skill_share:${s.id}`);
        }
      }
      for (const w of Object.values(state.work)) {
        if (w.assignedTo === id || w.requestedBy === id) {
          throw new Error(`agent_in_work:${w.id}`);
        }
      }
      for (const a of Object.values(state.approvals)) {
        if (a.agentId === id && a.status === "pending") {
          throw new Error(`agent_has_pending_approval:${a.id}`);
        }
      }
      for (const h of Object.values(state.handoffs)) {
        if (
          (h.fromAgentId === id || h.toAgentId === id) &&
          (h.status === "open" || h.status === "accepted")
        ) {
          throw new Error(`agent_has_open_handoff:${h.id}`);
        }
      }
      delete state.agents[id];
      delete state.policies[id];
      pushAudit(state, "agent.remove", id, {});
    });
  }

  return { list, get, getByName, create, update, setContract, remove };
}

export type AgentApi = ReturnType<typeof createAgentApi>;
