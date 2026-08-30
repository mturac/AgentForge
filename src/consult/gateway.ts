/**
 * Localhost Consult completion gateway (default :18795).
 * Behavioral port of OnlyTerp/opengrok `voice/consult-gateway.cjs` (MIT).
 *
 * Surfaces:
 *   POST /consult              start
 *   GET  /consult|/consult/status?id=
 *   POST /consult/complete     deliver answer (pushes captain when configured)
 *   GET  /health
 */

import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createConsultBus, type ConsultBus } from "./bus.js";

export const DEFAULT_CONSULT_PORT = 18795;
export const DEFAULT_CAPTAIN_POST =
  "http://127.0.0.1:18793/consult.result";

export type ConsultGatewayOptions = {
  port?: number;
  host?: string;
  captainPost?: string | null;
  bus?: ConsultBus;
  log?: (...args: unknown[]) => void;
  /** Injectable captain push (tests). Defaults to HTTP(S) POST when captainPost set. */
  pushCaptain?: (
    payload: Record<string, unknown>,
  ) => Promise<{ status: number; body: string }>;
};

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") return true;
  try {
    const u = new URL(origin);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isLocalOrigin(origin)) {
    return {
      "access-control-allow-origin": origin,
      vary: "Origin",
    };
  }
  return {};
}

function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (d: Buffer) => {
      if (rejected) return;
      size += d.length;
      if (size > 120_000) {
        rejected = true;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(
  req: IncomingMessage,
  res: ServerResponse,
  code: number,
  obj: unknown,
): void {
  res.writeHead(code, {
    "content-type": "application/json",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(obj));
}

async function defaultPushCaptain(
  captainPost: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const url = new URL(captainPost);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported_captain_protocol:${url.protocol}`);
  }
  const lib = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || defaultPort,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (d: Buffer) => chunks.push(d));
        r.on("end", () =>
          resolve({
            status: r.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(4000, () => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      reject(new Error("captain_timeout"));
    });
    req.end(body);
  });
}

export function createConsultGateway(opts: ConsultGatewayOptions = {}) {
  const configuredPort = opts.port ?? DEFAULT_CONSULT_PORT;
  const host = opts.host ?? "127.0.0.1";
  const captainPost =
    opts.captainPost === undefined
      ? DEFAULT_CAPTAIN_POST
      : opts.captainPost;
  const log = opts.log ?? ((...a: unknown[]) => console.error("[consult.gw]", ...a));
  const bus = opts.bus ?? createConsultBus((...a) => log(...a));
  const push =
    opts.pushCaptain ??
    (captainPost
      ? (p: Record<string, unknown>) => defaultPushCaptain(captainPost, p)
      : null);

  let listeningPort = configuredPort;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const urlRaw = req.url || "/";
      if (method === "OPTIONS") {
        const cors = corsHeaders(req);
        if (!cors["access-control-allow-origin"]) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(204, {
          ...cors,
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        });
        res.end();
        return;
      }
      if (urlRaw === "/health") {
        return json(req, res, 200, {
          ok: true,
          service: "consult-gateway",
          port: listeningPort,
          open: bus.open(),
        });
      }
      const pathOnly = urlRaw.split("?")[0] || "/";
      if (
        method === "GET" &&
        (pathOnly === "/consult" ||
          pathOnly === "/consult/open" ||
          pathOnly.startsWith("/consult/status"))
      ) {
        const u = new URL(urlRaw, "http://127.0.0.1");
        const id =
          u.searchParams.get("id") || u.searchParams.get("consult_id");
        if (id) return json(req, res, 200, { ok: true, consult: bus.get(id) });
        return json(req, res, 200, { ok: true, consult: bus.open() });
      }
      if (
        method === "POST" &&
        (pathOnly === "/consult" || pathOnly === "/consult/start")
      ) {
        try {
          const body = await readJson(req);
          const out = bus.start(body);
          return json(req, res, out.ok ? 200 : 400, out);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "body_too_large") {
            return json(req, res, 413, { ok: false, error: "body_too_large" });
          }
          return json(req, res, 400, { ok: false, error: "bad_json" });
        }
      }
      if (
        method === "POST" &&
        (pathOnly === "/consult/ping" ||
          pathOnly === "/consult/complete" ||
          pathOnly === "/consult.result" ||
          pathOnly === "/consult-result")
      ) {
        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "body_too_large") {
            return json(req, res, 413, { ok: false, error: "body_too_large" });
          }
          return json(req, res, 400, { ok: false, error: "bad_json" });
        }
        if (
          (pathOnly === "/consult/complete" ||
            pathOnly === "/consult.result" ||
            pathOnly === "/consult-result") &&
          !body.status
        ) {
          body.status = "completed";
        }
        const out = bus.ping(body) as Record<string, unknown> & {
          ok: boolean;
          status?: string;
          duplicate?: boolean;
          consult_id?: string;
          error?: string;
          rtt_ms?: number;
          text?: string;
          retry_push?: boolean;
          delivered?: boolean;
        };
        if (!out.ok) return json(req, res, 400, out);

        const wantsPush =
          (out.status === "completed" || out.status === "failed") &&
          !!push &&
          (out.retry_push === true || (!out.duplicate && !out.delivered));

        if (!wantsPush) return json(req, res, 200, out);

        const answer =
          out.text ||
          body.text ||
          body.answer ||
          body.result ||
          "";
        const envelope = {
          text:
            out.status === "failed"
              ? JSON.stringify({
                  consult_id: out.consult_id,
                  status: "failed",
                  error: out.error || "failed",
                  rtt_ms: out.rtt_ms,
                })
              : JSON.stringify({
                  consult_id: out.consult_id,
                  status: "completed",
                  answer,
                  rtt_ms: out.rtt_ms,
                }),
          consult_id: out.consult_id,
          status: out.status,
          answer,
          error: out.error || "",
        };
        try {
          const pushed = await push!(envelope);
          out.pushed = pushed.status === 200;
          out.push_status = pushed.status;
          if (out.pushed && typeof out.consult_id === "string") {
            bus.markDelivered(out.consult_id);
            out.delivered = true;
          }
          return json(req, res, 200, out);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("push.fail", msg);
          out.pushed = false;
          out.push_error = msg;
          return json(req, res, 200, out);
        }
      }
      return json(req, res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json(req, res, 500, { ok: false, error: msg });
    }
  });

  function listen(): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, host, () => {
        const addr = server.address();
        listeningPort =
          addr && typeof addr === "object" ? addr.port : configuredPort;
        log("listening", listeningPort, "push", captainPost);
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
    bus,
    listen,
    close,
    get port() {
      return listeningPort;
    },
    host,
  };
}

export type ConsultGateway = ReturnType<typeof createConsultGateway>;
