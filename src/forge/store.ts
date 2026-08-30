/**
 * Atomic durable JSON store for AgentForge.
 * Fail-closed on corrupt state; write via temp + rename.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ForgeState } from "./types.js";
import { AUDIT_CAP } from "./types.js";

export function defaultForgeHome(): string {
  return (
    process.env.AGENTFORGE_HOME ||
    process.env.OPENTHEBOT_HOME ||
    join(homedir(), ".agentforge")
  );
}

export function emptyState(): ForgeState {
  return {
    version: 1,
    agents: {},
    groups: {},
    skills: {},
    routines: {},
    policies: {},
    approvals: {},
    work: {},
    handoffs: {},
    providers: {},
    conversations: {},
    vmMemory: {},
    screens: {},
    events: {},
    audit: [],
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function assertState(raw: unknown): ForgeState {
  if (!raw || typeof raw !== "object") {
    throw new Error("forge_state_invalid: not an object");
  }
  const s = raw as Partial<ForgeState>;
  if (s.version !== 1) {
    throw new Error(`forge_state_invalid: version=${String(s.version)}`);
  }
  for (const k of [
    "agents",
    "groups",
    "skills",
    "routines",
    "policies",
    "approvals",
    "work",
  ] as const) {
    if (!s[k] || typeof s[k] !== "object" || Array.isArray(s[k])) {
      throw new Error(`forge_state_invalid: missing ${k}`);
    }
  }
  // Migrate pre-handoff / pre-contract states in place.
  if (!s.handoffs || typeof s.handoffs !== "object" || Array.isArray(s.handoffs)) {
    s.handoffs = {};
  }
  if (!s.providers || typeof s.providers !== "object" || Array.isArray(s.providers)) {
    s.providers = {};
  }
  if (
    !s.conversations ||
    typeof s.conversations !== "object" ||
    Array.isArray(s.conversations)
  ) {
    s.conversations = {};
  }
  if (!s.vmMemory || typeof s.vmMemory !== "object" || Array.isArray(s.vmMemory)) {
    s.vmMemory = {};
  }
  if (!s.screens || typeof s.screens !== "object" || Array.isArray(s.screens)) {
    s.screens = {};
  }
  if (!s.events || typeof s.events !== "object" || Array.isArray(s.events)) {
    s.events = {};
  }
  for (const a of Object.values(s.agents as Record<string, Record<string, unknown>>)) {
    if (a.contract === undefined) a.contract = null;
    if (a.hidden === undefined) a.hidden = false;
    if (a.providerId === undefined) a.providerId = "";
  }
  for (const r of Object.values(s.routines as Record<string, Record<string, unknown>>)) {
    if (!Array.isArray(r.runs)) r.runs = [];
  }
  for (const w of Object.values(s.work as Record<string, Record<string, unknown>>)) {
    if (w.evidence === undefined) w.evidence = null;
  }
  if (!Array.isArray(s.audit)) {
    throw new Error("forge_state_invalid: audit");
  }
  return s as ForgeState;
}

export type ForgeStore = {
  path: string;
  home: string;
  load: () => ForgeState;
  save: (state: ForgeState) => void;
  update: (fn: (state: ForgeState) => void) => ForgeState;
};

export function createForgeStore(home = defaultForgeHome()): ForgeStore {
  const dir = home;
  const path = join(dir, "forge-state.json");

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true });
  }

  function load(): ForgeState {
    if (!existsSync(path)) return emptyState();
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return assertState(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`forge_state_corrupt: ${msg}`);
    }
  }

  function save(state: ForgeState): void {
    ensureDir();
    const validated = assertState(state);
    if (validated.audit.length > AUDIT_CAP) {
      validated.audit = validated.audit.slice(-AUDIT_CAP);
    }
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n", {
        mode: 0o600,
      });
      renameSync(tmp, path);
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  function update(fn: (state: ForgeState) => void): ForgeState {
    const state = load();
    fn(state);
    save(state);
    return state;
  }

  return { path, home: dir, load, save, update };
}

export function pushAudit(
  state: ForgeState,
  kind: string,
  actorId: string,
  payload: Record<string, unknown> = {},
): void {
  state.audit.push({
    id: newId("aud"),
    at: Date.now(),
    kind,
    actorId,
    payload,
  });
  if (state.audit.length > AUDIT_CAP) {
    state.audit = state.audit.slice(-AUDIT_CAP);
  }
}
