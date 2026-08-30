/**
 * Orchestrator — Chief of Staff routes work to specialists.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import type {
  AgentRecord,
  WorkEvidence,
  WorkEvidenceSource,
  WorkItem,
  WorkItemStatus,
} from "./types.js";

export type SubmitWorkInput = {
  title: string;
  body: string;
  requestedBy: string;
  /** Preferred specialist id; otherwise auto-route. */
  assignTo?: string;
  groupId?: string;
  skillId?: string;
};

function scoreSpecialist(agent: AgentRecord, title: string, body: string): number {
  const hay = `${agent.name} ${agent.title} ${agent.role}`.toLowerCase();
  const needle = `${title} ${body}`.toLowerCase();
  let score = 0;
  if (agent.role === "specialist") score += 3;
  if (agent.role === "worker") score += 1;
  if (agent.status === "idle") score += 2;
  if (agent.status === "busy") score -= 2;
  if (agent.status === "offline" || agent.status === "error") score -= 10;
  for (const token of needle.split(/\W+/).filter((t) => t.length > 3)) {
    if (hay.includes(token)) score += 2;
  }
  return score;
}

export function createOrchestratorApi(store: ForgeStore) {
  function listWork(): WorkItem[] {
    return Object.values(store.load().work).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  function getWork(id: string): WorkItem | null {
    return store.load().work[id] || null;
  }

  function pickAssignee(
    state: ReturnType<ForgeStore["load"]>,
    title: string,
    body: string,
    prefer?: string,
  ): string {
    if (prefer) {
      if (!state.agents[prefer]) throw new Error(`unknown_agent:${prefer}`);
      const pref = state.agents[prefer]!;
      if (pref.status === "offline" || pref.status === "error") {
        throw new Error(`agent_unavailable:${prefer}`);
      }
      return prefer;
    }
    const chiefs = Object.values(state.agents).filter(
      (a) => a.role === "chief_of_staff",
    );
    const pool = Object.values(state.agents).filter(
      (a) =>
        (a.role === "specialist" || a.role === "worker") &&
        a.status !== "offline" &&
        a.status !== "error",
    );
    if (!pool.length) {
      const activeChief = chiefs.find(
        (a) => a.status !== "offline" && a.status !== "error",
      );
      if (activeChief) return activeChief.id;
      throw new Error("no_available_agents");
    }
    pool.sort(
      (a, b) =>
        scoreSpecialist(b, title, body) - scoreSpecialist(a, title, body),
    );
    return pool[0]!.id;
  }

  function submit(input: SubmitWorkInput): WorkItem {
    const title = String(input.title || "").trim();
    const body = String(input.body || "").trim();
    if (!title) throw new Error("missing_title");
    if (!body) throw new Error("missing_body");
    let item: WorkItem | null = null;
    store.update((state) => {
      if (!state.agents[input.requestedBy]) {
        throw new Error(`unknown_agent:${input.requestedBy}`);
      }
      if (input.groupId && !state.groups[input.groupId]) {
        throw new Error(`unknown_group:${input.groupId}`);
      }
      if (input.skillId && !state.skills[input.skillId]) {
        throw new Error(`unknown_skill:${input.skillId}`);
      }
      const assignedTo = pickAssignee(
        state,
        title,
        body,
        input.assignTo,
      );
      const now = Date.now();
      const row: WorkItem = {
        id: newId("work"),
        title,
        body,
        requestedBy: input.requestedBy,
        assignedTo,
        status: "assigned",
        groupId: input.groupId || null,
        skillId: input.skillId || null,
        evidence: null,
        createdAt: now,
        updatedAt: now,
      };
      state.work[row.id] = row;
      const agent = state.agents[assignedTo];
      if (agent && agent.status === "idle") agent.status = "busy";
      item = { ...row };
      pushAudit(state, "work.submit", input.requestedBy, {
        workId: row.id,
        assignedTo,
      });
    });
    return item!;
  }

  function setStatus(
    workId: string,
    status: WorkItemStatus,
    actorId: string,
  ): WorkItem {
    const allowed: WorkItemStatus[] = [
      "queued",
      "assigned",
      "in_progress",
      "blocked",
      "done",
      "failed",
    ];
    if (!allowed.includes(status)) throw new Error("bad_status");
    let out: WorkItem | null = null;
    store.update((state) => {
      const w = state.work[workId];
      if (!w) throw new Error("unknown_work");
      if (
        actorId !== w.assignedTo &&
        actorId !== w.requestedBy &&
        state.agents[actorId]?.role !== "chief_of_staff"
      ) {
        throw new Error("not_authorized");
      }
      const prev = w.status;
      if (status === "done" && !w.evidence) {
        throw new Error("missing_evidence");
      }
      w.status = status;
      w.updatedAt = Date.now();
      const active =
        status === "assigned" ||
        status === "in_progress" ||
        status === "blocked" ||
        status === "queued";
      const wasTerminal = prev === "done" || prev === "failed";
      if (active && w.assignedTo && state.agents[w.assignedTo]) {
        state.agents[w.assignedTo]!.status = "busy";
      }
      if (
        (status === "done" || status === "failed") &&
        w.assignedTo &&
        state.agents[w.assignedTo]
      ) {
        const stillBusy = Object.values(state.work).some(
          (x) =>
            x.id !== workId &&
            x.assignedTo === w.assignedTo &&
            (x.status === "assigned" ||
              x.status === "in_progress" ||
              x.status === "blocked" ||
              x.status === "queued"),
        );
        if (!stillBusy) state.agents[w.assignedTo]!.status = "idle";
      }
      if (wasTerminal && active) {
        // reopened — busy already set above
      }
      out = { ...w };
      pushAudit(state, "work.status", actorId, { workId, status });
    });
    return out!;
  }

  function recordEvidence(
    workId: string,
    actorId: string,
    evidence: {
      summary: string;
      sources?: WorkEvidenceSource[];
      filesChanged?: string[];
      uncertainties?: string[];
    },
  ): WorkItem {
    const summary = String(evidence.summary || "").trim();
    if (!summary) throw new Error("missing_evidence_summary");
    let out: WorkItem | null = null;
    store.update((state) => {
      const w = state.work[workId];
      if (!w) throw new Error("unknown_work");
      if (
        actorId !== w.assignedTo &&
        actorId !== w.requestedBy &&
        state.agents[actorId]?.role !== "chief_of_staff"
      ) {
        throw new Error("not_authorized");
      }
      const pack: WorkEvidence = {
        summary,
        sources: (evidence.sources || []).map((s) => ({
          label: String(s.label || "").trim(),
          url: s.url != null ? String(s.url) : undefined,
          at: Number(s.at) || Date.now(),
        })),
        filesChanged: (evidence.filesChanged || []).map(String),
        uncertainties: (evidence.uncertainties || []).map(String),
        recordedAt: Date.now(),
        recordedBy: actorId,
      };
      if (pack.sources.some((s) => !s.label)) {
        throw new Error("evidence_source_missing_label");
      }
      w.evidence = pack;
      w.updatedAt = Date.now();
      out = { ...w, evidence: { ...pack, sources: [...pack.sources] } };
      pushAudit(state, "work.evidence", actorId, { workId });
    });
    return out!;
  }

  function reassign(
    workId: string,
    toAgentId: string,
    actorId: string,
  ): WorkItem {
    let out: WorkItem | null = null;
    store.update((state) => {
      const w = state.work[workId];
      if (!w) throw new Error("unknown_work");
      if (
        state.agents[actorId]?.role !== "chief_of_staff" &&
        actorId !== w.requestedBy
      ) {
        throw new Error("not_authorized");
      }
      if (!state.agents[toAgentId]) throw new Error(`unknown_agent:${toAgentId}`);
      const prev = w.assignedTo;
      w.assignedTo = toAgentId;
      w.status = "assigned";
      w.updatedAt = Date.now();
      state.agents[toAgentId]!.status = "busy";
      if (prev && state.agents[prev]) {
        const stillBusy = Object.values(state.work).some(
          (x) =>
            x.assignedTo === prev &&
            (x.status === "assigned" || x.status === "in_progress"),
        );
        if (!stillBusy) state.agents[prev]!.status = "idle";
      }
      out = { ...w };
      pushAudit(state, "work.reassign", actorId, { workId, toAgentId });
    });
    return out!;
  }

  return { listWork, getWork, submit, setStatus, recordEvidence, reassign };
}

export type OrchestratorApi = ReturnType<typeof createOrchestratorApi>;
