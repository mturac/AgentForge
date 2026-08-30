/**
 * In-memory consult registry. One pending consult at a time.
 * Behavioral port of OnlyTerp/opengrok `voice/lib/consult-bus.cjs` (MIT).
 */

import { createHash, randomBytes } from "node:crypto";

export const OPEN_STATUSES = new Set(["queued", "in_progress"]);
export const ALL_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "failed",
]);

export type ConsultStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed";

export type ConsultSnapshot = {
  consult_id: string;
  status: ConsultStatus;
  agent: string;
  agent_id: string;
  fingerprint: string;
  question: string;
  text: string;
  started_at: number;
  ended_at: number;
  rtt_ms: number;
  error: string;
  duplicate: boolean;
  delivered: boolean;
};

type Row = {
  id: string;
  fp: string;
  status: ConsultStatus;
  agent: string;
  agentId: string;
  question: string;
  startedAt: number;
  endedAt: number;
  error: string;
  text: string;
  duplicate?: boolean;
  delivered: boolean;
};

export type ConsultStartInput = {
  question?: string;
  agent?: string;
  agent_name?: string;
  agent_id?: string;
  agentId?: string;
  consult_id?: string;
  id?: string;
};

export type ConsultPingInput = ConsultStartInput & {
  status?: string;
  text?: string;
  result?: string;
  answer?: string;
  error?: string;
};

export type ConsultBusLog = (...args: unknown[]) => void;

export function fingerprint(question: string, agentId: string): string {
  const q = String(question || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const a = String(agentId || "")
    .trim()
    .toLowerCase();
  return createHash("sha1")
    .update(a + "\n" + q)
    .digest("hex")
    .slice(0, 16);
}

export function newConsultId(): string {
  return `c_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function snapshot(row: Row | null | undefined): ConsultSnapshot | null {
  if (!row) return null;
  const rtt = row.endedAt
    ? row.endedAt - row.startedAt
    : Date.now() - row.startedAt;
  return {
    consult_id: row.id,
    status: row.status,
    agent: row.agent,
    agent_id: row.agentId,
    fingerprint: row.fp,
    question: row.question,
    text: row.text || "",
    started_at: row.startedAt,
    ended_at: row.endedAt || 0,
    rtt_ms: rtt,
    error: row.error || "",
    duplicate: !!row.duplicate,
    delivered: !!row.delivered,
  };
}

export function createConsultBus(log?: ConsultBusLog) {
  const byId = new Map<string, Row>();
  let openId = "";

  function openRow(): Row | null {
    if (!openId) return null;
    return byId.get(openId) || null;
  }

  function start(input: ConsultStartInput = {}) {
    const question = String(input.question || "").trim();
    if (!question) {
      return { ok: false as const, error: "missing_question" };
    }
    const agent = String(input.agent || input.agent_name || "assistant");
    const agentId = String(input.agent_id || input.agentId || "");
    const fp = fingerprint(question, agentId);
    const cur = openRow();
    if (cur && OPEN_STATUSES.has(cur.status)) {
      if (cur.fp === fp) {
        log?.("consult.bus skip-dup", cur.id, cur.status, fp);
        return {
          ...snapshot(cur)!,
          ok: true as const,
          duplicate: true,
          reason: "already_pending",
        };
      }
      log?.("consult.bus busy", cur.id, cur.fp, "!=", fp);
      return {
        ok: false as const,
        error: "busy",
        consult_id: cur.id,
        open: snapshot(cur),
      };
    }
    const id = String(input.consult_id || input.id || newConsultId());
    const row: Row = {
      id,
      fp,
      status: "queued",
      agent,
      agentId,
      question,
      startedAt: Date.now(),
      endedAt: 0,
      error: "",
      text: "",
      delivered: false,
    };
    byId.set(id, row);
    openId = id;
    log?.("consult.bus queued", id, agent, question.slice(0, 80));
    return {
      ...snapshot(row)!,
      ok: true as const,
      duplicate: false,
    };
  }

  function ping(input: ConsultPingInput = {}) {
    const status = String(input.status || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_") as ConsultStatus;
    if (!ALL_STATUSES.has(status)) {
      return {
        ok: false as const,
        error: "bad_status",
        allowed: [...ALL_STATUSES],
      };
    }
    let row: Row | null = null;
    const id = String(input.consult_id || input.id || "").trim();
    if (id) {
      if (!byId.has(id)) {
        return { ok: false as const, error: "unknown_consult_id", consult_id: id };
      }
      row = byId.get(id)!;
    } else {
      row = openRow();
    }
    if (!row && (status === "queued" || status === "in_progress")) {
      return start(input);
    }
    if (!row) return { ok: false as const, error: "no_open_consult" };

    if (status === "queued" && OPEN_STATUSES.has(row.status)) {
      return {
        ...snapshot(row)!,
        ok: true as const,
        duplicate: true,
        reason: "already_pending",
      };
    }
    if (status === "in_progress") {
      if (row.status === "completed" || row.status === "failed") {
        return {
          ...snapshot(row)!,
          ok: true as const,
          duplicate: true,
          reason: "already_terminal",
        };
      }
      row.status = "in_progress";
      log?.("consult.bus in_progress", row.id);
      return {
        ...snapshot(row)!,
        ok: true as const,
        duplicate: false,
      };
    }
    if (status === "completed" || status === "failed") {
      if (row.status === "completed" || row.status === "failed") {
        log?.("consult.bus dup-terminal", row.id, row.status);
        return {
          ...snapshot(row)!,
          ok: true as const,
          duplicate: true,
          reason: "already_terminal",
          text: row.text,
          retry_push: !row.delivered,
        };
      }
      const text = String(
        input.text || input.result || input.answer || "",
      ).trim();
      const err = String(input.error || "").trim();
      if (status === "completed" && !text) {
        return {
          ok: false as const,
          error: "missing_text",
          consult_id: row.id,
        };
      }
      row.status = status;
      row.text = text;
      row.error = err;
      row.endedAt = Date.now();
      if (openId === row.id) openId = "";
      const snap = snapshot(row)!;
      log?.(
        "consult.bus",
        status,
        row.id,
        `rtt_ms=${snap.rtt_ms}`,
        (err || text).slice(0, 80),
      );
      return {
        ...snap,
        ok: true as const,
        duplicate: false,
        text,
        retry_push: true,
      };
    }
    return { ...snapshot(row)!, ok: true as const };
  }

  function markDelivered(id: string): boolean {
    const row = byId.get(id);
    if (!row) return false;
    row.delivered = true;
    return true;
  }

  return {
    start,
    ping,
    markDelivered,
    open: () => snapshot(openRow()),
    get: (id: string) => snapshot(byId.get(id)),
    fingerprint,
    newId: newConsultId,
  };
}

export type ConsultBus = ReturnType<typeof createConsultBus>;
