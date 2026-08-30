import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import {
  shaPrefix,
  parseBindings,
  runDoctor,
  loadServicesConfig,
  probeUrl,
  probeHostFromUrl,
  type DoctorConfig,
} from "../src/doctor/index.js";
import { createHop } from "../src/hop/index.js";

describe("doctor — null-safe sha + bindings", () => {
  it("shaPrefix never throws on null", () => {
    expect(shaPrefix(null)).toBe("null");
    expect(shaPrefix(undefined)).toBe("null");
    expect(shaPrefix("abcdef12zzzz")).toBe("abcdef12");
  });

  it("parseBindings warns when missing; parses when present", () => {
    const miss = parseBindings(null);
    expect(miss.findings[0]?.level).toBe("WARN");
    expect(miss.meta.sha).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "otb-bind-"));
    const path = join(dir, "model-bindings.json");
    writeFileSync(
      path,
      JSON.stringify({
        agents: { a1: { name: "Fast", modelId: "glm-5.3-flash" } },
      }),
    );
    const ok = parseBindings(path);
    expect(ok.meta.agent_count).toBe(1);
    expect(ok.meta.sha).toMatch(/^[a-f0-9]{64}$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--init recovers from null baseline sha without TypeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otb-doc-"));
    const baselinePath = join(dir, "baseline.json");
    writeFileSync(
      baselinePath,
      JSON.stringify({
        captured: "2026-01-01",
        files: {},
        bindings: { sha: null, agent_count: null },
        known_warnings: [],
      }),
    );
    const bind = join(dir, "model-bindings.json");
    writeFileSync(
      bind,
      JSON.stringify({ agents: { x: { name: "A", modelId: "m" } } }),
    );
    const cfg: DoctorConfig = {
      repoRoot: dir,
      baselinePath,
      services: [],
      watchedFiles: [bind],
      bindingsPath: bind,
    };
    const first = await runDoctor(cfg, {});
    expect(first.findings.some((f) => f.tag === "drift:bindings")).toBe(true);
    expect(first.human).toContain("null…->");
    expect(() => shaPrefix(null)).not.toThrow();

    const init = await runDoctor(cfg, { init: true });
    expect(init.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(baselinePath, "utf8")) as {
      bindings: { sha: string };
    };
    expect(written.bindings.sha).toMatch(/^[a-f0-9]{64}$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("malformed services.json fails closed (no silent defaults)", () => {
    const dir = mkdtempSync(join(tmpdir(), "otb-svc-"));
    writeFileSync(join(dir, "services.json"), "{not-json");
    const loaded = loadServicesConfig(dir);
    expect(loaded.services).toEqual([]);
    expect(loaded.findings[0]?.level).toBe("FAIL");
    expect(loaded.findings[0]?.tag).toBe("services.json");
    rmSync(dir, { recursive: true, force: true });
  });

  it("services_ok is false when services.json config fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otb-svcok-"));
    const cfg: DoctorConfig = {
      repoRoot: dir,
      baselinePath: join(dir, "baseline.json"),
      services: [],
      watchedFiles: [],
      bindingsPath: null,
      configFindings: [
        {
          level: "FAIL",
          tag: "services.json",
          detail: "unreadable/malformed — refusing defaults: Unexpected token",
        },
      ],
    };
    const report = await runDoctor(cfg, { json: true });
    const payload = JSON.parse(report.human) as { services_ok: boolean };
    expect(payload.services_ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("probeHostFromUrl strips IPv6 brackets", () => {
    expect(probeHostFromUrl("http://[::1]:18790/healthz")).toBe("::1");
    expect(probeHostFromUrl("http://127.0.0.1:18790/healthz")).toBe("127.0.0.1");
  });

  it("probeUrl rejects non-2xx even without probeWant", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const result = await probeUrl(`http://127.0.0.1:${addr.port}/health`);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTTP 500");
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
});

describe("hop — health aliases + wire-map apply", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("answers /healthz and /health; maps glm effort on completions", async () => {
    let sawBody: Record<string, unknown> | null = null;
    let sawAuth: string | undefined;
    const upstream = http.createServer((req, res) => {
      if (req.url === "/health" || req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      sawAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        sawBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", choices: [] }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const uAddr = upstream.address();
    if (!uAddr || typeof uAddr === "string") throw new Error("no up port");
    const upPort = uAddr.port;

    const hop = createHop({
      port: 0,
      upstream: `http://127.0.0.1:${upPort}`,
      apiKey: "test-key",
      log: () => {},
    });
    const listened = await hop.listen();
    close = async () => {
      await hop.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((e) => (e ? reject(e) : resolve())),
      );
    };

    const hz = await fetch(`http://127.0.0.1:${listened.port}/healthz`);
    const hzj = (await hz.json()) as { ok: boolean; service: string };
    expect(hz.status).toBe(200);
    expect(hzj.ok).toBe(true);
    expect(hzj.service).toBe("agentforge-hop");

    const h = await fetch(`http://127.0.0.1:${listened.port}/health`);
    expect(h.status).toBe(200);
    expect(((await h.json()) as { ok: boolean }).ok).toBe(true);

    const r = await fetch(
      `http://127.0.0.1:${listened.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5.3-flash",
          messages: [{ role: "user", content: "hi" }],
          parameters: [{ id: "effort", value: "max" }],
        }),
      },
    );
    expect(r.status).toBe(200);
    expect(sawBody?.thinking).toEqual({ type: "enabled" });
    expect(sawBody?.reasoning_effort).toBe("max");
    expect(sawBody?.parameters).toBeUndefined();
    expect(sawAuth).toBe("Bearer test-key");
  });

  it("forwards client Authorization when hop key unset; strips harness fields on none", async () => {
    let sawBody: Record<string, unknown> | null = null;
    let sawAuth: string | undefined;
    const upstream = http.createServer((req, res) => {
      if (req.url === "/health" || req.url === "/healthz") {
        res.writeHead(200);
        res.end("{}");
        return;
      }
      sawAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        sawBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const uAddr = upstream.address();
    if (!uAddr || typeof uAddr === "string") throw new Error("no up port");

    const hop = createHop({
      port: 0,
      upstream: `http://127.0.0.1:${uAddr.port}`,
      apiKey: null,
      log: () => {},
    });
    const listened = await hop.listen();
    close = async () => {
      await hop.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((e) => (e ? reject(e) : resolve())),
      );
    };

    const r = await fetch(
      `http://127.0.0.1:${listened.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer client-token",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          parameters: [{ id: "effort", value: "max" }],
          maxMode: true,
        }),
      },
    );
    expect(r.status).toBe(200);
    expect(sawAuth).toBe("Bearer client-token");
    expect(sawBody?.parameters).toBeUndefined();
    expect(sawBody?.maxMode).toBeUndefined();
    expect(sawBody?.model).toBe("gpt-4o");
  });
});
