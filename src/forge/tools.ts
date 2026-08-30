/**
 * OpenHands-inspired tools on the shared VM workspace.
 * Tools: execute_bash, str_replace_editor, think, finish, fetch, browser (stub), delegate.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VmApi } from "./vm.js";
import type { EventApi } from "./events.js";
import type { ForgeStore } from "./store.js";

const execFileAsync = promisify(execFile);

export type ToolName =
  | "execute_bash"
  | "str_replace_editor"
  | "think"
  | "finish"
  | "fetch"
  | "browser"
  | "delegate";

export type ToolCall = {
  tool: ToolName;
  args: Record<string, string>;
};

export type ToolResult = {
  tool: ToolName;
  ok: boolean;
  observation: string;
};

const BASH_BLOCK =
  /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|:(){:|:&};:|curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh|shutdown|reboot|passwd|chmod\s+777\s+\/)/i;

export function listToolCatalog(): Array<{ name: ToolName; summary: string }> {
  return [
    { name: "execute_bash", summary: "Run a shell command in the shared VM workspace cwd" },
    {
      name: "str_replace_editor",
      summary: "view | create | str_replace files on the shared VM",
    },
    { name: "think", summary: "Record an internal reasoning step" },
    { name: "finish", summary: "End the tool loop with a final answer" },
    { name: "fetch", summary: "HTTP GET a public URL (text excerpt)" },
    { name: "browser", summary: "Browser automation (stub — returns guidance)" },
    { name: "delegate", summary: "Hand work to another agent by name/id" },
  ];
}

/** Heuristic planner for mock / no-tool-call LLM replies (OpenHands-lite). */
export function planToolsFromMessage(message: string): ToolCall[] {
  const text = message.trim();
  const lower = text.toLowerCase();
  const calls: ToolCall[] = [];

  // Explicit protocol: TOOL execute_bash {"command":"ls"}
  const explicit = [
    ...text.matchAll(
      /TOOL\s+(execute_bash|str_replace_editor|think|finish|fetch|browser|delegate)\s+(\{[\s\S]*?\})/gi,
    ),
  ];
  if (explicit.length) {
    for (const m of explicit) {
      try {
        const args = JSON.parse(m[2]!) as Record<string, string>;
        calls.push({ tool: m[1]!.toLowerCase() as ToolName, args });
      } catch {
        /* skip bad json */
      }
    }
    if (calls.length) return calls;
  }

  if (/^\s*(ls|list(\s+files)?|dir|show\s+workspace)\b/i.test(text) || /list (the )?(files|workspace)/i.test(lower)) {
    calls.push({ tool: "execute_bash", args: { command: "ls -la" } });
  }

  const cat = text.match(/\b(?:cat|read|show|view)\s+([A-Za-z0-9_./-]+)/i);
  if (cat) {
    calls.push({
      tool: "str_replace_editor",
      args: { command: "view", path: cat[1]! },
    });
  }

  const run = text.match(/\b(?:run|bash|exec|execute)\s+`([^`]+)`/i)
    || text.match(/\b(?:run|bash|exec)\s*:\s*(.+)$/i);
  if (run) {
    calls.push({ tool: "execute_bash", args: { command: run[1]!.trim() } });
  }

  const write = text.match(
    /\b(?:write|create)\s+(?:file\s+)?([A-Za-z0-9_./-]+)\s*(?:with|:)\s*([\s\S]+)/i,
  );
  if (write) {
    calls.push({
      tool: "str_replace_editor",
      args: {
        command: "create",
        path: write[1]!,
        file_text: write[2]!.trim(),
      },
    });
  }

  const repl = text.match(
    /\breplace\s+in\s+([A-Za-z0-9_./-]+)\s+['"](.+?)['"]\s+(?:with|->)\s+['"](.+?)['"]/i,
  );
  if (repl) {
    calls.push({
      tool: "str_replace_editor",
      args: {
        command: "str_replace",
        path: repl[1]!,
        old_str: repl[2]!,
        new_str: repl[3]!,
      },
    });
  }

  const fetchUrl = text.match(/\b(?:fetch|http\s*get)\s+(https?:\/\/\S+)/i);
  if (fetchUrl) {
    calls.push({ tool: "fetch", args: { url: fetchUrl[1]! } });
  }

  if (/\bbrowse\b|\bbrowser\b|\bopen\s+https?:\/\//i.test(text)) {
    const url = text.match(/https?:\/\/\S+/)?.[0] || "";
    calls.push({ tool: "browser", args: { url, action: "navigate" } });
  }

  const del = text.match(/\bdelegat(?:e|ion)\s+(?:to\s+)?([A-Za-z0-9 _-]+)/i);
  if (del) {
    calls.push({
      tool: "delegate",
      args: { agent: del[1]!.trim(), task: text },
    });
  }

  if (calls.length === 0 && /\b(tool|bash|workspace|vm file|edit file)\b/i.test(lower)) {
    calls.push({
      tool: "think",
      args: {
        thought:
          "No concrete tool matched; listing workspace then finishing.",
      },
    });
    calls.push({ tool: "execute_bash", args: { command: "ls -la" } });
  }

  return calls;
}

export function createToolApi(
  store: ForgeStore,
  vm: VmApi,
  events: EventApi,
  opts: { fetchImpl?: typeof fetch } = {},
) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  async function executeBash(command: string): Promise<ToolResult> {
    const cmd = String(command || "").trim();
    if (!cmd) return { tool: "execute_bash", ok: false, observation: "missing_command" };
    if (cmd.length > 2000) {
      return { tool: "execute_bash", ok: false, observation: "command_too_long" };
    }
    if (BASH_BLOCK.test(cmd)) {
      return {
        tool: "execute_bash",
        ok: false,
        observation: "blocked_dangerous_command",
      };
    }
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", cmd], {
        cwd: vm.root,
        timeout: 12_000,
        maxBuffer: 256_000,
        env: { ...process.env, AGENTFORGE_VM: vm.root },
      });
      const out = `${stdout || ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
      return {
        tool: "execute_bash",
        ok: true,
        observation: out.slice(0, 6000) || "(no output)",
      };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const obs = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
      return {
        tool: "execute_bash",
        ok: false,
        observation: (obs || String(e)).slice(0, 6000),
      };
    }
  }

  function editor(
    args: Record<string, string>,
    actorId = "tool",
  ): ToolResult {
    const command = String(args.command || "view").toLowerCase();
    const path = String(args.path || "").trim();
    if (!path && command !== "view") {
      return { tool: "str_replace_editor", ok: false, observation: "missing_path" };
    }
    try {
      if (command === "view") {
        if (!path || path === "." || path === "/") {
          const files = vm.listFiles();
          return {
            tool: "str_replace_editor",
            ok: true,
            observation: files.map((f) => `${f.path} (${f.bytes}b)`).join("\n") || "(empty)",
          };
        }
        const content = vm.readFile(path).content;
        return {
          tool: "str_replace_editor",
          ok: true,
          observation: content.slice(0, 6000),
        };
      }
      if (command === "create") {
        const body = String(args.file_text ?? args.content ?? "");
        vm.writeFile(path, body, actorId);
        return {
          tool: "str_replace_editor",
          ok: true,
          observation: `created ${path} (${body.length} bytes)`,
        };
      }
      if (command === "str_replace") {
        const oldStr = String(args.old_str ?? "");
        const newStr = String(args.new_str ?? "");
        if (!oldStr) {
          return {
            tool: "str_replace_editor",
            ok: false,
            observation: "missing_old_str",
          };
        }
        const cur = vm.readFile(path).content;
        if (!cur.includes(oldStr)) {
          return {
            tool: "str_replace_editor",
            ok: false,
            observation: "old_str_not_found",
          };
        }
        const next = cur.replace(oldStr, newStr);
        vm.writeFile(path, next, actorId);
        return {
          tool: "str_replace_editor",
          ok: true,
          observation: `replaced in ${path}`,
        };
      }
      return {
        tool: "str_replace_editor",
        ok: false,
        observation: `unknown_command:${command}`,
      };
    } catch (e) {
      return {
        tool: "str_replace_editor",
        ok: false,
        observation: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function fetchUrl(url: string): Promise<ToolResult> {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) {
      return { tool: "fetch", ok: false, observation: "invalid_url" };
    }
    try {
      const res = await fetchImpl(u, {
        headers: { accept: "text/plain, text/html, application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return {
        tool: "fetch",
        ok: res.ok,
        observation: `HTTP ${res.status}\n${text.slice(0, 4000)}`,
      };
    } catch (e) {
      return {
        tool: "fetch",
        ok: false,
        observation: e instanceof Error ? e.message : String(e),
      };
    }
  }

  function browserStub(args: Record<string, string>): ToolResult {
    const url = args.url || "";
    return {
      tool: "browser",
      ok: true,
      observation: [
        "browser_stub",
        url ? `requested:${url}` : "no_url",
        "Full Playwright browser-use ships via OpenHands Agent Server bridge (OPENHANDS_URL).",
        "Native stub recorded navigate intent only.",
      ].join("\n"),
    };
  }

  function delegate(args: Record<string, string>): ToolResult {
    const needle = String(args.agent || "").trim().toLowerCase();
    const task = String(args.task || "").trim();
    const agents = Object.values(store.load().agents);
    const target =
      agents.find((a) => a.id === args.agent) ||
      agents.find((a) => a.name.toLowerCase() === needle) ||
      agents.find((a) => a.name.toLowerCase().includes(needle));
    if (!target) {
      return {
        tool: "delegate",
        ok: false,
        observation: `unknown_agent:${args.agent || ""}`,
      };
    }
    return {
      tool: "delegate",
      ok: true,
      observation: JSON.stringify({
        targetAgentId: target.id,
        targetName: target.name,
        task: task.slice(0, 500),
      }),
    };
  }

  async function runOne(
    call: ToolCall,
    actorId = "tool",
  ): Promise<ToolResult> {
    switch (call.tool) {
      case "execute_bash":
        return executeBash(call.args.command || "");
      case "str_replace_editor":
        return editor(call.args, actorId);
      case "think":
        return {
          tool: "think",
          ok: true,
          observation: String(call.args.thought || call.args.content || ""),
        };
      case "finish":
        return {
          tool: "finish",
          ok: true,
          observation: String(call.args.message || call.args.content || "done"),
        };
      case "fetch":
        return fetchUrl(call.args.url || "");
      case "browser":
        return browserStub(call.args);
      case "delegate":
        return delegate(call.args);
      default:
        return {
          tool: call.tool,
          ok: false,
          observation: `unknown_tool:${call.tool}`,
        };
    }
  }

  async function runLoop(input: {
    agentId: string;
    conversationId?: string | null;
    message: string;
    calls?: ToolCall[];
    maxSteps?: number;
  }): Promise<{ results: ToolResult[]; events: ReturnType<EventApi["list"]>; finalText: string }> {
    const planned = input.calls?.length
      ? input.calls
      : planToolsFromMessage(input.message);
    const maxSteps = Math.min(input.maxSteps ?? 8, 12);
    const results: ToolResult[] = [];
    let finalText = "";

    events.append({
      agentId: input.agentId,
      conversationId: input.conversationId,
      kind: "message",
      summary: "user",
      detail: input.message.slice(0, 2000),
    });

    if (!planned.length) {
      return { results, events: events.list(input.agentId), finalText: "" };
    }

    for (const call of planned.slice(0, maxSteps)) {
      events.append({
        agentId: input.agentId,
        conversationId: input.conversationId,
        kind: call.tool === "think" ? "thought" : call.tool === "delegate" ? "delegate" : "action",
        tool: call.tool,
        summary: `${call.tool} ${JSON.stringify(call.args).slice(0, 120)}`,
        detail: JSON.stringify(call.args).slice(0, 2000),
      });

      const result = await runOne(call, input.agentId);
      results.push(result);

      events.append({
        agentId: input.agentId,
        conversationId: input.conversationId,
        kind: call.tool === "finish" ? "finish" : "observation",
        tool: call.tool,
        summary: result.ok ? "ok" : "error",
        detail: result.observation,
        ok: result.ok,
      });

      if (call.tool === "finish") {
        finalText = result.observation;
        break;
      }
    }

    if (!finalText && results.length) {
      finalText = results
        .map((r) => `### ${r.tool} (${r.ok ? "ok" : "err"})\n${r.observation}`)
        .join("\n\n");
      events.append({
        agentId: input.agentId,
        conversationId: input.conversationId,
        kind: "finish",
        summary: "tool loop complete",
        detail: finalText.slice(0, 2000),
        ok: results.every((r) => r.ok),
      });
    }

    return {
      results,
      events: events.list(input.agentId, 80),
      finalText,
    };
  }

  return {
    catalog: listToolCatalog,
    plan: planToolsFromMessage,
    runOne,
    runLoop,
  };
}

export type ToolApi = ReturnType<typeof createToolApi>;
