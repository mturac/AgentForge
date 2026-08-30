/**
 * OpenAI-compatible hop that applies evidence-backed wire maps before upstream.
 *
 * Better than stock opengrok hop-server.py for this lane:
 *  - applies `applyProviderReasoningControls` (Contract A)
 *  - answers BOTH `/healthz` and `/health` (fixes picker/doctor mismatch)
 *  - streams SSE; never logs Authorization or bodies
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyProviderReasoningControls,
  type HarnessParameter,
} from "../wire-maps.js";

export const DEFAULT_HOP_PORT = 18790;

export type HopOptions = {
  port?: number;
  host?: string;
  upstream?: string;
  apiKey?: string | null;
  log?: (...args: unknown[]) => void;
  /** Test inject: replace upstream fetch. */
  fetchImpl?: typeof fetch;
};

function readBody(req: IncomingMessage, max = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > max) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": payload.length,
  });
  res.end(payload);
}

function writeWithBackpressure(
  res: ServerResponse,
  chunk: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = res.write(chunk, (err) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
      return;
    }
    const onDrain = () => {
      res.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      res.off("drain", onDrain);
      reject(err);
    };
    res.once("drain", onDrain);
    res.once("error", onError);
  });
}

export function createHop(opts: HopOptions = {}) {
  const configuredPort = opts.port ?? DEFAULT_HOP_PORT;
  const host = opts.host ?? "127.0.0.1";
  const upstream = (opts.upstream || "http://127.0.0.1:8642").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.HOP_API_KEY ?? process.env.API_SERVER_KEY ?? null;
  const log = opts.log ?? ((...a: unknown[]) => console.error("[hop]", ...a));
  const fetchImpl = opts.fetchImpl ?? fetch;
  let listeningPort = configuredPort;

  async function probeUpstream(): Promise<boolean> {
    try {
      const r = await fetchImpl(`${upstream}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return r.status < 500;
    } catch {
      try {
        const r = await fetchImpl(`${upstream}/healthz`, {
          signal: AbortSignal.timeout(3000),
        });
        return r.status < 500;
      } catch {
        return false;
      }
    }
  }

  async function health(res: ServerResponse): Promise<void> {
    const up = await probeUpstream();
    json(res, 200, {
      ok: true,
      service: "agentforge-hop",
      port: listeningPort,
      upstream_reachable: up,
    });
  }

  async function relay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "body_too_large") {
        return json(res, 413, { error: "body too large" });
      }
      return json(res, 400, { error: "bad_body" });
    }

    const path = req.url || "/";
    let outBody = body;
    if (
      (req.method === "POST" || req.method === "PUT") &&
      path.includes("/chat/completions") &&
      body.length
    ) {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as Record<
          string,
          unknown
        > & {
          model?: string;
          maxMode?: boolean;
          parameters?: HarnessParameter[];
        };
        const route = applyProviderReasoningControls(parsed, {
          modelId: String(parsed.model || ""),
          baseUrl: upstream,
          maxMode: parsed.maxMode === true,
          parameters: parsed.parameters,
        });
        // Always strip harness-only fields (even when route is "none").
        delete parsed.parameters;
        delete parsed.maxMode;
        outBody = Buffer.from(JSON.stringify(parsed));
        log("wire-map", route, String(parsed.model || ""));
      } catch {
        /* leave body untouched if not JSON */
      }
    }

    const headers: Record<string, string> = {
      "content-type": req.headers["content-type"] || "application/json",
      "accept-encoding": "identity",
      "content-length": String(outBody.length),
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    } else {
      const inbound = req.headers.authorization;
      if (typeof inbound === "string" && inbound.trim()) {
        headers.authorization = inbound;
      }
    }

    let upstreamRes: Response;
    try {
      const init: RequestInit = {
        method: req.method || "GET",
        headers,
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = new Uint8Array(outBody);
      }
      upstreamRes = await fetchImpl(`${upstream}${path}`, init);
    } catch (e) {
      log("upstream unreachable", e instanceof Error ? e.message : e);
      return json(res, 502, {
        error: {
          message: "upstream unreachable",
          type: "hop_error",
        },
      });
    }

    const ctype = upstreamRes.headers.get("content-type") || "";
    if (ctype.includes("text/event-stream")) {
      res.writeHead(upstreamRes.status, {
        "content-type": ctype,
        "cache-control": "no-cache",
        "transfer-encoding": "chunked",
      });
      const reader = upstreamRes.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await writeWithBackpressure(res, Buffer.from(value));
        }
      } catch {
        log("client aborted mid-stream");
      }
      res.end();
      return;
    }

    const payload = Buffer.from(await upstreamRes.arrayBuffer());
    const outHeaders: Record<string, string | number> = {
      "content-length": payload.length,
    };
    if (ctype) outHeaders["content-type"] = ctype;
    const rid =
      upstreamRes.headers.get("x-request-id") ||
      upstreamRes.headers.get("X-Request-Id");
    if (rid) outHeaders["x-request-id"] = rid;
    res.writeHead(upstreamRes.status, outHeaders);
    res.end(payload);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const pathOnly = (req.url || "/").split("?")[0] || "/";
      if (
        req.method === "GET" &&
        (pathOnly === "/healthz" || pathOnly === "/health")
      ) {
        await health(res);
        return;
      }
      await relay(req, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        json(res, 500, { error: msg });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  function listen(): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, host, () => {
        const addr = server.address();
        listeningPort =
          addr && typeof addr === "object" ? addr.port : configuredPort;
        log("listening", `http://${host}:${listeningPort}`, "->", upstream);
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
    listen,
    close,
    get port() {
      return listeningPort;
    },
    host,
    upstream,
  };
}

export type Hop = ReturnType<typeof createHop>;
