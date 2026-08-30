/**
 * Groups — 2..6 bots, messaging, ownership transfer.
 */

import type { ForgeStore } from "./store.js";
import { newId, pushAudit } from "./store.js";
import { GROUP_MAX, GROUP_MIN, type GroupMessage, type GroupRecord } from "./types.js";

export type CreateGroupInput = {
  name: string;
  memberIds: string[];
  ownerId?: string;
  id?: string;
};

function requireGroupName(name: string): string {
  const n = String(name || "").trim();
  if (!n) throw new Error("missing_name");
  return n;
}

export function createGroupApi(store: ForgeStore) {
  function list(): GroupRecord[] {
    return Object.values(store.load().groups).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  function get(id: string): GroupRecord | null {
    const g = store.load().groups[id];
    return g ? { ...g, messages: [...g.messages], memberIds: [...g.memberIds] } : null;
  }

  function create(input: CreateGroupInput): GroupRecord {
    const name = requireGroupName(input.name);
    const members = [...new Set((input.memberIds || []).map(String))];
    if (members.length < GROUP_MIN || members.length > GROUP_MAX) {
      throw new Error(`group_size:${GROUP_MIN}..${GROUP_MAX}`);
    }
    let created: GroupRecord | null = null;
    store.update((state) => {
      for (const id of members) {
        if (!state.agents[id]) throw new Error(`unknown_agent:${id}`);
      }
      const ownerId = input.ownerId || members[0]!;
      if (!members.includes(ownerId)) throw new Error("owner_not_member");
      const id = input.id || newId("group");
      if (state.groups[id]) throw new Error(`duplicate_id:${id}`);
      const now = Date.now();
      const row: GroupRecord = {
        id,
        name,
        memberIds: members,
        ownerId,
        status: "open",
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      state.groups[id] = row;
      created = {
        ...row,
        memberIds: [...row.memberIds],
        messages: [],
      };
      pushAudit(state, "group.create", ownerId, {
        groupId: id,
        members,
      });
    });
    return created!;
  }

  function transferOwnership(
    groupId: string,
    newOwnerId: string,
    actorId: string,
  ): GroupRecord {
    let out: GroupRecord | null = null;
    store.update((state) => {
      const g = state.groups[groupId];
      if (!g) throw new Error("unknown_group");
      if (g.status !== "open") throw new Error("group_closed");
      if (!g.memberIds.includes(newOwnerId)) throw new Error("owner_not_member");
      if (actorId !== g.ownerId && state.agents[actorId]?.role !== "chief_of_staff") {
        throw new Error("not_owner");
      }
      // Guardrail ask/deny is enforced by the HTTP gateway before this mutate.
      g.ownerId = newOwnerId;
      g.updatedAt = Date.now();
      out = {
        ...g,
        memberIds: [...g.memberIds],
        messages: [...g.messages],
      };
      pushAudit(state, "group.ownership", actorId, {
        groupId,
        ownerId: newOwnerId,
      });
    });
    return out!;
  }

  function postMessage(input: {
    groupId: string;
    fromAgentId: string;
    body: string;
    toAgentId?: string | null;
  }): GroupMessage {
    const body = String(input.body || "").trim();
    if (!body) throw new Error("missing_body");
    let msg: GroupMessage | null = null;
    store.update((state) => {
      const g = state.groups[input.groupId];
      if (!g) throw new Error("unknown_group");
      if (g.status !== "open") throw new Error("group_closed");
      if (!g.memberIds.includes(input.fromAgentId)) {
        throw new Error("not_member");
      }
      const to = input.toAgentId ? String(input.toAgentId) : null;
      if (to && !g.memberIds.includes(to)) throw new Error("to_not_member");
      const row: GroupMessage = {
        id: newId("gmsg"),
        groupId: g.id,
        fromAgentId: input.fromAgentId,
        toAgentId: to,
        body,
        createdAt: Date.now(),
      };
      g.messages.push(row);
      if (g.messages.length > 500) g.messages = g.messages.slice(-500);
      g.updatedAt = Date.now();
      msg = { ...row };
      pushAudit(state, "group.message", input.fromAgentId, {
        groupId: g.id,
        messageId: row.id,
      });
    });
    return msg!;
  }

  function close(groupId: string, actorId: string): GroupRecord {
    let out: GroupRecord | null = null;
    store.update((state) => {
      const g = state.groups[groupId];
      if (!g) throw new Error("unknown_group");
      if (
        actorId !== g.ownerId &&
        state.agents[actorId]?.role !== "chief_of_staff"
      ) {
        throw new Error("not_owner");
      }
      g.status = "closed";
      g.updatedAt = Date.now();
      out = {
        ...g,
        memberIds: [...g.memberIds],
        messages: [...g.messages],
      };
      pushAudit(state, "group.close", actorId, { groupId });
    });
    return out!;
  }

  return { list, get, create, transferOwnership, postMessage, close };
}

export type GroupApi = ReturnType<typeof createGroupApi>;
