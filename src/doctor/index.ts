/**
 * Update-proof doctor — baselines + drift for AgentForge.
 *
 * Behavioral port of OnlyTerp/opengrok `tools/doctor.py` (MIT), improved:
 *  - null-safe binding SHA drift (opengrok #4)
 *  - default hop probe uses /healthz (and accepts /health aliases via hop)
 *  - pure TypeScript core; no Windows-only auto-fix in v1
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename, isAbsolute, resolve } from "node:path";
import { createConnection } from "node:net";
import { homedir } from "node:os";

export type DoctorLevel = "PASS" | "FAIL" | "WARN" | "INFO";

export type DoctorFinding = {
  level: DoctorLevel;
  tag: string;
  detail: string;
};

export type ServiceExpect = {
  port: number;
  name: string;
  probeUrl?: string;
  probeWant?: string;
};

export type DoctorConfig = {
  repoRoot: string;
  baselinePath: string;
  services: ServiceExpect[];
  watchedFiles: string[];
  bindingsPath: string | null;
  configFindings?: DoctorFinding[];
};

export type BindingsMeta = {
  agent_count: number | null;
  names: string[];
  sha: string | null;
};

export type DoctorReport = {
  findings: DoctorFinding[];
  bindings: BindingsMeta;
  fileShas: Record<string, string>;
  exitCode: number;
  human: string;
};

export type Baseline = {
  captured: string;
  files: Record<string, string>;
  bindings: { sha: string | null; agent_count: number | null };
  known_warnings: string[];
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileSha(path: string): string {
  if (!existsSync(path)) return "MISSING";
  return sha256(readFileSync(path));
}

export function tcpListen(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 600,
): Promise<boolean> {
  return new Promise((resolveDone) => {
    const s = createConnection({ port, host });
    const done = (ok: boolean) => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolveDone(ok);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

export function probeHostFromUrl(url: string | undefined): string {
  if (!url) return "127.0.0.1";
  try {
    const u = new URL(url);
    // Node URL.hostname keeps brackets for IPv6 ([::1]); net.connect wants ::1.
    return (u.hostname || "127.0.0.1").replace(/^\[|\]$/g, "");
  } catch {
    return "127.0.0.1";
  }
}

export async function probeUrl(
  url: string,
  want?: string,
  timeoutMs = 4000,
): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text();
    const snippet = body.slice(0, 400);
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} @${url}` };
    }
    if (want != null && want !== "" && !snippet.includes(want)) {
      return { ok: false, detail: `unexpected body @ ${url}` };
    }
    return { ok: true, detail: `${res.status} @${url}` };
  } catch (e) {
    const msg = e instanceof Error ? e.name : String(e);
    return { ok: false, detail: `${msg} @${url}` };
  } finally {
    clearTimeout(t);
  }
}

export function findBindingsPath(repoRoot: string): string | null {
  const home = homedir();
  const cands = [
    join(home, ".grokbot", "model-bindings.json"),
    join(home, "AppData", "Roaming", "Grok Bot", "model-bindings.json"),
    join(home, ".config", "Grok Bot", "model-bindings.json"),
    join(home, "Library", "Application Support", "Grok Bot", "model-bindings.json"),
    join(repoRoot, "model-bindings.json"),
  ];
  for (const p of cands) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadServicesConfig(repoRoot: string): {
  services: ServiceExpect[];
  watchedFiles: string[];
  findings: DoctorFinding[];
} {
  const cfgPath = join(repoRoot, "services.json");
  const defaults: ServiceExpect[] = [
    {
      port: 18790,
      name: "agentforge-hop",
      probeUrl: "http://127.0.0.1:18790/healthz",
      probeWant: '"ok":true',
    },
    {
      port: 18795,
      name: "consult-gateway",
      probeUrl: "http://127.0.0.1:18795/health",
      probeWant: "consult-gateway",
    },
    {
      port: 18800,
      name: "agentforge",
      probeUrl: "http://127.0.0.1:18800/healthz",
      probeWant: "agentforge",
    },
  ];
  if (!existsSync(cfgPath)) {
    return { services: defaults, watchedFiles: [], findings: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      services?: Array<{
        port: number;
        name?: string;
        probe_url?: string;
        probe_want?: string;
      }>;
      watched_files?: string[];
    };
    const services =
      Array.isArray(raw.services) && raw.services.length
        ? raw.services.map((s) => ({
            port: s.port,
            name: s.name || `svc-${s.port}`,
            probeUrl:
              s.probe_url || `http://127.0.0.1:${s.port}/healthz`,
            probeWant: s.probe_want,
          }))
        : defaults;
    const watchedFiles = Array.isArray(raw.watched_files)
      ? raw.watched_files.map(String)
      : [];
    return { services, watchedFiles, findings: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      services: [],
      watchedFiles: [],
      findings: [
        {
          level: "FAIL",
          tag: "services.json",
          detail: `unreadable/malformed — refusing defaults: ${msg}`,
        },
      ],
    };
  }
}

function resolveWatchPath(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

export function resolveDoctorConfig(repoRoot: string): DoctorConfig {
  const { services, watchedFiles, findings } = loadServicesConfig(repoRoot);
  const bindingsPath = findBindingsPath(repoRoot);
  const maps = join(repoRoot, "src", "wire-maps.ts");
  const watch = watchedFiles.map((p) => resolveWatchPath(repoRoot, p));
  if (bindingsPath) watch.push(bindingsPath);
  if (existsSync(maps)) watch.push(maps);
  return {
    repoRoot,
    baselinePath: join(repoRoot, "baseline.json"),
    services,
    watchedFiles: [...new Set(watch)],
    bindingsPath,
    configFindings: findings,
  };
}

export function parseBindings(path: string | null): {
  findings: DoctorFinding[];
  meta: BindingsMeta;
} {
  const findings: DoctorFinding[] = [];
  const meta: BindingsMeta = { agent_count: null, names: [], sha: null };
  if (!path || !existsSync(path)) {
    findings.push({
      level: "WARN",
      tag: "bindings",
      detail: "model-bindings.json not found (optional until hop wired)",
    });
    return { findings, meta };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      agents?: Record<string, { name?: string }>;
    };
    const agents = raw.agents ?? {};
    const names = Object.values(agents)
      .filter((a) => a && typeof a === "object")
      .map((a) => a.name || "?")
      .sort();
    meta.agent_count = Object.keys(agents).length;
    meta.names = names;
    meta.sha = fileSha(path);
    findings.push({
      level: "PASS",
      tag: "bindings:parse",
      detail: `${meta.agent_count} agents`,
    });
  } catch (e) {
    findings.push({
      level: "FAIL",
      tag: "bindings:parse",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  return { findings, meta };
}

/** Null-safe SHA prefix (fixes opengrok doctor TypeError on null baseline sha). */
export function shaPrefix(sha: string | null | undefined): string {
  return (sha || "").slice(0, 8) || "null";
}

