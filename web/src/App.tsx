import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Boxes,
  Brain,
  Clock,
  FileText,
  HardDrive,
  HelpCircle,
  LayoutDashboard,
  Loader2,
  Menu,
  MessageSquare,
  Plug,
  Plus,
  Route,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { api } from "./api";
import type {
  Agent,
  ChatMessage,
  Conversation,
  Group,
  Provider,
  ScreenLine,
  View,
  VmFile,
  AgentEvent,
} from "./types";

const NAV: { id: View; label: string; icon: typeof Bot }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "groups", label: "Groups", icon: Users },
  { id: "vm", label: "Shared VM", icon: Server },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "routines", label: "Routines", icon: Clock },
  { id: "providers", label: "Providers", icon: Plug },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "activity", label: "Activity", icon: Activity },
];

const VIEW_META: Record<View, { title: string; subtitle: string }> = {
  dashboard: { title: "Dashboard", subtitle: "Overview of your agent team" },
  agents: { title: "Agents", subtitle: "Persistent AI workers" },
  groups: { title: "Groups", subtitle: "Teams & command chain" },
  vm: { title: "Shared VM", subtitle: "Files, memory & screens" },
  skills: { title: "Skills", subtitle: "Reusable instructions" },
  routines: { title: "Routines", subtitle: "Schedules & triggers" },
  providers: { title: "Providers", subtitle: "LLM connections" },
  approvals: { title: "Approvals", subtitle: "Guardrails queue" },
  activity: { title: "Activity", subtitle: "Live event stream" },
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function avatarFor(a: Agent) {
  const n = a.name.toLowerCase();
  if (a.role === "chief_of_staff") return "🧭";
  if (n.includes("iris")) return "👁";
  if (n.includes("kai") || n.includes("chrono")) return "📅";
  if (n.includes("pixel")) return "🎨";
  if (n.includes("forge")) return "⚙️";
  if (n.includes("taylor")) return "🔧";
  if (n.includes("delta")) return "🛡";
  return "🤖";
}

function statusHue(status: string) {
  if (status === "idle") return "#0f9f6e";
  if (status === "busy" || status === "working") return "#0d9488";
  if (status === "waiting") return "#c27803";
  return "#5c6f66";
}

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [mobileNav, setMobileNav] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [approvals, setApprovals] = useState<unknown[]>([]);
  const [audit, setAudit] = useState<
    Array<{ id: string; at: number; kind: string; actorId: string }>
  >([]);
  const [files, setFiles] = useState<VmFile[]>([]);
  const [memory, setMemory] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [routines, setRoutines] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [fileContent, setFileContent] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [screen, setScreen] = useState<ScreenLine[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [routeNote, setRouteNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [booting, setBooting] = useState(true);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === agentId) || null,
    [agents, agentId],
  );
  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === groupId) || null,
    [groups, groupId],
  );

  const refresh = useCallback(async () => {
    setErr("");
    const [a, g, p, ap, au, sk, rt, vmf, vmm] = await Promise.all([
      api<{ agents: Agent[] }>("GET", "/agents"),
      api<{ groups: Group[] }>("GET", "/groups"),
      api<{ providers: Provider[] }>("GET", "/providers"),
      api<{ approvals: unknown[] }>("GET", "/approvals"),
      api<{
        audit: Array<{ id: string; at: number; kind: string; actorId: string }>;
      }>("GET", "/audit?limit=40"),
      api<{ skills: Array<{ id: string; name: string; description: string }> }>(
        "GET",
        "/skills",
      ),
      api<{ routines: Array<{ id: string; name: string; enabled: boolean }> }>(
        "GET",
        "/routines",
      ),
      api<{ files: VmFile[] }>("GET", "/vm/files"),
      api<{ memory: Record<string, string> }>("GET", "/vm/memory"),
    ]);
    setAgents(a.agents || []);
    setGroups(g.groups || []);
    setProviders(p.providers || []);
    setApprovals(ap.approvals || []);
    setAudit(au.audit || []);
    setSkills(sk.skills || []);
    setRoutines(rt.routines || []);
    setFiles(vmf.files || []);
    setMemory(vmm.memory || {});
  }, []);

  useEffect(() => {
    refresh()
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBooting(false));
  }, [refresh]);

  // Deep link: ?view=agents&agent=<id> (demo / share chat+tool events)
  useEffect(() => {
    if (booting) return;
    const params = new URLSearchParams(window.location.search);
    const agentParam = params.get("agent");
    const groupParam = params.get("group");
    const viewParam = params.get("view") as View | null;
    if (agentParam) {
      void (async () => {
        setAgentId(agentParam);
        setGroupId(null);
        setView("agents");
        try {
          await loadScreen(agentParam);
          const list = await api<{
            conversations: Conversation[];
          }>("GET", `/conversations?agentId=${encodeURIComponent(agentParam)}`).catch(
            () => ({ conversations: [] as Conversation[] }),
          );
          const latest = (list.conversations || [])[0];
          if (latest) setConv(latest);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }
    if (groupParam) {
      void (async () => {
        setGroupId(groupParam);
        setAgentId(null);
        setView("groups");
        try {
          const list = await api<{
            conversations: Conversation[];
          }>("GET", `/conversations?groupId=${encodeURIComponent(groupParam)}`).catch(
            () => ({ conversations: [] as Conversation[] }),
          );
          const latest = (list.conversations || [])[0];
          if (latest) setConv(latest);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }
    if (viewParam && viewParam in VIEW_META) setView(viewParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot after boot
  }, [booting]);

  async function seed() {
    setBusy(true);
    try {
      await api("POST", "/setup/seed");
      await refresh();
      setView("dashboard");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadScreen(id: string) {
    const [s, e] = await Promise.all([
      api<{ lines: ScreenLine[] }>("GET", `/vm/screens/${id}`),
      api<{ events: AgentEvent[] }>("GET", `/agents/${id}/events`).catch(() => ({
        events: [] as AgentEvent[],
      })),
    ]);
    setScreen(s.lines || []);
    setEvents(e.events || []);
  }

  async function openAgent(id: string) {
    if (!id) {
      setAgentId(null);
      setConv(null);
      setScreen([]);
      setEvents([]);
      setRouteNote("");
      return;
    }
    setAgentId(id);
    setGroupId(null);
    setConv(null);
    setRouteNote("");
    setView("agents");
    await loadScreen(id);
  }

  async function openGroup(id: string) {
    if (!id) {
      setGroupId(null);
      setConv(null);
      setScreen([]);
      setEvents([]);
      setRouteNote("");
      return;
    }
    setGroupId(id);
    setAgentId(null);
    setConv(null);
    setRouteNote("");
    setView("groups");
  }

  async function loadVm() {
    const [f, m] = await Promise.all([
      api<{ files: VmFile[] }>("GET", "/vm/files"),
      api<{ memory: Record<string, string> }>("GET", "/vm/memory"),
    ]);
    setFiles(f.files || []);
    setMemory(m.memory || {});
  }

  useEffect(() => {
    if (view === "vm") loadVm().catch((e: Error) => setErr(e.message));
  }, [view]);

  async function send() {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setErr("");
    try {
      if (agentId) {
        const out = await api<{
          conversation: Conversation;
          reply: ChatMessage;
          events?: AgentEvent[];
          toolsUsed?: boolean;
        }>("POST", `/agents/${agentId}/chat`, {
          message: text,
          conversationId: conv?.id,
        });
        setConv(out.conversation);
        setRouteNote(out.toolsUsed ? "tools · OpenHands-style loop" : "direct");
        if (out.events) setEvents(out.events);
        await loadScreen(agentId);
      } else if (groupId) {
        const out = await api<{
          conversation: Conversation;
          reply: ChatMessage;
          events?: AgentEvent[];
          toolsUsed?: boolean;
          route: {
            targetAgentId: string;
            reason: string;
            chiefId: string | null;
          };
        }>("POST", `/groups/${groupId}/chat`, {
          message: text,
          conversationId: conv?.id,
        });
        setConv(out.conversation);
        const target = agents.find((a) => a.id === out.route.targetAgentId);
        setRouteNote(
          `→ ${target?.name || out.route.targetAgentId} · ${out.route.reason}${out.toolsUsed ? " · tools" : ""}`,
        );
        if (out.events) setEvents(out.events);
        await loadScreen(out.route.targetAgentId);
      } else {
        setErr("Select an agent or group first");
        return;
      }
      setPrompt("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createAgent() {
    const name = window.prompt("Agent name");
    if (!name) return;
    const role =
      window.prompt("Role: chief_of_staff | specialist | worker", "specialist") ||
      "specialist";
    const title = window.prompt("Title", name) || name;
    await api("POST", "/agents", { name, role, title, providerId: "mock" });
    await refresh();
  }

  async function createGroup() {
    if (agents.length < 2) {
      setErr("Need at least 2 agents");
      return;
    }
    const name = window.prompt("Group name", "Ops") || "Ops";
    const memberIds = agents.slice(0, Math.min(3, agents.length)).map((a) => a.id);
    await api("POST", "/groups", {
      name,
      memberIds,
      ownerId: memberIds[0],
    });
    await refresh();
    setView("groups");
  }

  async function configureProvider(kind: string) {
    const apiKey =
      window.prompt(`API key for ${kind} (stored in forge-state 0600)`) || "";
    const defaultModel =
      window.prompt("Default model (optional, blank keeps current)") || undefined;
    await api("POST", "/providers", {
      kind,
      apiKey: apiKey || undefined,
      defaultModel,
      actorId: "human",
    });
    await refresh();
  }

  async function openFile(path: string) {
    setSelectedFile(path);
    const r = await api<{ content: string }>(
      "GET",
      `/vm/files/${encodeURIComponent(path)}`,
    );
    setFileContent(r.content || "");
  }

  if (booting) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--bg)] text-[var(--muted)]">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-[var(--primary)]" />{" "}
          Loading dashboard…
        </div>
      </div>
    );
  }

  const meta = VIEW_META[view];
  const empty = agents.length === 0 && groups.length === 0;

  function go(v: View) {
    setView(v);
    setMobileNav(false);
  }

  const sidebar = (
    <aside className="flex h-full w-full flex-col gap-1 border-r border-[var(--border)] bg-[var(--sidebar)]/80 p-3 backdrop-blur-sm">
      <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-br from-[var(--primary)]/15 to-transparent px-2.5 py-3 shadow-soft">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--primary)] to-teal-700 text-[var(--primary-fg)] shadow-card">
          <Boxes className="h-5 w-5" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">AgentForge</span>
          <span className="text-[10px] text-[var(--muted)]">
            Multi-agent orchestration
          </span>
        </div>
      </div>
      <nav className="mt-2 flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          const count =
            item.id === "agents"
              ? agents.length
              : item.id === "groups"
                ? groups.length
                : item.id === "approvals"
                  ? approvals.length
                  : null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className={cx(
                "group relative flex items-center justify-start gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
                active
                  ? "bg-[var(--muted-bg)] text-[var(--foreground)] shadow-soft"
                  : "text-[var(--muted)] hover:translate-x-0.5 hover:bg-[var(--muted-bg)]/50 hover:text-[var(--foreground)]",
              )}
            >
              {active ? (
                <span className="gradient-accent-bar absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full" />
              ) : null}
              <Icon
                className={cx(
                  "h-4 w-4 shrink-0",
                  active ? "text-[var(--primary)]" : "text-[var(--muted)]",
                )}
              />
              <span className="flex-1 text-left">{item.label}</span>
              {count != null && count > 0 ? (
                <span
                  className={cx(
                    "h-5 rounded-md px-1.5 text-[10px] tabular-nums shadow-soft",
                    item.id === "approvals"
                      ? "animate-live bg-amber-500 text-white"
                      : "bg-[var(--card-2)] text-[var(--muted)]",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto rounded-xl border border-[var(--border)] bg-gradient-to-br from-[var(--card)]/80 to-[var(--card)]/40 p-3 text-[11px] leading-relaxed text-[var(--muted)] shadow-soft">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-live rounded-full bg-emerald-500" />
          <p className="font-medium text-[var(--foreground)]">Inspired by GrokBot</p>
        </div>
        <p>
          Persistent agents share one VM. Orchestrator routes work to specialists
          via a command chain.
        </p>
        <div className="mt-2 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg)]/60 px-2 py-1 text-[10px] font-medium text-[var(--foreground)]">
          <HelpCircle className="h-3 w-3" /> AgentForge lane
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] bg-mesh">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)]/70 px-4 shadow-soft backdrop-blur-xl">
        <button
          type="button"
          className="rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--muted-bg)] lg:hidden"
          onClick={() => setMobileNav(true)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
            {meta.title}
          </h1>
          <p className="hidden truncate text-xs text-[var(--muted)] sm:block">
            {meta.subtitle}
          </p>
        </div>
        {empty ? (
          <button
            type="button"
            onClick={() => void seed()}
            disabled={busy}
            className="hidden items-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-fg)] sm:inline-flex"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {busy ? "Seeding…" : "Seed demo team"}
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] p-2 text-[var(--muted)]"
          aria-label="Activity"
        >
          <Activity className="h-4 w-4" />
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="hidden w-64 shrink-0 lg:block">{sidebar}</div>
        {mobileNav ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-[var(--foreground)]/30 backdrop-blur-[2px]"
              onClick={() => setMobileNav(false)}
              aria-label="Close overlay"
            />
            <div className="absolute inset-y-0 left-0 w-64 bg-[var(--sidebar)] shadow-card">
              <div className="flex justify-end p-2">
                <button
                  type="button"
                  onClick={() => setMobileNav(false)}
                  className="rounded-lg p-2 text-[var(--muted)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {sidebar}
            </div>
          </div>
        ) : null}

        <main className="flex min-h-0 flex-1 flex-col overflow-auto p-3 sm:p-4">
          {err ? (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {err}
            </div>
          ) : null}

          {view === "dashboard" && (
            <Dashboard
              agents={agents}
              groups={groups}
              providers={providers}
              approvals={approvals.length}
              skills={skills.length}
              routines={routines.length}
              files={files.length}
              memoryKeys={Object.keys(memory).length}
              audit={audit}
              busy={busy}
              empty={empty}
              onOpen={go}
              onSeed={() => void seed()}
            />
          )}

          {view === "agents" && (
            <AgentsView
              agents={agents}
              selected={selectedAgent}
              conv={conv}
              screen={screen}
              events={events}
              prompt={prompt}
              routeNote={routeNote}
              busy={busy}
              onSelect={(id) => void openAgent(id)}
              onCreate={() => void createAgent()}
              onPrompt={setPrompt}
              onSend={() => void send()}
            />
          )}

          {view === "groups" && (
            <GroupsView
              agents={agents}
              groups={groups}
              selected={selectedGroup}
              conv={conv}
              screen={screen}
              events={events}
              prompt={prompt}
              routeNote={routeNote}
              busy={busy}
              onSelect={(id) => void openGroup(id)}
              onCreate={() => void createGroup()}
              onPrompt={setPrompt}
              onSend={() => void send()}
            />
          )}

          {view === "vm" && (
            <VmView
              files={files}
              memory={memory}
              selectedFile={selectedFile}
              content={fileContent}
              onOpen={(p) => void openFile(p)}
            />
          )}

          {view === "providers" && (
            <ProvidersView
              providers={providers}
              onConfigure={(k) => void configureProvider(k)}
            />
          )}

          {view === "skills" && (
            <SimpleList
              title="Skills"
              empty="No skills yet — seed demo team."
              items={skills.map((s) => ({
                id: s.id,
                title: s.name,
                meta: s.description || "Reusable instruction set",
              }))}
            />
          )}
          {view === "routines" && (
            <SimpleList
              title="Routines"
              empty="No routines yet."
              items={routines.map((r) => ({
                id: r.id,
                title: r.name,
                meta: r.enabled ? "enabled" : "paused",
              }))}
            />
          )}

          {view === "approvals" && <ApprovalsView approvals={approvals} />}
          {view === "activity" && <ActivityView audit={audit} />}
        </main>
      </div>

      <footer className="mt-auto border-t border-[var(--border)] bg-[var(--bg)]/70 backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[11px] text-[var(--muted)]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 font-medium text-[var(--foreground)]">
              <span className="h-1.5 w-1.5 animate-live rounded-full bg-emerald-500" />{" "}
              AgentForge
            </span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">
              GrokBot-style multi-agent orchestration
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{" "}
              {agents.length} agents
            </span>
            <span className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-blue-700">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />{" "}
              {groups.length} groups
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Dashboard({
  agents,
  groups,
  providers,
  approvals,
  skills,
  routines,
  files,
  memoryKeys,
  audit,
  busy,
  empty,
  onOpen,
  onSeed,
}: {
  agents: Agent[];
  groups: Group[];
  providers: Provider[];
  approvals: number;
  skills: number;
  routines: number;
  files: number;
  memoryKeys: number;
  audit: Array<{ id: string; at: number; kind: string; actorId: string }>;
  busy: boolean;
  empty: boolean;
  onOpen: (v: View) => void;
  onSeed: () => void;
}) {
  const waiting = agents.filter(
    (a) => a.status === "busy" || a.status === "waiting",
  ).length;
  const stats: Array<{
    icon: typeof Bot;
    label: string;
    value: number;
    color: string;
    view: View;
  }> = [
    { icon: Bot, label: "Agents", value: agents.length, color: "#0f9f6e", view: "agents" },
    { icon: Users, label: "Groups", value: groups.length, color: "#0d9488", view: "groups" },
    { icon: FileText, label: "VM Files", value: files, color: "#3d6b54", view: "vm" },
    { icon: Brain, label: "Memory", value: memoryKeys, color: "#147a5f", view: "vm" },
    { icon: Sparkles, label: "Skills", value: skills, color: "#2563eb", view: "skills" },
    { icon: Clock, label: "Routines", value: routines, color: "#c27803", view: "routines" },
    {
      icon: Plug,
      label: "Providers",
      value: providers.filter((p) => p.enabled).length,
      color: "#1d4f3c",
      view: "providers",
    },
    {
      icon: ShieldCheck,
      label: "Approvals",
      value: approvals,
      color: "#b45309",
      view: "approvals",
    },
  ];

  return (
    <div className="animate-fade-in-up flex h-full flex-col gap-5">
      <section className="hero-plane relative min-h-[220px] border-b border-[var(--border)] px-1 pb-8 pt-2 sm:min-h-[260px] sm:pb-10">
        <div className="relative z-10 flex max-w-2xl flex-col gap-5">
          <p className="font-[family-name:var(--display)] text-gradient text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            AgentForge
          </p>
          <p className="max-w-xl text-base leading-relaxed text-[var(--muted)] sm:text-lg">
            Persistent agents on one shared VM — command chain, tools, and an
            operator console.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onOpen("agents")}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)] shadow-soft transition-transform hover:translate-y-[-1px]"
            >
              <Bot className="h-4 w-4" /> Open agents
            </button>
            {empty ? (
              <button
                type="button"
                onClick={onSeed}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-white/70 px-4 py-2 text-sm backdrop-blur-sm transition-transform hover:translate-y-[-1px]"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                {busy ? "Seeding…" : "Seed demo team"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onOpen("groups")}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-white/70 px-4 py-2 text-sm backdrop-blur-sm transition-transform hover:translate-y-[-1px]"
              >
                <Users className="h-4 w-4" /> Command chain
              </button>
            )}
            {agents.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <span className="h-1.5 w-1.5 animate-live rounded-full bg-[var(--primary)]" />
                {agents.length} agents live
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => onOpen(s.view)}
              className={cx(
                "card-interactive group flex flex-col items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-left shadow-soft hover:border-[var(--primary)]/30 hover:shadow-card-hover",
                s.label === "Approvals" && s.value > 0
                  ? "border-amber-500/40 ring-1 ring-amber-500/20"
                  : "",
              )}
            >
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg shadow-soft transition-transform group-hover:scale-110"
                style={{ backgroundColor: `${s.color}1a`, color: s.color }}
              >
                <Icon className="h-4 w-4" style={{ color: s.color }} />
              </div>
              <div className="flex flex-col">
                <span className="text-2xl font-bold leading-none tabular-nums">
                  {s.value}
                </span>
                <span className="mt-0.5 text-[10px] text-[var(--muted)]">
                  {s.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {agents.length > 0 ? (
        <div className="card-interactive rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-soft">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary-dim)] shadow-soft">
                <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
              </div>
              <h3 className="text-sm font-semibold">Agent fleet status</h3>
            </div>
            {waiting > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-2 py-0.5 text-[9px] text-amber-500 shadow-soft">
                <span className="h-1.5 w-1.5 animate-live rounded-full bg-amber-500" />
                {waiting} waiting
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {agents.map((a) => {
              const color = statusHue(a.status);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onOpen("agents")}
                  className="group flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card-2)]/40 px-2 py-1.5 text-left transition-all hover:border-[var(--primary)]/30 hover:shadow-soft"
                >
                  <span className="relative text-base">
                    {avatarFor(a)}
                    <span
                      className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[var(--card)]"
                      style={{ backgroundColor: color }}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-medium leading-tight">
                      {a.name}
                    </p>
                    <p className="text-[9px] leading-tight" style={{ color }}>
                      {a.status}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => onOpen("agents")}
            className="mt-2 flex items-center gap-1 text-[10px] text-[var(--primary)] opacity-70 transition-opacity hover:opacity-100"
          >
            Manage all agents <ArrowRight className="h-2.5 w-2.5" />
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {(
          [
            [
              Bot,
              "Agents",
              "Persistent named bots with memory, persona, and a VM screen.",
              "agents",
              "#10b981",
            ],
            [
              Users,
              "Groups & command chain",
              "An orchestrator routes work to specialists who can also talk to each other.",
              "groups",
              "#0d9488",
            ],
            [
              Server,
              "Shared VM",
              "One computer per account — same files, memory, and sessions for every agent.",
              "vm",
              "#3d6b54",
            ],
            [
              ShieldCheck,
              "Guardrails",
              "Irreversible actions queue for approval. Bots draft, you decide.",
              "approvals",
              "#b45309",
            ],
          ] as const
        ).map(([Icon, title, desc, v, color]) => (
          <button
            key={title}
            type="button"
            onClick={() => onOpen(v)}
            className="card-interactive group flex flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-soft hover:border-[var(--primary)]/30 hover:shadow-card-hover"
          >
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl shadow-soft transition-transform group-hover:scale-110"
              style={{ backgroundColor: `${color}1a`, color }}
            >
              <Icon className="h-5 w-5" style={{ color }} />
            </div>
            <h4 className="text-sm font-semibold">{title}</h4>
            <p className="text-xs leading-relaxed text-[var(--muted)]">{desc}</p>
            <span className="mt-auto inline-flex items-center gap-1 text-[11px] font-medium text-[var(--primary)] opacity-0 transition-opacity group-hover:opacity-100">
              Open{" "}
              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="card-interactive flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary-dim)]">
                <Activity className="h-3.5 w-3.5 text-[var(--primary)]" />
              </div>
              <h3 className="text-sm font-semibold">Recent activity</h3>
            </div>
            <button
              type="button"
              onClick={() => onOpen("activity")}
              className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {audit.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--muted)]">
                No activity yet.
              </p>
            ) : (
              audit.slice(0, 8).map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--muted-bg)]/50"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]/60" />
                  <span className="flex-1 truncate">{log.kind}</span>
                  <span className="shrink-0 text-[10px] text-[var(--muted)]">
                    {new Date(log.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="card-interactive flex flex-col justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-card">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10">
              <HardDrive className="h-3.5 w-3.5 text-blue-600" />
            </div>
            <h3 className="text-sm font-semibold">Shared computer law</h3>
          </div>
          <p className="text-xs leading-relaxed text-[var(--muted)]">
            One VM per account. Screens are work surfaces — not security
            boundaries. Every agent sees the same files and memory.
          </p>
          <button
            type="button"
            onClick={() => onOpen("vm")}
            className="mt-2 inline-flex w-fit items-center gap-1 text-[11px] font-medium text-[var(--primary)]"
          >
            Open Shared VM <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function SimpleList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ id: string; title: string; meta: string }>;
}) {
  return (
    <div>
      <h1 className="font-[family-name:var(--display)] text-3xl">{title}</h1>
      <div className="mt-5 flex flex-col gap-2">
        {items.length === 0 ? (
          <div className="text-sm text-[var(--muted)]">{empty}</div>
        ) : (
          items.map((it) => (
            <div
              key={it.id}
              className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3"
            >
              <div className="font-semibold">{it.title}</div>
              <div className="text-sm text-[var(--muted)]">{it.meta}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AgentsView(props: {
  agents: Agent[];
  selected: Agent | null;
  conv: Conversation | null;
  screen: ScreenLine[];
  events: AgentEvent[];
  prompt: string;
  routeNote: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onPrompt: (v: string) => void;
  onSend: () => void;
}) {
  if (props.selected) {
    return (
      <div className="animate-fade-in-up flex min-h-0 flex-1 flex-col gap-3">
        <button
          type="button"
          onClick={() => props.onSelect("")}
          className="w-fit text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          ← Back to agents
        </button>
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_300px]">
          <ChatPane
            title={`Chat · ${props.selected.name}`}
            subtitle={`${props.selected.contract?.job || ""} · tools: list files · write path with text · run \`cmd\``}
            messages={props.conv?.messages || []}
            agents={props.agents}
            prompt={props.prompt}
            routeNote={props.routeNote}
            busy={props.busy}
            placeholder='e.g. list files  |  write notes/x.md with hello'
            onPrompt={props.onPrompt}
            onSend={props.onSend}
          />
          <SideTrace
            title="VM screen"
            lines={props.screen}
            events={props.events}
            contract={props.selected.contract?.noDataRule}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in-up flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
          <p className="text-sm text-[var(--muted)]">
            Persistent named bots with their own memory, persona, and guardrails.
            Each has its own VM screen.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-fg)]"
        >
          <Plus className="h-4 w-4" /> New Agent
        </button>
      </div>
      {props.agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--muted)]">
          No agents yet — seed the demo team from the dashboard.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {props.agents.map((a) => {
            const color = statusHue(a.status);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => props.onSelect(a.id)}
                className="card-interactive group flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-soft hover:border-[var(--primary)]/30 hover:shadow-card-hover"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="relative text-2xl">
                      {avatarFor(a)}
                      <span
                        className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--card)]"
                        style={{ backgroundColor: color }}
                      />
                    </span>
                    <div>
                      <div className="font-semibold leading-tight">{a.name}</div>
                      <div className="text-[11px] text-[var(--muted)]">
                        {a.title}
                      </div>
                    </div>
                  </div>
                  <span
                    className="rounded-full border px-2 py-0.5 text-[10px] capitalize"
                    style={{ color, borderColor: `${color}55` }}
                  >
                    {a.status}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs leading-relaxed text-[var(--muted)]">
                  {a.contract?.job || "No role contract yet."}
                </p>
                <div className="mt-auto flex items-center gap-2 text-[11px] text-[var(--primary)] opacity-0 transition-opacity group-hover:opacity-100">
                  <MessageSquare className="h-3.5 w-3.5" /> Open chat
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GroupsView(props: {
  agents: Agent[];
  groups: Group[];
  selected: Group | null;
  conv: Conversation | null;
  screen: ScreenLine[];
  events: AgentEvent[];
  prompt: string;
  routeNote: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onPrompt: (v: string) => void;
  onSend: () => void;
}) {
  if (props.selected) {
    return (
      <div className="animate-fade-in-up flex min-h-0 flex-1 flex-col gap-3">
        <button
          type="button"
          onClick={() => props.onSelect("")}
          className="w-fit text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          ← Back to groups
        </button>
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_300px]">
          <ChatPane
            title={`Command chain · ${props.selected.name}`}
            subtitle="Chief routes to specialists · tools run on the shared VM"
            messages={props.conv?.messages || []}
            agents={props.agents}
            prompt={props.prompt}
            routeNote={props.routeNote}
            busy={props.busy}
            placeholder='e.g. "Please triage my unread inbox emails" or list files'
            onPrompt={props.onPrompt}
            onSend={props.onSend}
          />
          <SideTrace
            title="Routed screen"
            lines={props.screen}
            events={props.events}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in-up flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Groups</h2>
          <p className="text-sm text-[var(--muted)]">
            Teams with an orchestrator command chain. Specialists share one VM.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-fg)]"
        >
          <Plus className="h-4 w-4" /> New Group
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {props.groups.map((g) => {
          const members = props.agents.filter((a) =>
            g.memberIds.includes(a.id),
          );
          const owner = props.agents.find((a) => a.id === g.ownerId);
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => props.onSelect(g.id)}
              className="card-interactive flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-left shadow-soft hover:border-[var(--primary)]/30 hover:shadow-card-hover"
            >
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-700">
                  <Users className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-semibold">{g.name}</div>
                  <div className="text-[11px] text-[var(--muted)]">
                    Owner: {owner?.name || "—"} · {members.length} members
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {members.map((m) => (
                  <span
                    key={m.id}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--card-2)] px-2 py-0.5 text-[10px]"
                  >
                    {avatarFor(m)} {m.name}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatPane(props: {
  title: string;
  subtitle?: string;
  messages: ChatMessage[];
  agents: Agent[];
  prompt: string;
  routeNote: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onPrompt: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="flex min-h-[560px] flex-col rounded-2xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="border-b border-[var(--line)] px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <MessageSquare className="size-4 text-[var(--accent)]" />
          {props.title}
        </div>
        {props.subtitle ? (
          <div className="mt-1 text-xs text-[var(--muted)]">{props.subtitle}</div>
        ) : null}
      </div>
      <div className="flex-1 space-y-3 overflow-auto p-4">
        {props.messages.length === 0 ? (
          <div className="text-sm text-[var(--muted)]">No messages yet.</div>
        ) : (
          props.messages.map((m) => {
            const who =
              m.role === "user"
                ? "You"
                : props.agents.find((a) => a.id === m.agentId)?.name ||
                  "Assistant";
            return (
              <div
                key={m.id}
                className={cx(
                  "rounded-xl border px-3 py-2",
                  m.role === "assistant"
                    ? "border-emerald-200 bg-emerald-50/80"
                    : "border-[var(--border)] bg-[var(--card-2)]",
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--accent)]">
                  {who}
                  {m.meta?.route ? (
                    <span className="inline-flex items-center gap-1 text-[var(--muted)]">
                      <Route className="size-3" /> {String(m.meta.route)}
                    </span>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap text-sm">{m.content}</div>
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-[var(--line)] p-3">
        {props.routeNote ? (
          <div className="mb-2 text-xs text-[var(--accent)]">{props.routeNote}</div>
        ) : null}
        <textarea
          value={props.prompt}
          disabled={props.disabled || props.busy}
          onChange={(e) => props.onPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) props.onSend();
          }}
          placeholder={props.placeholder || "Message…"}
          className="min-h-24 w-full resize-y rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={props.disabled || props.busy}
            onClick={props.onSend}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-[var(--primary-fg)] disabled:opacity-40"
          >
            {props.busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function SideTrace({
  title,
  lines,
  events = [],
  contract,
}: {
  title: string;
  lines: ScreenLine[];
  events?: AgentEvent[];
  contract?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-soft">
        <h3 className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          Tool events
        </h3>
        <div className="mt-3 max-h-[280px] space-y-2 overflow-auto">
          {events.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">
              No events yet. Try: <code>list files</code> or{" "}
              <code>write notes/x.md with hello</code>
            </p>
          ) : (
            events
              .slice()
              .reverse()
              .map((e) => (
                <div
                  key={e.id}
                  className="rounded-lg border border-[var(--border)] bg-[var(--card-2)] px-2 py-1.5 text-[11px]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        e.ok ? "text-[var(--primary)]" : "text-[var(--danger)]"
                      }
                    >
                      {e.kind}
                    </span>
                    {e.tool ? (
                      <span className="text-[var(--muted)]">{e.tool}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate font-medium">{e.summary}</div>
                  {e.detail ? (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-[var(--muted)]">
                      {e.detail.slice(0, 500)}
                    </pre>
                  ) : null}
                </div>
              ))
          )}
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-soft">
        <h3 className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          {title}
        </h3>
        {contract ? (
          <p className="mt-2 text-xs text-[var(--muted)]">{contract}</p>
        ) : null}
        <pre className="mt-3 max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--muted)]">
          {lines.length
            ? lines
                .map(
                  (l) =>
                    `[${new Date(l.at).toLocaleTimeString()}] ${l.kind}  ${l.text}`,
                )
                .join("\n")
            : "(empty)"}
        </pre>
      </div>
    </div>
  );
}

function VmView({
  files,
  memory,
  selectedFile,
  content,
  onOpen,
}: {
  files: VmFile[];
  memory: Record<string, string>;
  selectedFile: string;
  content: string;
  onOpen: (p: string) => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr_280px]">
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
        <h2 className="mb-2 text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          Files
        </h2>
        <div className="flex flex-col gap-1">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onOpen(f.path)}
              className={cx(
                "rounded-lg px-2 py-1.5 text-left text-sm",
                selectedFile === f.path
                  ? "bg-[var(--panel-2)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--panel-2)]",
              )}
            >
              {f.path}
              <div className="text-[10px]">{f.bytes}b</div>
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <h2 className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          {selectedFile || "Select a file"}
        </h2>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap font-mono text-sm text-[var(--ink)]">
          {content || "(empty)"}
        </pre>
      </div>
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <h2 className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          Shared memory
        </h2>
        <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-[var(--muted)]">
          {JSON.stringify(memory, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function ProvidersView({
  providers,
  onConfigure,
}: {
  providers: Provider[];
  onConfigure: (kind: string) => void;
}) {
  return (
    <div>
      <h1 className="font-[family-name:var(--display)] text-3xl">Providers</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Z.AI, Claude, OpenAI/Codex, OpenRouter, OpenCode — keys stay in forge-state
        (0600).
      </p>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((p) => (
          <div
            key={p.id}
            className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">{p.name}</div>
                <div className="text-xs text-[var(--muted)]">
                  {p.kind} · {p.defaultModel}
                </div>
              </div>
              <span
                className={cx(
                  "rounded-full border px-2 py-0.5 text-[10px] uppercase",
                  p.hasKey
                    ? "border-[var(--ok)]/40 text-[var(--ok)]"
                    : "border-[var(--line)] text-[var(--muted)]",
                )}
              >
                {p.hasKey ? "key set" : "no key"}
              </span>
            </div>
            <div className="mt-3 truncate text-xs text-[var(--muted)]">
              {p.baseUrl || "(mock)"}
            </div>
            <button
              type="button"
              onClick={() => onConfigure(p.kind)}
              className="mt-4 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Configure
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApprovalsView({ approvals }: { approvals: unknown[] }) {
  return (
    <div>
      <h1 className="font-[family-name:var(--display)] text-3xl">Approvals</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Irreversible / ask policies land here. Human or chief resolves.
      </p>
      <div className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4">
        {approvals.length === 0 ? (
          <div className="text-sm text-[var(--muted)]">No approvals queued.</div>
        ) : (
          <pre className="overflow-auto text-xs">
            {JSON.stringify(approvals, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function ActivityView({
  audit,
}: {
  audit: Array<{ id: string; at: number; kind: string; actorId: string }>;
}) {
  return (
    <div>
      <h1 className="font-[family-name:var(--display)] text-3xl">Activity</h1>
      <div className="mt-5 flex flex-col gap-2">
        {audit.map((a) => (
          <div
            key={a.id}
            className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
          >
            <span className="text-[var(--accent)]">{a.kind}</span>
            <span className="mx-2 text-[var(--muted)]">·</span>
            <span className="text-[var(--muted)]">
              {new Date(a.at).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
