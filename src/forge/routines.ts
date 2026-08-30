/**
 * Routines — skills fired on schedule or event trigger.
 * Cron subset: "m h * * *" (minute hour), UTC. Also interval + event.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import {
  ROUTINE_RUN_CAP,
  type RoutineRecord,
  type RoutineRun,
  type RoutineRunStatus,
  type RoutineTrigger,
} from "./types.js";

export type CreateRoutineInput = {
  name: string;
  skillId: string;
  agentId: string;
  trigger: RoutineTrigger;
  enabled?: boolean;
  id?: string;
};

function parseCronField(field: string, min: number, max: number): number[] | null {
  if (field === "*") {
    const all: number[] = [];
    for (let i = min; i <= max; i++) all.push(i);
    return all;
  }
  if (/^\d+$/.test(field)) {
    const n = Number(field);
    if (n < min || n > max) return null;
    return [n];
  }
  if (/^\*\/\d+$/.test(field)) {
    const step = Number(field.slice(2));
    if (step < 1) return null;
    const out: number[] = [];
    for (let i = min; i <= max; i += step) out.push(i);
    return out;
  }
  return null;
}

/** Next run for "m h * * *" cron (5 fields). Returns null if invalid. */
export function nextCronUtc(expression: string, fromMs = Date.now()): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins = parseCronField(parts[0]!, 0, 59);
  const hours = parseCronField(parts[1]!, 0, 23);
  if (!mins || !hours) return null;
  // day/month/dow must be *
  if (parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") return null;

  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 8; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (hours.includes(t.getUTCHours()) && mins.includes(t.getUTCMinutes())) {
      return t.getTime();
    }
  }
  return null;
}

export function computeNextRun(
  trigger: RoutineTrigger,
  fromMs = Date.now(),
  lastRunAt: number | null = null,
): number | null {
  if (trigger.kind === "interval") {
    if (trigger.everyMs < 1000) throw new Error("interval_too_short");
    const base = lastRunAt ?? fromMs;
    return base + trigger.everyMs;
  }
  if (trigger.kind === "cron") {
    return nextCronUtc(trigger.expression, fromMs);
  }
  // event-driven: no wall-clock next
  return null;
}

export function createRoutineApi(store: ForgeStore) {
  function list(): RoutineRecord[] {
    return Object.values(store.load().routines).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  function get(id: string): RoutineRecord | null {
    return store.load().routines[id] || null;
  }

  function create(input: CreateRoutineInput): RoutineRecord {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("missing_name");
    let created: RoutineRecord | null = null;
    store.update((state) => {
      if (!state.agents[input.agentId]) {
        throw new Error(`unknown_agent:${input.agentId}`);
      }
      if (!state.skills[input.skillId]) {
        throw new Error(`unknown_skill:${input.skillId}`);
      }
      const id = input.id || newId("rtn");
      if (state.routines[id]) throw new Error(`duplicate_id:${id}`);
      const now = Date.now();
      const nextRunAt = computeNextRun(input.trigger, now, null);
      if (input.trigger.kind === "cron" && nextRunAt == null) {
        throw new Error("invalid_cron");
      }
      const row: RoutineRecord = {
        id,
        name,
        skillId: input.skillId,
        agentId: input.agentId,
        trigger: input.trigger,
        enabled: input.enabled !== false,
        lastRunAt: null,
        nextRunAt,
        runs: [],
        createdAt: now,
        updatedAt: now,
      };
      state.routines[id] = row;
      created = { ...row, runs: [] };
      pushAudit(state, "routine.create", input.agentId, { routineId: id });
    });
    return created!;
  }

  function setEnabled(id: string, enabled: boolean, actorId: string): RoutineRecord {
    let out: RoutineRecord | null = null;
    store.update((state) => {
      const r = state.routines[id];
      if (!r) throw new Error("unknown_routine");
      if (
        actorId !== r.agentId &&
        state.agents[actorId]?.role !== "chief_of_staff"
      ) {
        throw new Error("not_authorized");
      }
      r.enabled = enabled;
      r.updatedAt = Date.now();
      if (enabled && r.trigger.kind !== "event") {
        r.nextRunAt = computeNextRun(r.trigger, Date.now(), r.lastRunAt);
      }
      out = { ...r };
      pushAudit(state, "routine.enable", actorId, { routineId: id, enabled });
    });
    return out!;
  }

  /** Due routines at `now` (wall clock). Event triggers ignored here. */
  function due(now = Date.now()): RoutineRecord[] {
    return Object.values(store.load().routines).filter(
      (r) =>
        r.enabled &&
        r.trigger.kind !== "event" &&
        r.nextRunAt != null &&
        r.nextRunAt <= now,
    );
  }

  /** Mark run complete, append run history (cap 20), advance nextRunAt. */
  function markRan(
    id: string,
    at = Date.now(),
    opts: { status?: RoutineRunStatus; note?: string; startedAt?: number } = {},
  ): RoutineRecord {
    let out: RoutineRecord | null = null;
    store.update((state) => {
      const r = state.routines[id];
      if (!r) throw new Error("unknown_routine");
      if (!Array.isArray(r.runs)) r.runs = [];
      const run: RoutineRun = {
        id: newId("rrun"),
        startedAt: opts.startedAt ?? at,
        endedAt: at,
        status: opts.status || "ok",
        note: String(opts.note || "").trim(),
      };
      r.runs.push(run);
      if (r.runs.length > ROUTINE_RUN_CAP) {
        r.runs = r.runs.slice(-ROUTINE_RUN_CAP);
      }
      r.lastRunAt = at;
      r.nextRunAt = computeNextRun(r.trigger, at, at);
      r.updatedAt = at;
      out = { ...r, runs: [...r.runs] };
      pushAudit(state, "routine.ran", r.agentId, {
        routineId: id,
        runId: run.id,
        status: run.status,
      });
    });
    return out!;
  }

  function listRuns(id: string): RoutineRun[] {
    const r = store.load().routines[id];
    if (!r) throw new Error("unknown_routine");
    return [...(r.runs || [])];
  }

  /** Fire event-triggered routines matching `event`. */
  function fireEvent(event: string, actorId: string): RoutineRecord[] {
    const hit: RoutineRecord[] = [];
    store.update((state) => {
      for (const r of Object.values(state.routines)) {
        if (
          r.enabled &&
          r.trigger.kind === "event" &&
          r.trigger.event === event
        ) {
          r.lastRunAt = Date.now();
          r.updatedAt = r.lastRunAt;
          hit.push({ ...r });
          pushAudit(state, "routine.event", actorId, {
            routineId: r.id,
            event,
          });
        }
      }
    });
    return hit;
  }

  return { list, get, create, setEnabled, due, markRan, listRuns, fireEvent };
}

export type RoutineApi = ReturnType<typeof createRoutineApi>;