function knownWarningKey(level: string, tag: string, detail: string): string {
  return `${level}::${tag}::${detail}`;
}

export async function runDoctor(
  cfg: DoctorConfig,
  opts: { init?: boolean; quiet?: boolean; json?: boolean } = {},
): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [...(cfg.configFindings || [])];

  for (const svc of cfg.services) {
    const host = probeHostFromUrl(svc.probeUrl);
    const up = await tcpListen(svc.port, host);
    if (!up) {
      findings.push({
        level: "FAIL",
        tag: `svc:${svc.name}`,
        detail: `${host}:${svc.port} NOT LISTENING`,
      });
      continue;
    }
    if (!svc.probeUrl) {
      findings.push({
        level: "PASS",
        tag: `svc:${svc.name}`,
        detail: `${host}:${svc.port} tcp up`,
      });
      continue;
    }
    const { ok, detail } = await probeUrl(svc.probeUrl, svc.probeWant);
    findings.push({
      level: ok ? "PASS" : "FAIL",
      tag: `svc:${svc.name}`,
      detail: `${host}:${svc.port} ${detail}`,
    });
  }

  const { findings: bFindings, meta: bmeta } = parseBindings(cfg.bindingsPath);
  findings.push(...bFindings);

  const fileShas: Record<string, string> = {};
  for (const p of cfg.watchedFiles) {
    fileShas[p] = fileSha(p);
  }

  let base: Baseline | null = null;
  if (existsSync(cfg.baselinePath)) {
    try {
      base = JSON.parse(readFileSync(cfg.baselinePath, "utf8")) as Baseline;
    } catch (e) {
      findings.push({
        level: "WARN",
        tag: "baseline",
        detail: `unreadable: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (base?.files) {
    for (const [path, h] of Object.entries(fileShas)) {
      if (!(path in base.files)) {
        findings.push({
          level: "WARN",
          tag: "drift:file",
          detail: `${basename(path)} not in baseline (re-run --init to accept)`,
        });
        continue;
      }
      if (base.files[path] !== h) {
        findings.push({
          level: h === "MISSING" ? "FAIL" : "WARN",
          tag: "drift:file",
          detail: `${basename(path)} changed vs baseline (review; re-run --init to accept)`,
        });
      }
    }
  }

  const kb = base?.bindings;
  if (kb && (kb.sha || null) !== (bmeta.sha || null)) {
    findings.push({
      level: "WARN",
      tag: "drift:bindings",
      detail: `agent sha changed (${shaPrefix(kb.sha)}…->${shaPrefix(bmeta.sha)}…)`,
    });
  }

  if (opts.init) {
    const known = findings
      .filter((f) => f.level === "WARN")
      .map((f) => knownWarningKey(f.level, f.tag, f.detail));
    const payload: Baseline = {
      captured: new Date().toISOString().replace(/\.\d{3}Z$/, ""),
      files: fileShas,
      bindings: { sha: bmeta.sha, agent_count: bmeta.agent_count },
      known_warnings: known,
    };
    mkdirSync(dirname(cfg.baselinePath), { recursive: true });
    writeFileSync(cfg.baselinePath, JSON.stringify(payload, null, 2) + "\n");
    findings.push({
      level: "INFO",
      tag: "baseline",
      detail: `written -> ${cfg.baselinePath}`,
    });
  }

  const rawKnown = base?.known_warnings;
  const knownSet = new Set<string>();
  if (Array.isArray(rawKnown)) {
    for (const entry of rawKnown) {
      if (typeof entry === "string" && entry.includes("::")) {
        knownSet.add(entry);
      } else {
        findings.push({
          level: "WARN",
          tag: "baseline:known_warnings",
          detail: `ignored malformed known_warnings entry: ${JSON.stringify(entry)}`,
        });
      }
    }
  } else if (rawKnown != null) {
    findings.push({
      level: "WARN",
      tag: "baseline:known_warnings",
      detail: "known_warnings is not an array — ignored",
    });
  }

  const fails = findings.filter((f) => f.level === "FAIL");
  const warns = findings.filter((f) => f.level === "WARN");
  const newWarns = warns.filter(
    (w) => !knownSet.has(knownWarningKey(w.level, w.tag, w.detail)),
  );
  const serviceFails = fails.filter(
    (f) => f.tag.startsWith("svc:") || f.tag === "services.json",
  );

  // --init always exits 0 after writing (recovery path)
  const exitCode = opts.init
    ? 0
    : fails.length
      ? 2
      : newWarns.length
        ? 1
        : 0;

  const lines = findings.map((f) => `[${f.level}] ${f.tag} :: ${f.detail}`);
  const summary = `\nSUMMARY: ${fails.length} fail, ${newWarns.length} new warn, ${warns.length - newWarns.length} known warn`;
  let human = (lines.join("\n") || "ALL GREEN") + summary;
  if (opts.quiet) {
    if (!fails.length && !newWarns.length) human = "";
    else {
      human = [...fails, ...newWarns]
        .map((f) => `[${f.level}] ${f.tag} :: ${f.detail}`)
        .join("\n");
    }
  }
  if (opts.json) {
    human = JSON.stringify(
      {
        services_ok: serviceFails.length === 0,
        fail: fails.map((f) => ({ tag: f.tag, detail: f.detail })),
        new_warn: newWarns.map((f) => ({ tag: f.tag, detail: f.detail })),
        known_warn_count: warns.length - newWarns.length,
        bindings_agent_count: bmeta.agent_count,
      },
      null,
      2,
    );
  }

  return { findings, bindings: bmeta, fileShas, exitCode, human };
}
