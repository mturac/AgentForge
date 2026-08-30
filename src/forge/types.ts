/**
 * AgentForge — shared types.
 * Grok Bot–shaped multi-agent orchestration (account-scoped computer model).
 */

export type AgentStatus = "idle" | "busy" | "offline" | "error";

export type AgentRole =
  | "chief_of_staff"
  | "specialist"
  | "worker"
  | "observer";

/**
 * Working contract for a Bot (guide: six questions + no-data rule).
 * Roles organize work — they do not isolate secrets on the shared computer.
 */
export type RoleContract = {
  /** What job does this Bot own? */
  job: string;
  /** Which sources may it use? */
  sources: string[];
  /** What output should it produce? */
  output: string;
  /** What evidence must accompany the result? */
  evidence: string;
  /** Which actions require approval? */
  approvalsRequired: string[];
  /** When should it stop and ask a human? */
  stopAndAsk: string;
  /** If nothing material: exact response required (no invention). */
  noDataRule: string;
};

export type AgentRecord = {
  id: string;
  name: string;
  role: AgentRole;
  title: string;
  /** Model slug for hop/bindings (optional until wired). */
  modelId: string;
  hopBaseUrl: string;
  /** Work surface id — parallel UI, not a security boundary. */
  screenId: string;
  status: AgentStatus;
  /** Durable memory blob refs / notes (no secrets). */
  memory: Record<string, unknown>;
  skillIds: string[];
  /** Preferred multi-provider id (zai/claude/openai/openrouter/opencode/mock). */
  providerId: string;
  /** Formal role contract; null until authored. */
  contract: RoleContract | null;
  /** Soft-hide: routines owned by a hidden bot still run unless paused. */
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
};

export type GroupStatus = "open" | "closed";

export type GroupMessage = {
  id: string;
  groupId: string;
  fromAgentId: string;
  toAgentId: string | null; // null = broadcast
  body: string;
  createdAt: number;
};

export type GroupRecord = {
  id: string;
  name: string;
  memberIds: string[];
  /** Current work owner (must be a member). */
  ownerId: string;
  status: GroupStatus;
  messages: GroupMessage[];
  createdAt: number;
  updatedAt: number;
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  /** Instruction body taught by demonstration / authoring. */
  instructions: string;
  /** Agent ids allowed to use; empty = all. */
  sharedWith: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type RoutineTrigger =
  | { kind: "cron"; expression: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "event"; event: string };

export type RoutineRunStatus = "ok" | "failed" | "skipped";

/** One execution record; routines keep the 20 most recent. */
export type RoutineRun = {
  id: string;
  startedAt: number;
  endedAt: number;
  status: RoutineRunStatus;
  note: string;
};

export type RoutineRecord = {
  id: string;
  name: string;
  skillId: string;
  agentId: string;
  trigger: RoutineTrigger;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** Last ≤20 runs (newest last). */
  runs: RoutineRun[];
  createdAt: number;
  updatedAt: number;
};

export type PermissionAction =
  | "read"
  | "write"
  | "exec"
  | "network"
  | "message"
  | "ownership"
  | "irreversible";

export type PermissionDecision = "allow" | "deny" | "ask";

export type GuardrailPolicy = {
  agentId: string;
  /** Default for unspecified actions. */
  default: PermissionDecision;
  actions: Partial<Record<PermissionAction, PermissionDecision>>;
  updatedAt: number;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRequest = {
  id: string;
  agentId: string;
  action: PermissionAction;
  summary: string;
  detail: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
};

export type WorkItemStatus =
  | "queued"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "done"
  | "failed";

export type WorkEvidenceSource = {
  label: string;
  url?: string;
  at: number;
};

/** Evidence package required on completion (guide: links, files, uncertainties). */
export type WorkEvidence = {
  summary: string;
  sources: WorkEvidenceSource[];
  filesChanged: string[];
  uncertainties: string[];
  recordedAt: number;
  recordedBy: string;
};

export type WorkItem = {
  id: string;
  title: string;
  body: string;
  requestedBy: string;
  assignedTo: string | null;
  status: WorkItemStatus;
  groupId: string | null;
  skillId: string | null;
  evidence: WorkEvidence | null;
  createdAt: number;
  updatedAt: number;
};

export type HandoffStatus = "open" | "accepted" | "completed" | "rejected";

/** Explicit bot-to-bot handoff with visible ownership. */
export type HandoffRecord = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  workId: string | null;
  summary: string;
  result: string | null;
  status: HandoffStatus;
  createdAt: number;
  updatedAt: number;
};

export type AuditEvent = {
  id: string;
  at: number;
  kind: string;
  actorId: string;
  payload: Record<string, unknown>;
};

/** Shared-computer memory (account-scoped — not per-bot isolation). */
export type VmMemory = Record<string, string>;

export type VmFileMeta = {
  path: string;
  bytes: number;
  updatedAt: number;
};

export type ProviderKind =
  | "zai"
  | "claude"
  | "openai"
  | "openrouter"
  | "opencode"
  | "mock";

export type ProviderRecord = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  defaultModel: string;
  /** Raw key stored only in forge-state (mode 0600). Never log. */
  apiKey: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  agentId: string | null;
  content: string;
  at: number;
  meta?: Record<string, unknown>;
};

export type ConversationRecord = {
  id: string;
  groupId: string | null;
  agentId: string | null;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export type ScreenLine = {
  at: number;
  kind: string;
  text: string;
};

/** OpenHands-style typed event (action / observation / message / finish). */
export type AgentEventKind =
  | "message"
  | "action"
  | "observation"
  | "thought"
  | "finish"
  | "error"
  | "delegate";

export type AgentEvent = {
  id: string;
  at: number;
  agentId: string;
  conversationId: string | null;
  kind: AgentEventKind;
  tool: string | null;
  summary: string;
  detail: string;
  ok: boolean;
};

export type ForgeState = {
  version: 1;
  agents: Record<string, AgentRecord>;
  groups: Record<string, GroupRecord>;
  skills: Record<string, SkillRecord>;
  routines: Record<string, RoutineRecord>;
  policies: Record<string, GuardrailPolicy>;
  approvals: Record<string, ApprovalRequest>;
  work: Record<string, WorkItem>;
  handoffs: Record<string, HandoffRecord>;
  providers: Record<string, ProviderRecord>;
  conversations: Record<string, ConversationRecord>;
  /** Shared VM key-value memory (all bots). */
  vmMemory: VmMemory;
  /** Per-agent screen traces (work surfaces, not isolation). */
  screens: Record<string, ScreenLine[]>;
  /** OpenHands-style event streams keyed by agentId. */
  events: Record<string, AgentEvent[]>;
  audit: AuditEvent[];
};

export const GROUP_MIN = 2;
export const GROUP_MAX = 6;
export const AUDIT_CAP = 2000;
export const ROUTINE_RUN_CAP = 20;
export const AGENT_ROSTER_SOFT_CAP = 50;
export const SCREEN_LINE_CAP = 200;
export const CONVERSATION_MSG_CAP = 200;
export const EVENT_CAP = 300;
