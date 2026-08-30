/**
 * Skills — reusable instruction sets shareable between agents.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import type { SkillRecord } from "./types.js";

export type CreateSkillInput = {
  name: string;
  description?: string;
  instructions: string;
  createdBy: string;
  sharedWith?: string[];
  id?: string;
};

export function createSkillApi(store: ForgeStore) {
  function list(): SkillRecord[] {
    return Object.values(store.load().skills).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  function get(id: string): SkillRecord | null {
    return store.load().skills[id] || null;
  }

  function create(input: CreateSkillInput): SkillRecord {
    const name = String(input.name || "").trim();
    const instructions = String(input.instructions || "").trim();
    if (!name) throw new Error("missing_name");
    if (!instructions) throw new Error("missing_instructions");
    let created: SkillRecord | null = null;
    store.update((state) => {
      if (!state.agents[input.createdBy]) {
        throw new Error(`unknown_agent:${input.createdBy}`);
      }
      const sharedWith = [...new Set((input.sharedWith || []).map(String))];
      for (const id of sharedWith) {
        if (!state.agents[id]) throw new Error(`unknown_agent:${id}`);
      }
      const id = input.id || newId("skill");
      if (state.skills[id]) throw new Error(`duplicate_id:${id}`);
      const now = Date.now();
      const row: SkillRecord = {
        id,
        name,
        description: String(input.description || "").trim(),
        instructions,
        sharedWith,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      state.skills[id] = row;
      created = { ...row, sharedWith: [...row.sharedWith] };
      pushAudit(state, "skill.create", input.createdBy, { skillId: id });
    });
    return created!;
  }

  function share(
    skillId: string,
    agentIds: string[],
    actorId: string,
  ): SkillRecord {
    let out: SkillRecord | null = null;
    store.update((state) => {
      const s = state.skills[skillId];
      if (!s) throw new Error("unknown_skill");
      if (actorId !== s.createdBy && state.agents[actorId]?.role !== "chief_of_staff") {
        throw new Error("not_authorized");
      }
      for (const id of agentIds) {
        if (!state.agents[id]) throw new Error(`unknown_agent:${id}`);
      }
      s.sharedWith = [...new Set([...s.sharedWith, ...agentIds.map(String)])];
      s.updatedAt = Date.now();
      out = { ...s, sharedWith: [...s.sharedWith] };
      pushAudit(state, "skill.share", actorId, { skillId, agentIds });
    });
    return out!;
  }

  function canUse(skillId: string, agentId: string): boolean {
    const state = store.load();
    const s = state.skills[skillId];
    if (!s) return false;
    if (!s.sharedWith.length) return true;
    return (
      s.sharedWith.includes(agentId) ||
      s.createdBy === agentId ||
      state.agents[agentId]?.role === "chief_of_staff"
    );
  }

  function attachToAgent(skillId: string, agentId: string, actorId: string): void {
    store.update((state) => {
      const s = state.skills[skillId];
      const a = state.agents[agentId];
      if (!s) throw new Error("unknown_skill");
      if (!a) throw new Error("unknown_agent");
      if (!state.agents[actorId]) throw new Error(`unknown_agent:${actorId}`);
      const actorOk =
        s.createdBy === actorId ||
        state.agents[actorId]?.role === "chief_of_staff";
      if (!actorOk) throw new Error("not_authorized");
      // Target must already be eligible (empty sharedWith = all, or listed).
      const targetOk =
        !s.sharedWith.length ||
        s.sharedWith.includes(agentId) ||
        s.createdBy === agentId;
      if (!targetOk) throw new Error("skill_not_shared");
      if (!a.skillIds.includes(skillId)) a.skillIds.push(skillId);
      a.updatedAt = Date.now();
      pushAudit(state, "skill.attach", actorId, { skillId, agentId });
    });
  }

  return { list, get, create, share, canUse, attachToAgent };
}

export type SkillApi = ReturnType<typeof createSkillApi>;
