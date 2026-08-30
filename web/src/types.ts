export type RoleContract = {
  job: string;
  sources: string[];
  output: string;
  evidence: string;
  approvalsRequired: string[];
  stopAndAsk: string;
  noDataRule: string;
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  title: string;
  status: string;
  providerId: string;
  screenId: string;
  contract: RoleContract | null;
  skillIds: string[];
};

export type Group = {
  id: string;
  name: string;
  memberIds: string[];
  ownerId: string;
  status: string;
  messages: Array<{
    id: string;
    fromAgentId: string;
    toAgentId: string | null;
    body: string;
    createdAt: number;
  }>;
};

export type Provider = {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  hasKey: boolean;
  enabled: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  agentId: string | null;
  content: string;
  at: number;
  meta?: Record<string, unknown>;
};

export type Conversation = {
  id: string;
  groupId: string | null;
  agentId: string | null;
  title: string;
  messages: ChatMessage[];
};

export type ScreenLine = { at: number; kind: string; text: string };
export type VmFile = { path: string; bytes: number; updatedAt: number };

export type AgentEvent = {
  id: string;
  at: number;
  agentId: string;
  conversationId: string | null;
  kind: string;
  tool: string | null;
  summary: string;
  detail: string;
  ok: boolean;
};

export type View =
  | "dashboard"
  | "agents"
  | "groups"
  | "vm"
  | "skills"
  | "routines"
  | "providers"
  | "approvals"
  | "activity";
