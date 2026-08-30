import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import {
  createForge,
  nextCronUtc,
  computeNextRun,
  GROUP_MIN,
  GROUP_MAX,
} from "../src/forge/index.js";
import { createForgeGateway } from "../src/forge/gateway.js";

async function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.end(payload);
    else r.end();
  });
}

describe("AgentForge core", () => {
  let home: string;
  let forge: ReturnType<typeof createForge>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "otb-forge-"));
    forge = createForge(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("persists agents atomically and rejects duplicate names", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
      title: "Chief of Staff",
    });
    expect(chief.id).toMatch(/^agent_/);
    expect(existsSync(join(home, "forge-state.json"))).toBe(true);
    const raw = JSON.parse(
      readFileSync(join(home, "forge-state.json"), "utf8"),
    ) as { version: number };
    expect(raw.version).toBe(1);

    expect(() =>
      forge.agents.create({ name: "Chief", role: "worker" }),
    ).toThrow(/duplicate_name/);

    const reloaded = createForge(home);
    expect(reloaded.agents.get(chief.id)?.name).toBe("Chief");
  });

  it("enforces group size 2..6, messaging, ownership transfer", () => {
    const a = forge.agents.create({ name: "A", role: "specialist" });
    const b = forge.agents.create({ name: "B", role: "specialist" });
    const c = forge.agents.create({ name: "C", role: "worker" });
    expect(() =>
      forge.groups.create({ name: "solo", memberIds: [a.id] }),
    ).toThrow(new RegExp(`group_size:${GROUP_MIN}`));

    const g = forge.groups.create({
      name: "ops",
      memberIds: [a.id, b.id, c.id],
      ownerId: a.id,
    });
    expect(g.memberIds).toHaveLength(3);
    expect(g.ownerId).toBe(a.id);

    const msg = forge.groups.postMessage({
      groupId: g.id,
      fromAgentId: a.id,
      body: "take the inbox",
      toAgentId: b.id,
    });
    expect(msg.body).toBe("take the inbox");

    const owned = forge.groups.transferOwnership(g.id, b.id, a.id);
    expect(owned.ownerId).toBe(b.id);

    expect(() =>
      forge.groups.transferOwnership(g.id, c.id, a.id),
    ).toThrow(/not_owner/);
  });

  it("orchestrator routes work to idle specialist by title match", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    forge.agents.create({
      name: "Inbox",
      role: "specialist",
      title: "Inbox Manager",
    });
    forge.agents.create({
      name: "Calendar",
      role: "specialist",
      title: "Calendar Scheduler",
    });

    const work = forge.orchestrator.submit({
      title: "Clear inbox backlog",
      body: "triage unread mail",
      requestedBy: chief.id,
    });
    expect(work.assignedTo).toBeTruthy();
    const assignee = forge.agents.get(work.assignedTo!);
    expect(assignee?.name).toBe("Inbox");
    expect(assignee?.status).toBe("busy");

    forge.orchestrator.recordEvidence(work.id, work.assignedTo!, {
      summary: "Inbox cleared",
      sources: [{ label: "inbox", at: Date.now() }],
      filesChanged: [],
      uncertainties: [],
    });
    forge.orchestrator.setStatus(work.id, "done", work.assignedTo!);
    expect(forge.agents.get(work.assignedTo!)?.status).toBe("idle");
  });

  it("skills share + attach; routines cron/interval/event", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const worker = forge.agents.create({ name: "Worker", role: "worker" });
    const skill = forge.skills.create({
      name: "triage-mail",
      instructions: "1. open inbox\n2. label\n3. archive",
      createdBy: chief.id,
      sharedWith: [worker.id],
    });
    expect(forge.skills.canUse(skill.id, worker.id)).toBe(true);
    forge.skills.attachToAgent(skill.id, worker.id, chief.id);
    expect(forge.agents.get(worker.id)?.skillIds).toContain(skill.id);

    const rtn = forge.routines.create({
      name: "hourly-triage",
      skillId: skill.id,
      agentId: worker.id,
      trigger: { kind: "interval", everyMs: 60_000 },
    });
    expect(rtn.nextRunAt).toBeGreaterThan(Date.now());

    const cronNext = nextCronUtc("0 * * * *", Date.UTC(2026, 0, 1, 10, 30));
    expect(cronNext).toBe(Date.UTC(2026, 0, 1, 11, 0));

    const eventRtn = forge.routines.create({
      name: "on-mail",
      skillId: skill.id,
      agentId: worker.id,
      trigger: { kind: "event", event: "mail.received" },
    });
    const fired = forge.routines.fireEvent("mail.received", chief.id);
    expect(fired.some((r) => r.id === eventRtn.id)).toBe(true);

    expect(computeNextRun({ kind: "interval", everyMs: 1000 }, 1000, 1000)).toBe(
      2000,
    );
  });

  it("guardrails ask → approve for irreversible", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const bot = forge.agents.create({ name: "Ops", role: "worker" });
    forge.guardrails.setPolicy(
      bot.id,
      { actions: { irreversible: "ask" } },
      chief.id,
    );
    const check = forge.guardrails.check(
      bot.id,
      "irreversible",
      "delete production bucket",
      { resource: "s3://prod" },
    );
    expect(check.decision).toBe("pending");
    expect(check.approvalId).toBeTruthy();

    const approved = forge.guardrails.resolve(
      check.approvalId!,
      "approved",
      "human",
    );
    expect(approved.status).toBe("approved");

    forge.guardrails.setPolicy(
      bot.id,
      { actions: { exec: "deny" } },
      chief.id,
    );
    expect(forge.guardrails.check(bot.id, "exec", "rm -rf").decision).toBe(
      "deny",
    );
  });

  it("rejects group larger than max", () => {
    const ids = [];
    for (let i = 0; i < GROUP_MAX + 1; i++) {
      ids.push(forge.agents.create({ name: `M${i}`, role: "worker" }).id);
    }
    expect(() =>
      forge.groups.create({ name: "too-big", memberIds: ids }),
    ).toThrow(new RegExp(`group_size`));
  });

  it("rejects approval resolve by non-chief agents", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const worker = forge.agents.create({ name: "Worker", role: "worker" });
    const check = forge.guardrails.check(
      worker.id,
      "irreversible",
      "wipe disk",
    );
    expect(() =>
      forge.guardrails.resolve(check.approvalId!, "approved", worker.id),
    ).toThrow(/not_authorized/);
    const ok = forge.guardrails.resolve(
      check.approvalId!,
      "approved",
      chief.id,
    );
    expect(ok.status).toBe("approved");
  });

  it("excludes offline/error agents from auto-assign", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const offline = forge.agents.create({
      name: "Down",
      role: "specialist",
      title: "Inbox Manager",
    });
    forge.agents.update(offline.id, { status: "offline" });
    const fallback = forge.orchestrator.submit({
      title: "Clear inbox",
      body: "triage mail",
      requestedBy: chief.id,
    });
    expect(fallback.assignedTo).toBe(chief.id);

    forge.agents.update(offline.id, { status: "error" });
    expect(() =>
      forge.orchestrator.submit({
        title: "Clear inbox again",
        body: "triage mail",
        requestedBy: chief.id,
        assignTo: offline.id,
      }),
    ).toThrow(/agent_unavailable/);

    forge.agents.update(chief.id, { status: "offline" });
    expect(() =>
      forge.orchestrator.submit({
        title: "nobody home",
        body: "should fail",
        requestedBy: chief.id,
      }),
    ).toThrow(/no_available_agents/);
  });

  it("rejects bad work status and restores busy on reopen", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const worker = forge.agents.create({
      name: "Worker",
      role: "specialist",
      title: "Ops",
    });
    const work = forge.orchestrator.submit({
      title: "task",
      body: "do it",
      requestedBy: chief.id,
      assignTo: worker.id,
    });
    expect(() =>
      forge.orchestrator.setStatus(work.id, "dnoe" as never, worker.id),
    ).toThrow(/bad_status/);

    forge.orchestrator.recordEvidence(work.id, worker.id, {
      summary: "done",
      sources: [{ label: "local", at: Date.now() }],
    });
    forge.orchestrator.setStatus(work.id, "done", worker.id);
    expect(forge.agents.get(worker.id)?.status).toBe("idle");
    forge.orchestrator.setStatus(work.id, "in_progress", worker.id);
    expect(forge.agents.get(worker.id)?.status).toBe("busy");
  });

  it("refuses attach to agents outside sharedWith", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const a = forge.agents.create({ name: "A", role: "worker" });
    const b = forge.agents.create({ name: "B", role: "worker" });
    const skill = forge.skills.create({
      name: "private",
      instructions: "keep secret",
      createdBy: chief.id,
      sharedWith: [a.id],
    });
    expect(() =>
      forge.skills.attachToAgent(skill.id, b.id, chief.id),
    ).toThrow(/skill_not_shared/);
  });

  it("refuses agent remove while referenced", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const worker = forge.agents.create({ name: "Worker", role: "worker" });
    const skill = forge.skills.create({
      name: "s",
      instructions: "x",
      createdBy: chief.id,
      sharedWith: [worker.id],
    });
    forge.routines.create({
      name: "r",
      skillId: skill.id,
      agentId: worker.id,
      trigger: { kind: "interval", everyMs: 60_000 },
    });
    expect(() => forge.agents.remove(worker.id)).toThrow(/agent_has_routine/);
  });

  it("seeds safe first roster with role contracts", () => {
    const seeded = forge.seed();
    expect(seeded.created).toBe(true);
    expect(seeded.chief.role).toBe("chief_of_staff");
    expect(seeded.chief.name).toBe("Atlas");
    expect(seeded.chief.contract?.job).toMatch(/Coordinate/);
    expect(seeded.specialist.contract?.noDataRule).toMatch(/No material change/);
    expect(seeded.specialist.skillIds).toContain(seeded.skill.id);
    expect(seeded.group?.memberIds.length).toBeGreaterThanOrEqual(3);
    expect(forge.providers.list().some((p) => p.kind === "mock")).toBe(true);
    expect(forge.vm.listFiles().some((f) => f.path === "README.md")).toBe(true);
    expect(forge.seed().created).toBe(false);
  });

  it("requires evidence before done; records handoffs and routine runs", () => {
    const chief = forge.agents.create({
      name: "Chief",
      role: "chief_of_staff",
    });
    const a = forge.agents.create({
      name: "Inbox",
      role: "specialist",
      title: "Inbox Manager",
    });
    const b = forge.agents.create({
      name: "Reviewer",
      role: "specialist",
      title: "Reviewer",
    });
    const work = forge.orchestrator.submit({
      title: "triage",
      body: "inbox",
      requestedBy: chief.id,
      assignTo: a.id,
    });
    expect(() =>
      forge.orchestrator.setStatus(work.id, "done", a.id),
    ).toThrow(/missing_evidence/);

    forge.orchestrator.recordEvidence(work.id, a.id, {
      summary: "3 material, 9 noise",
      sources: [{ label: "inbox", url: "mail://inbox", at: Date.now() }],
      filesChanged: ["/workspace/triage.md"],
      uncertainties: ["sender X unverified"],
    });
    forge.orchestrator.setStatus(work.id, "done", a.id);
    expect(forge.orchestrator.getWork(work.id)?.evidence?.summary).toMatch(/3 material/);

    const hand = forge.handoffs.create({
      fromAgentId: a.id,
      toAgentId: b.id,
      summary: "please review triage.md",
      workId: work.id,
    });
    expect(hand.status).toBe("open");
    expect(forge.orchestrator.getWork(work.id)?.assignedTo).toBe(b.id);
    forge.handoffs.resolve(hand.id, "accepted", b.id);
    forge.handoffs.resolve(hand.id, "completed", b.id, "approved with notes");
    expect(forge.handoffs.get(hand.id)?.status).toBe("completed");

    const skill = forge.skills.create({
      name: "pulse",
      instructions: "ping",
      createdBy: chief.id,
    });
    const rtn = forge.routines.create({
      name: "tick",
      skillId: skill.id,
      agentId: a.id,
      trigger: { kind: "interval", everyMs: 1000 },
    });
    const ran = forge.routines.markRan(rtn.id, Date.now(), {
      status: "ok",
      note: "claimed",
    });
    expect(ran.runs).toHaveLength(1);
    expect(forge.routines.listRuns(rtn.id)[0]?.note).toBe("claimed");
  });

  it("shared VM + mock chat + group command chain", async () => {
    const seeded = forge.seed();
    expect(seeded.created).toBe(true);
    forge.vm.writeFile("notes/hello.txt", "hi from shared vm", seeded.chief.id);
    expect(forge.vm.readFile("notes/hello.txt").content).toMatch(/hi from/);
    forge.vm.setMemory("watchList", '["proj-a"]', seeded.chief.id);
    expect(forge.vm.getMemory().watchList).toMatch(/proj-a/);

    const direct = await forge.chat.agentChat({
      agentId: seeded.specialist.id,
      message: "status check",
    });
    expect(direct.reply.content).toMatch(/mock/);
    expect(forge.vm.getScreen(seeded.specialist.id).length).toBeGreaterThan(0);

    const group = await forge.chat.groupChat({
      groupId: seeded.group!.id,
      message: "Please triage my unread inbox emails",
    });
    expect(group.route.targetAgentId).toBe(seeded.specialist.id);
    expect(group.reply.agentId).toBe(seeded.specialist.id);
    expect(group.reply.content).toMatch(/mock/);
  });

  it("OpenHands-style bash + editor tool loop emits events", async () => {
    const seeded = forge.seed();
    const out = await forge.chat.agentChat({
      agentId: seeded.specialist.id,
      message: "list files",
      useTools: true,
    });
    expect(out.toolsUsed).toBe(true);
    expect(out.reply.content).toMatch(/README|calendar|notes/i);
    expect(out.events.some((e) => e.kind === "action" && e.tool === "execute_bash")).toBe(
      true,
    );
    expect(out.events.some((e) => e.kind === "observation")).toBe(true);

    const edited = await forge.chat.agentChat({
      agentId: seeded.specialist.id,
      message: 'write notes/tool-demo.md with hello openhands tools',
      useTools: true,
    });
    expect(edited.toolsUsed).toBe(true);
    expect(forge.vm.readFile("notes/tool-demo.md").content).toMatch(/hello openhands/);

    const catalog = forge.tools.catalog();
    expect(catalog.map((t) => t.name)).toContain("execute_bash");
    expect(catalog.map((t) => t.name)).toContain("delegate");
  });
});

