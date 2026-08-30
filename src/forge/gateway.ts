/**
 * Localhost AgentForge HTTP gateway (default :18800).
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createForge, type Forge } from "./index.js";
import { consoleHtml } from "./console.js";

export const DEFAULT_FORGE_PORT = 18800;

const WEB_DIST = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../web/dist",
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function tryServeWeb(pathOnly: string, res: ServerResponse): boolean {
  if (!existsSync(WEB_DIST)) return false;
  let rel = pathOnly === "/" ? "/index.html" : pathOnly;
  if (rel.includes("..")) return false;
  let full = join(WEB_DIST, rel);
  if (!existsSync(full) || !statSync(full).isFile()) {
    // SPA fallback
    full = join(WEB_DIST, "index.html");
    if (!existsSync(full)) return false;
  }
  const body = readFileSync(full);
  const type = MIME[extname(full)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
  });
  res.end(body);
  return true;
}

export type ForgeGatewayOptions = {
  port?: number;
  host?: string;
  home?: string;
  forge?: Forge;
  log?: (...args: unknown[]) => void;
};

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 512_000) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createForgeGateway(opts: ForgeGatewayOptions = {}) {
  const configuredPort = opts.port ?? DEFAULT_FORGE_PORT;
  const host = opts.host ?? "127.0.0.1";
  const log =
    opts.log ?? ((...a: unknown[]) => console.error("[forge.gw]", ...a));
  const forge = opts.forge ?? createForge(opts.home);
  let listeningPort = configuredPort;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const urlRaw = req.url || "/";
      const pathOnly = urlRaw.split("?")[0] || "/";
      const u = new URL(urlRaw, "http://127.0.0.1");

      if (method === "GET" && (pathOnly === "/" || pathOnly === "/console")) {
        if (tryServeWeb("/", res)) return;
        const html = Buffer.from(consoleHtml());
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": html.length,
        });
        res.end(html);
        return;
      }
      if (
        method === "GET" &&
        (pathOnly.startsWith("/assets/") ||
          pathOnly === "/favicon.svg" ||
          pathOnly === "/favicon.ico")
      ) {
        if (tryServeWeb(pathOnly, res)) return;
      }

      if (method === "GET" && (pathOnly === "/health" || pathOnly === "/healthz")) {
        return json(res, 200, {
          ok: true,
          service: "agentforge",
          port: listeningPort,
          agents: forge.agents.list().length,
        });
      }

      // Agents
      if (method === "GET" && pathOnly === "/agents") {
        return json(res, 200, { ok: true, agents: forge.agents.list() });
      }
      if (
        method === "POST" &&
        pathOnly.startsWith("/agents/") &&
        pathOnly.endsWith("/chat")
      ) {
        const id = pathOnly.split("/")[2];
        const body = await readJson(req);
        const out = await forge.chat.agentChat({
          agentId: String(id),
          message: String(body.message || ""),
          conversationId: body.conversationId
            ? String(body.conversationId)
            : undefined,
          useTools:
            body.useTools === undefined ? undefined : Boolean(body.useTools),
          openHands: body.openHands ? true : undefined,
        });
        return json(res, 200, { ok: true, ...out });
      }
      if (
        method === "GET" &&
        pathOnly.startsWith("/agents/") &&
        pathOnly.endsWith("/events")
      ) {
        const id = pathOnly.split("/")[2];
        return json(res, 200, {
          ok: true,
          events: forge.events.list(String(id), 100),
        });
      }
      if (
        method === "POST" &&
        pathOnly.startsWith("/agents/") &&
        pathOnly.endsWith("/contract")
      ) {
        const id = pathOnly.split("/")[2];
        const body = await readJson(req);
        const agent = forge.agents.setContract(
          String(id),
          body.contract as never,
          String(body.actorId || ""),
        );
        return json(res, 200, { ok: true, agent });
      }
      if (method === "GET" && pathOnly.startsWith("/agents/")) {
        const id = pathOnly.slice("/agents/".length);
        if (id.includes("/")) {
          return json(res, 404, { ok: false, error: "not_found" });
        }
        const a = forge.agents.get(id);
        if (!a) return json(res, 404, { ok: false, error: "unknown_agent" });
        return json(res, 200, { ok: true, agent: a });
      }
      if (method === "POST" && pathOnly === "/agents") {
        const body = await readJson(req);
        const agent = forge.agents.create({
          name: String(body.name || ""),
          role: body.role as never,
          title: body.title != null ? String(body.title) : undefined,
          modelId: body.modelId != null ? String(body.modelId) : undefined,
          hopBaseUrl:
            body.hopBaseUrl != null ? String(body.hopBaseUrl) : undefined,
          providerId:
            body.providerId != null ? String(body.providerId) : undefined,
          contract: (body.contract as never) ?? undefined,
        });
        return json(res, 200, { ok: true, agent });
      }

      if (method === "POST" && pathOnly === "/setup/seed") {
        const result = forge.seed();
        return json(res, 200, { ok: true, ...result });
      }

      if (method === "GET" && pathOnly === "/audit") {
        const limit = Math.min(
          500,
          Math.max(1, Number(u.searchParams.get("limit") || 100)),
        );
        const audit = forge.store.load().audit.slice(-limit).reverse();
        return json(res, 200, { ok: true, audit });
      }

      // Providers
      if (method === "GET" && pathOnly === "/tools") {
        return json(res, 200, {
          ok: true,
          tools: forge.tools.catalog(),
          openHandsUrl: process.env.OPENHANDS_URL || null,
        });
      }
      if (method === "GET" && pathOnly === "/conversations") {
        const agentId = u.searchParams.get("agentId") || undefined;
        const groupId = u.searchParams.get("groupId") || undefined;
        return json(res, 200, {
          ok: true,
          conversations: forge.chat.listConversations({ agentId, groupId }),
        });
      }
      if (method === "GET" && pathOnly === "/providers") {
        return json(res, 200, { ok: true, providers: forge.providers.list() });
      }
      if (method === "POST" && pathOnly === "/providers") {
        const body = await readJson(req);
        const provider = forge.providers.upsert({
          id: body.id != null ? String(body.id) : undefined,
          kind: body.kind as never,
          name: body.name != null ? String(body.name) : undefined,
          baseUrl: body.baseUrl != null ? String(body.baseUrl) : undefined,
          defaultModel:
            body.defaultModel != null ? String(body.defaultModel) : undefined,
          apiKey: body.apiKey != null ? String(body.apiKey) : undefined,
          enabled: body.enabled !== false,
          actorId: String(body.actorId || "human"),
        });
        return json(res, 200, { ok: true, provider });
      }

      // Shared VM
      if (method === "GET" && pathOnly === "/vm/files") {
        return json(res, 200, { ok: true, files: forge.vm.listFiles() });
      }
      if (method === "GET" && pathOnly.startsWith("/vm/files/")) {
        const p = decodeURIComponent(pathOnly.slice("/vm/files/".length));
        return json(res, 200, { ok: true, ...forge.vm.readFile(p) });
      }
      if (method === "POST" && pathOnly === "/vm/files") {
        const body = await readJson(req);
        const file = forge.vm.writeFile(
          String(body.path || ""),
          String(body.content ?? ""),
          String(body.actorId || "human"),
        );
        return json(res, 200, { ok: true, file });
      }
      if (method === "GET" && pathOnly === "/vm/memory") {
        return json(res, 200, { ok: true, memory: forge.vm.getMemory() });
      }
      if (method === "POST" && pathOnly === "/vm/memory") {
        const body = await readJson(req);
        forge.vm.setMemory(
          String(body.key || ""),
          String(body.value ?? ""),
          String(body.actorId || "human"),
        );
        return json(res, 200, { ok: true, memory: forge.vm.getMemory() });
      }
      if (method === "GET" && pathOnly.startsWith("/vm/screens/")) {
        const id = pathOnly.slice("/vm/screens/".length);
        return json(res, 200, { ok: true, lines: forge.vm.getScreen(id) });
      }

      // Groups
      if (method === "GET" && pathOnly === "/groups") {
        return json(res, 200, { ok: true, groups: forge.groups.list() });
      }
      if (method === "POST" && pathOnly === "/groups") {
        const body = await readJson(req);
        const group = forge.groups.create({
          name: String(body.name || ""),
          memberIds: Array.isArray(body.memberIds)
            ? body.memberIds.map(String)
            : [],
          ownerId: body.ownerId != null ? String(body.ownerId) : undefined,
        });
        return json(res, 200, { ok: true, group });
      }
      if (
        method === "POST" &&
        pathOnly.startsWith("/groups/") &&
        pathOnly.endsWith("/chat")
      ) {
        const groupId = pathOnly.split("/")[2];
        const body = await readJson(req);
        const out = await forge.chat.groupChat({
          groupId: String(groupId),
          message: String(body.message || ""),
          fromAgentId: body.fromAgentId
            ? String(body.fromAgentId)
            : undefined,
          conversationId: body.conversationId
            ? String(body.conversationId)
            : undefined,
          assignTo: body.assignTo ? String(body.assignTo) : undefined,
          useTools:
            body.useTools === undefined ? undefined : Boolean(body.useTools),
        });
        return json(res, 200, { ok: true, ...out });
      }
      if (method === "POST" && pathOnly.endsWith("/message")) {
        const groupId = pathOnly.split("/")[2];
        const body = await readJson(req);
        const message = forge.groups.postMessage({
          groupId: String(groupId),
          fromAgentId: String(body.fromAgentId || ""),
          body: String(body.body || ""),
          toAgentId: body.toAgentId != null ? String(body.toAgentId) : null,
        });
        return json(res, 200, { ok: true, message });
      }
      if (method === "POST" && pathOnly.endsWith("/ownership")) {
        const groupId = pathOnly.split("/")[2];
        const body = await readJson(req);
        const actorId = String(body.actorId || "");
        const newOwnerId = String(body.ownerId || "");
        const approvalId =
          body.approvalId != null ? String(body.approvalId) : "";

        if (approvalId) {
          const approval = forge.guardrails.getApproval(approvalId);
          if (!approval) throw new Error("unknown_approval");
          if (approval.status !== "approved") {
            throw new Error("approval_not_approved");
          }
          if (
            approval.agentId !== actorId ||
            approval.action !== "ownership" ||
            String(approval.detail.groupId || "") !== String(groupId) ||
            String(approval.detail.newOwnerId || "") !== newOwnerId
          ) {
            throw new Error("approval_mismatch");
          }
        } else {
          const decision = forge.guardrails.check(
            actorId,
            "ownership",
            `Transfer ownership of group ${groupId} to ${newOwnerId}`,
            { groupId, newOwnerId },
          );
          if (decision.decision === "deny") {
            return json(res, 403, {
              ok: false,
              error: "denied",
              ...decision,
            });
          }
          if (decision.decision === "pending") {
            return json(res, 202, {
              ok: true,
              pending: true,
              ...decision,
            });
          }
        }

        const group = forge.groups.transferOwnership(
          String(groupId),
          newOwnerId,
          actorId,
        );
        return json(res, 200, { ok: true, group });
      }

      // Work / orchestrator
      if (method === "GET" && pathOnly === "/work") {
        return json(res, 200, { ok: true, work: forge.orchestrator.listWork() });
      }
      if (method === "POST" && pathOnly === "/work") {
        const body = await readJson(req);
        const work = forge.orchestrator.submit({
          title: String(body.title || ""),
          body: String(body.body || ""),
          requestedBy: String(body.requestedBy || ""),
          assignTo: body.assignTo != null ? String(body.assignTo) : undefined,
          groupId: body.groupId != null ? String(body.groupId) : undefined,
          skillId: body.skillId != null ? String(body.skillId) : undefined,
        });
        return json(res, 200, { ok: true, work });
      }
      if (method === "POST" && pathOnly.startsWith("/work/") && pathOnly.endsWith("/status")) {
        const workId = pathOnly.split("/")[2];
        const body = await readJson(req);
        const work = forge.orchestrator.setStatus(
          String(workId),
          body.status as never,
          String(body.actorId || ""),
        );
        return json(res, 200, { ok: true, work });
      }
      if (
        method === "POST" &&
        pathOnly.startsWith("/work/") &&
        pathOnly.endsWith("/evidence")
      ) {
        const workId = pathOnly.split("/")[2];
        const body = await readJson(req);
        const work = forge.orchestrator.recordEvidence(
          String(workId),
          String(body.actorId || ""),
          {
            summary: String(body.summary || ""),
            sources: Array.isArray(body.sources)
              ? (body.sources as never)
              : [],
            filesChanged: Array.isArray(body.filesChanged)
              ? body.filesChanged.map(String)
              : [],
            uncertainties: Array.isArray(body.uncertainties)
              ? body.uncertainties.map(String)
              : [],
          },
        );
        return json(res, 200, { ok: true, work });
      }

      // Handoffs
      if (method === "GET" && pathOnly === "/handoffs") {
        const status = u.searchParams.get("status") as never;
        return json(res, 200, {
          ok: true,
          handoffs: forge.handoffs.list(status || undefined),
        });
      }
      if (method === "POST" && pathOnly === "/handoffs") {
        const body = await readJson(req);
        const handoff = forge.handoffs.create({
          fromAgentId: String(body.fromAgentId || ""),
          toAgentId: String(body.toAgentId || ""),
          summary: String(body.summary || ""),
          workId: body.workId != null ? String(body.workId) : null,
        });
        return json(res, 200, { ok: true, handoff });
      }
      if (
        method === "POST" &&
        pathOnly.startsWith("/handoffs/") &&
        pathOnly.endsWith("/resolve")
      ) {
        const id = pathOnly.split("/")[2];
        const body = await readJson(req);
        const handoff = forge.handoffs.resolve(
          String(id),
          body.status as "accepted" | "completed" | "rejected",
          String(body.actorId || ""),
          body.result != null ? String(body.result) : undefined,
        );
        return json(res, 200, { ok: true, handoff });
      }

      // Skills
      if (method === "GET" && pathOnly === "/skills") {
        return json(res, 200, { ok: true, skills: forge.skills.list() });
      }
      if (method === "POST" && pathOnly === "/skills") {
        const body = await readJson(req);
        const skill = forge.skills.create({
          name: String(body.name || ""),
          description:
            body.description != null ? String(body.description) : undefined,
          instructions: String(body.instructions || ""),
          createdBy: String(body.createdBy || ""),
          sharedWith: Array.isArray(body.sharedWith)
            ? body.sharedWith.map(String)
            : undefined,
        });
        return json(res, 200, { ok: true, skill });
      }

      // Routines
      if (method === "GET" && pathOnly === "/routines") {
        return json(res, 200, { ok: true, routines: forge.routines.list() });
      }
      if (method === "GET" && pathOnly === "/routines/due") {
        return json(res, 200, { ok: true, routines: forge.routines.due() });
      }
      if (
        method === "POST" &&
        pathOnly.startsWith("/routines/") &&
        (pathOnly.endsWith("/claim") || pathOnly.endsWith("/mark-ran"))
      ) {
        const id = pathOnly.split("/")[2];
        let body: Record<string, unknown> = {};
        try {
          body = await readJson(req);
        } catch {
          body = {};
        }
        const routine = forge.routines.markRan(String(id), Date.now(), {
          status: (body.status as never) || "ok",
          note: body.note != null ? String(body.note) : undefined,
        });
        return json(res, 200, { ok: true, routine });
      }
      if (
        method === "GET" &&
        pathOnly.startsWith("/routines/") &&
        pathOnly.endsWith("/runs")
      ) {
        const id = pathOnly.split("/")[2];
        return json(res, 200, {
          ok: true,
          runs: forge.routines.listRuns(String(id)),
        });
      }
      if (method === "POST" && pathOnly === "/routines") {
        const body = await readJson(req);
        const routine = forge.routines.create({
          name: String(body.name || ""),
          skillId: String(body.skillId || ""),
          agentId: String(body.agentId || ""),
          trigger: body.trigger as never,
          enabled: body.enabled !== false,
        });
        return json(res, 200, { ok: true, routine });
      }

      // Guardrails
      if (method === "GET" && pathOnly.startsWith("/policies/")) {
        const agentId = pathOnly.slice("/policies/".length);
        return json(res, 200, {
          ok: true,
          policy: forge.guardrails.getPolicy(agentId),
        });
      }
      if (method === "POST" && pathOnly === "/approvals/check") {
        const body = await readJson(req);
        const result = forge.guardrails.check(
          String(body.agentId || ""),
          body.action as never,
          String(body.summary || ""),
          (body.detail as Record<string, unknown>) || {},
        );
        return json(res, 200, { ok: true, ...result });
      }
      if (method === "GET" && pathOnly === "/approvals") {
        const status = u.searchParams.get("status") as never;
        return json(res, 200, {
          ok: true,
          approvals: forge.guardrails.listApprovals(status || undefined),
        });
      }
      if (method === "POST" && pathOnly.startsWith("/approvals/") && pathOnly.endsWith("/resolve")) {
        const id = pathOnly.split("/")[2];
        const body = await readJson(req);
        const approval = forge.guardrails.resolve(
          String(id),
          body.status as "approved" | "rejected",
          String(body.resolvedBy || "human"),
        );
        return json(res, 200, { ok: true, approval });
      }

      return json(res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      const msg = errMsg(e);
      if (msg === "body_too_large") {
        return json(res, 413, { ok: false, error: msg });
      }
      const code =
        msg === "not_authorized" || msg === "denied"
          ? 403
          : msg === "no_available_agents"
            ? 503
            : msg.startsWith("unknown_") ||
                msg.startsWith("missing_") ||
                msg.startsWith("not_") ||
                msg.startsWith("duplicate_") ||
                msg.startsWith("group_size") ||
                msg.startsWith("owner_") ||
                msg.startsWith("to_") ||
                msg.startsWith("agent_") ||
                msg.startsWith("skill_") ||
                msg.startsWith("interval_") ||
                msg.startsWith("invalid_") ||
                msg.startsWith("approval_") ||
                msg.startsWith("bad_") ||
                msg.startsWith("contract_") ||
                msg.startsWith("handoff_") ||
                msg.startsWith("evidence_") ||
                msg.startsWith("provider_") ||
                msg.startsWith("path_") ||
                msg.startsWith("file_")
              ? 400
              : 500;
      log("err", msg);
      return json(res, code, { ok: false, error: msg });
    }
  });

  function listen(): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, host, () => {
        const addr = server.address();
        listeningPort =
          addr && typeof addr === "object" ? addr.port : configuredPort;
        log("listening", `http://${host}:${listeningPort}`);
        resolve({ port: listeningPort, host });
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    forge,
    listen,
    close,
    get port() {
      return listeningPort;
    },
    host,
  };
}

export type ForgeGateway = ReturnType<typeof createForgeGateway>;
