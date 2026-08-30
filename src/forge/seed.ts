/**
 * Safe first setup — GrokBot-shaped roster on one shared VM
 * (Office Ops + Engineering Pod — matches GLM AgentForge demo density).
 */

import type { AgentApi } from "./agents.js";
import type { SkillApi } from "./skills.js";
import type { GuardrailApi } from "./guardrails.js";
import type { GroupApi } from "./groups.js";
import type { ProviderApi } from "./providers.js";
import type { VmApi } from "./vm.js";
import type { RoutineApi } from "./routines.js";
import type { AgentRecord, GroupRecord, SkillRecord } from "./types.js";

export type SeedForge = {
  agents: AgentApi;
  skills: SkillApi;
  guardrails: GuardrailApi;
  groups: GroupApi;
  providers: ProviderApi;
  vm: VmApi;
  routines: RoutineApi;
};

export type SeedResult = {
  chief: AgentRecord;
  specialist: AgentRecord;
  calendar?: AgentRecord;
  skill: SkillRecord;
  group?: GroupRecord;
  engGroup?: GroupRecord;
  created: boolean;
};

function contract(partial: {
  job: string;
  sources: string[];
  output: string;
  evidence: string;
  approvalsRequired: string[];
  stopAndAsk: string;
  noDataRule: string;
}) {
  return partial;
}

/**
 * Idempotent seed: providers + full demo fleet + two groups + VM + skills/routines.
 */