describe("AgentForge gateway", () => {
  let home: string;
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "otb-forge-gw-"));
  });

  afterEach(async () => {
    if (close) await close();
    close = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("health + create agents + submit work over HTTP", async () => {
    const gw = createForgeGateway({
      port: 0,
      home,
      log: () => {},
    });
    const listened = await gw.listen();
    close = () => gw.close();

    const health = await req(listened.port, "GET", "/healthz");
    expect(health.status).toBe(200);
    expect(health.json.service).toBe("agentforge");

    const chief = await req(listened.port, "POST", "/agents", {
      name: "Chief",
      role: "chief_of_staff",
    });
    expect(chief.status).toBe(200);
    const specialist = await req(listened.port, "POST", "/agents", {
      name: "Inbox",
      role: "specialist",
      title: "Inbox Manager",
    });
    expect(specialist.status).toBe(200);

    const work = await req(listened.port, "POST", "/work", {
      title: "inbox sweep",
      body: "clean the inbox",
      requestedBy: (chief.json.agent as { id: string }).id,
    });
    expect(work.status).toBe(200);
    expect((work.json.work as { assignedTo: string }).assignedTo).toBe(
      (specialist.json.agent as { id: string }).id,
    );
  });

  it("gates ownership transfer and advances routines via claim", async () => {
    const gw = createForgeGateway({
      port: 0,
      home,
      log: () => {},
    });
    const listened = await gw.listen();
    close = () => gw.close();

    const a = await req(listened.port, "POST", "/agents", {
      name: "Owner",
      role: "specialist",
    });
    const b = await req(listened.port, "POST", "/agents", {
      name: "CoOwner",
      role: "specialist",
    });
    const aId = (a.json.agent as { id: string }).id;
    const bId = (b.json.agent as { id: string }).id;

    const group = await req(listened.port, "POST", "/groups", {
      name: "pair",
      memberIds: [aId, bId],
      ownerId: aId,
    });
    expect(group.status).toBe(200);
    const groupId = (group.json.group as { id: string }).id;

    const pending = await req(
      listened.port,
      "POST",
      `/groups/${groupId}/ownership`,
      { actorId: aId, ownerId: bId },
    );
    expect(pending.status).toBe(202);
    expect(pending.json.pending).toBe(true);
    const approvalId = String(pending.json.approvalId);

    const stillOwned = gw.forge.groups.get(groupId);
    expect(stillOwned?.ownerId).toBe(aId);

    await req(listened.port, "POST", `/approvals/${approvalId}/resolve`, {
      status: "approved",
      resolvedBy: "human",
    });

    const transferred = await req(
      listened.port,
      "POST",
      `/groups/${groupId}/ownership`,
      { actorId: aId, ownerId: bId, approvalId },
    );
    expect(transferred.status).toBe(200);
    expect((transferred.json.group as { ownerId: string }).ownerId).toBe(bId);

    const skill = await req(listened.port, "POST", "/skills", {
      name: "pulse",
      instructions: "ping",
      createdBy: aId,
      sharedWith: [aId],
    });
    const skillId = (skill.json.skill as { id: string }).id;
    const routine = await req(listened.port, "POST", "/routines", {
      name: "tick",
      skillId,
      agentId: aId,
      trigger: { kind: "interval", everyMs: 1000 },
    });
    expect(routine.status).toBe(200);
    const routineId = (routine.json.routine as { id: string }).id;
    gw.forge.store.update((state) => {
      state.routines[routineId]!.nextRunAt = Date.now() - 1;
    });
    const due = await req(listened.port, "GET", "/routines/due");
    expect(
      (due.json.routines as { id: string }[]).some((r) => r.id === routineId),
    ).toBe(true);

    const claimed = await req(
      listened.port,
      "POST",
      `/routines/${routineId}/claim`,
    );
    expect(claimed.status).toBe(200);
    expect(
      (claimed.json.routine as { nextRunAt: number | null }).nextRunAt,
    ).toBeGreaterThan(Date.now() - 100);

    const dueAfter = await req(listened.port, "GET", "/routines/due");
    expect(
      (dueAfter.json.routines as { id: string }[]).some(
        (r) => r.id === routineId,
      ),
    ).toBe(false);
  });
});
