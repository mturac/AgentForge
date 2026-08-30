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
      const me