export function seedSafeFirstSetup(forge: SeedForge): SeedResult {
  forge.providers.seedDefaults("human");

  const existing = forge.agents.list();
  if (existing.length > 0) {
    const chief =
      existing.find((a) => a.role === "chief_of_staff") || existing[0]!;
    const specialist =
      existing.find((a) => a.name === "Iris") ||
      existing.find((a) => a.id !== chief.id) ||
      chief;
    const skill = forge.skills.list()[0];
    const groups = forge.groups.list();
    return {
      chief,
      specialist,
      calendar: existing.find((a) => a.name === "Chronos" || a.name === "Kai"),
      skill: skill || {
        id: "",
        name: "",
        description: "",
        instructions: "",
        sharedWith: [],
        createdBy: chief.id,
        createdAt: 0,
        updatedAt: 0,
      },
      group: groups.find((g) => g.name === "Office Ops") || groups[0],
      engGroup: groups.find((g) => g.name === "Engineering Pod"),
      created: false,
    };
  }

  const chief = forge.agents.create({
    name: "Atlas",
    role: "chief_of_staff",
    title: "Chief of Staff",
    providerId: "mock",
    contract: contract({
      job: "Coordinate specialists, summarize results, and own the human interface",
      sources: ["specialist reports", "shared VM workspace"],
      output: "Prioritized summary with open questions and next actions",
      evidence: "Pointers to specialist evidence packages and work ids",
      approvalsRequired: [
        "ownership transfer",
        "external messages",
        "production changes",
        "irreversible actions",
      ],
      stopAndAsk: "When specialists disagree or evidence is incomplete",
      noDataRule:
        "If specialists report no material change, relay that verbatim — do not invent urgency",
    }),
  });

  const iris = forge.agents.create({
    name: "Iris",
    role: "specialist",
    title: "Inbox Manager",
    providerId: "mock",
    contract: contract({
      job: "Monitor the approved watch list / inbox and report material changes only",
      sources: [
        "approved project tracker",
        "linked issue boards",
        "named channel list in shared VM memory.watchList",
      ],
      output:
        "Concise change report with source links and timestamps, or the no-data response",
      evidence: "Source links, timestamps, and list of sources checked",
      approvalsRequired: [
        "external messages",
        "ticket edits",
        "watch-list changes",
      ],
      stopAndAsk:
        "When a source is unavailable, credentials are required, or the change is outside the watch list",
      noDataRule:
        'If no material change is found, return "No material change" and list the sources checked',
    }),
  });

  const chronos = forge.agents.create({
    name: "Chronos",
    role: "specialist",
    title: "Calendar Scheduler",
    providerId: "mock",
    contract: contract({
      job: "Own scheduling proposals against the shared calendar notes on the VM",
      sources: ["shared VM calendar.md", "human preferences in vm memory"],
      output: "Proposed slots with conflicts flagged; never auto-send invites",
      evidence: "Conflict list and source of each constraint",
      approvalsRequired: ["sending invites", "changing others' calendars"],
      stopAndAsk: "When two constraints conflict or timezone is ambiguous",
      noDataRule: 'If no free slot exists, say "No viable slot" and list conflicts',
    }),
  });

  const delta = forge.agents.create({
    name: "Delta",
    role: "specialist",
    title: "To-Do Organizer",
    providerId: "mock",
    contract: contract({
      job: "Break down work, track priorities, surface blockers",
      sources: ["shared VM todos.md", "sprint notes", "human priorities"],
      output: "Short prioritized task list with owners and blockers",
      evidence: "Source of each task and last-update timestamp",
      approvalsRequired: ["deleting others' tasks", "external commits"],
      stopAndAsk: "When priority conflict cannot be resolved from sources",
      noDataRule: 'If the board is empty, return "No open tasks"',
    }),
  });

  const taylor = forge.agents.create({
    name: "Taylor",
    role: "chief_of_staff",
    title: "Tech Lead",
    providerId: "mock",
    contract: contract({
      job: "Coordinate backend, frontend, and QA; negotiate contracts",
      sources: ["Engineering Pod reports", "shared VM /contracts"],
      output: "Routed work + contract diffs + open questions",
      evidence: "Pointers to specialist evidence and contract files",
      approvalsRequired: [
        "merging to main",
        "production deploys",
        "external vendor calls",
      ],
      stopAndAsk: "When specialists disagree on API shape",
      noDataRule:
        "If no engineering change is needed, say so — do not invent scope",
    }),
  });

  const forgeBot = forge.agents.create({
    name: "Forge",
    role: "specialist",
    title: "Backend",
    providerId: "mock",
    contract: contract({
      job: "Own APIs, data models, and server-side logic",
      sources: ["contracts/", "existing APIs", "shared VM schema notes"],
      output: "Endpoint proposals and implementation notes",
      evidence: "Contract paths and test pointers",
      approvalsRequired: ["schema migrations", "production writes"],
      stopAndAsk: "When a breaking change is required",
      noDataRule: 'If no backend work is required, return "No backend change"',
    }),
  });

  const pixel = forge.agents.create({
    name: "Pixel",
    role: "specialist",
    title: "Frontend",
    providerId: "mock",
    contract: contract({
      job: "Build responsive accessible UI against agreed contracts",
      sources: ["contracts/", "design notes", "shared VM UI specs"],
      output: "UI implementation notes and contract feedback",
      evidence: "Screenshots paths and component names",
      approvalsRequired: ["shipping public UI", "analytics hooks"],
      stopAndAsk: "When contract ergonomics block the UI",
      noDataRule: 'If no UI work is required, return "No frontend change"',
    }),
  });

  const qa = forge.agents.create({
    name: "QA Tester",
    role: "specialist",
    title: "QA",
    providerId: "mock",
    contract: contract({
      job: "Verify behavior against contracts and report regressions",
      sources: ["contracts/", "test plans", "shared VM bug notes"],
      output: "Pass/fail report with repro steps",
      evidence: "Steps, expected vs actual, artifact paths",
      approvalsRequired: ["marking release ready"],
      stopAndAsk: "When acceptance criteria are missing",
      noDataRule: 'If nothing to test, return "No test coverage needed"',
    }),
  });

  const morning = forge.skills.create({
    name: "Morning Brief",
    description: "Extract what matters from overnight inbox + notes.",
    instructions: [
      "1. Load shared VM /inbox/triage.md and memory.watchList.",
      "2. Summarize material items into 3 bullets.",
      "3. Surface urgent items first.",
      "4. Write brief to /notes/morning-brief.md.",
      '5. If nothing material: return "No material change".',
    ].join("\n"),
    createdBy: chief.id,
    sharedWith: [iris.id],
  });
  forge.skills.attachToAgent(morning.id, iris.id, chief.id);

  const apiSkill = forge.skills.create({
    name: "API Contract Negotiation",
    description: "Backend + frontend agree on an endpoint shape.",
    instructions: [
      "1. Forge proposes endpoint shape.",
      "2. Pixel reviews for frontend ergonomics.",
      "3. Iterate until both agree.",
      "4. Write contract to /contracts/.",
    ].join("\n"),
    createdBy: taylor.id,
    sharedWith: [forgeBot.id, pixel.id],
  });
  forge.skills.attachToAgent(apiSkill.id, forgeBot.id, taylor.id);
  forge.skills.attachToAgent(apiSkill.id, pixel.id, taylor.id);

  for (const id of [iris.id, chronos.id, delta.id, forgeBot.id, pixel.id, qa.id]) {
    forge.guardrails.setPolicy(
      id,
      {
        actions: {
          message: "ask",
          write: "ask",
          irreversible: "ask",
          network: "ask",
        },
      },
      chief.id,
    );
  }

  const office = forge.groups.create({
    name: "Office Ops",
    memberIds: [chief.id, iris.id, chronos.id, delta.id],
    ownerId: chief.id,
  });

  const eng = forge.groups.create({
    name: "Engineering Pod",
    memberIds: [taylor.id, forgeBot.id, pixel.id, qa.id],
    ownerId: taylor.id,
  });

  forge.routines.create({
    name: "Daily Morning Brief",
    skillId: morning.id,
    agentId: iris.id,
    trigger: { kind: "cron", expression: "0 8 * * *" },
    enabled: true,
  });

  forge.routines.create({
    name: "Weekly Engineering Sync",
    skillId: apiSkill.id,
    agentId: taylor.id,
    trigger: { kind: "cron", expression: "0 10 * * *" },
    enabled: false,
  });

  forge.vm.setMemory("watchList", "[]", chief.id);
  forge.vm.setMemory("user.timezone", "Europe/Istanbul", chief.id);
  forge.vm.setMemory("user.focus_hours", "09:00-11:00", chief.id);
  forge.vm.setMemory(
    "team.current_sprint",
    "Sprint 12 — AgentForge launch",
    taylor.id,
  );
  forge.vm.setMemory("inbox.last_triage", new Date().toISOString(), iris.id);

  forge.vm.writeFile(
    "README.md",
    "# Shared VM workspace\n\nAll bots on this account share this computer.\nScreens are work surfaces, not security boundaries.\n",
    chief.id,
  );
  forge.vm.writeFile(
    "calendar.md",
    "# Calendar notes\n\n- Prefer mornings for deep work\n- No meetings Fridays after 15:00\n",
    chronos.id,
  );
  forge.vm.writeFile(
    "notes/standup.md",
    "# Standup Notes\n\n- Atlas routes inbox each morning\n- Chronos blocks focus time 9-11\n",
    chief.id,
  );
  forge.vm.writeFile(
    "notes/preferences.md",
    "# Preferences\n\n- No meetings before 9am\n- Draft emails, never auto-send\n- Code reviews require human approval\n",
    chief.id,
  );
  forge.vm.writeFile(
    "contracts/api-v1.md",
    "# API Contract v1\n\nGET /api/tasks\nPOST /api/tasks\n\nOwned by Forge (backend) + Pixel (frontend)\n",
    forgeBot.id,
  );
  forge.vm.writeFile(
    "inbox/triage.md",
    "# Inbox Triage\n\n## Urgent\n- [ ] Investor follow-up\n## Today\n- [ ] Newsletter skim\n",
    iris.id,
  );

  forge.vm.pushScreen(
    chief.id,
    "boot",
    "Atlas orchestrator online — waiting for routing requests",
  );
  forge.vm.pushScreen(iris.id, "boot", "Iris inbox manager online");
  forge.vm.pushScreen(chronos.id, "boot", "Chronos scheduler online");
  forge.vm.pushScreen(delta.id, "boot", "Delta to-do organizer online");
  forge.vm.pushScreen(taylor.id, "boot", "Taylor tech lead online");
  forge.vm.pushScreen(forgeBot.id, "boot", "Forge backend specialist online");
  forge.vm.pushScreen(pixel.id, "boot", "Pixel frontend specialist online");
  forge.vm.pushScreen(qa.id, "boot", "QA Tester online");

  return {
    chief: forge.agents.get(chief.id)!,
    specialist: forge.agents.get(iris.id)!,
    calendar: forge.agents.get(chronos.id)!,
    skill: morning,
    group: office,
    engGroup: eng,
    created: true,
  };
}
