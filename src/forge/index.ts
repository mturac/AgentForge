/**
 * AgentForge facade — GrokBot + OpenHands-style tools/event stream.
 */

import { createAgentApi } from "./agents.js";
import { createGroupApi } from "./groups.js";
import { createOrchestratorApi } from "./orchestrator.js";
import { createSkillApi } from "./skills.js";
import { createRoutineApi } from "./routines.js";
import { createGuardrailApi } from "./guardrails.js";
import { createHandoffApi } from "./handoffs.js";
import { createVmApi } from "./vm.js";
import { createProviderApi } from "./providers.js";
import { createChatApi } from "./chat.js";
import { createEventApi } from "./events.js";
import { createToolApi } from "./tools.js";
import {
  createForgeStore,
  defaultForgeHome,
  type ForgeStore,
} from "./store.js";
import { seedSafeFirstSetup } from "./seed.js";

export type Forge = {
  store: ForgeStore;
  agents: ReturnType<typeof createAgentApi>;
  groups: ReturnType<typeof createGroupApi>;
  orchestrator: ReturnType<typeof createOrchestratorApi>;
  skills: ReturnType<typeof createSkillApi>;
  routines: ReturnType<typeof createRoutineApi>;
  guardrails: ReturnType<typeof createGuardrailApi>;
  handoffs: ReturnType<typeof createHandoffApi>;
  vm: ReturnType<typeof createVmApi>;
  providers: ReturnType<typeof createProviderApi>;
  events: ReturnType<typeof createEventApi>;
  tools: ReturnType<typeof createToolApi>;
  chat: ReturnType<typeof createChatApi>;
  seed: () => ReturnType<typeof seedSafeFirstSetup>;
};

export function createForge(
  home = defaultForgeHome(),
  opts: { fetchImpl?: typeof fetch } = {},
): Forge {
  const store = createForgeStore(home);
  const providers = createProviderApi(store, { fetchImpl: opts.fetchImpl });
  const vm = createVmApi(store);
  const events = createEventApi(store);
  const tools = createToolApi(store, vm, events, { fetchImpl: opts.fetchImpl });
  const forge: Forge = {
    store,
    agents: createAgentApi(store),
    groups: createGroupApi(store),
    orchestrator: createOrchestratorApi(store),
    skills: createSkillApi(store),
    routines: createRoutineApi(store),
    guardrails: createGuardrailApi(store),
    handoffs: createHandoffApi(store),
    vm,
    providers,
    events,
    tools,
    chat: createChatApi(store, providers, vm, tools, events),
    seed: () => seedSafeFirstSetup(forge),
  };
  return forge;
}

export {
  createForgeStore,
  defaultForgeHome,
  emptyState,
  newId,
} from "./store.js";
export { nextCronUtc, computeNextRun } from "./routines.js";
export { seedSafeFirstSetup } from "./seed.js";
export { planToolsFromMessage, listToolCatalog } from "./tools.js";
export { tryOpenHandsBridge } from "./openhands.js";
export * from "./types.js";
