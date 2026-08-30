import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";

import { createConsultBus } from "../src/consult/bus.js";
import { createConsultGateway } from "../src/consult/gateway.js";

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
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text || "{}") as Record<string, unknown>,
          });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.end(payload);
    else r.end();
  });
}

describe("consult bus", () => {
  it("dedupes matching fingerprint; busy on different question", () => {
    const bus = createConsultBus();
    const a = bus.start({ question: "top news", agent_id: "fast" });
    expect(a.ok).toBe(true);
    expect(a.duplicate).toBe(false);
    const b = bus.start({ question: "top news", agent_id: "fast" });
    expect(b.ok).toBe(true);
    expect(b.duplicate).toBe(true);
    expect(b.consult_id).toBe(a.consult_id);
    const c = bus.start({ question: "other q", agent_id: "fast" });
    expect(c.ok).toBe(false);
    expect(c.error).toBe("busy");
  });

  it("rejects empty question", () => {
    const bus = createConsultBus();
    const bad = bus.start({ question: "   " });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("missing_question");
  });

  it("requires text on completed and clears open slot; status returns text", () => {
    const bus = createConsultBus();
    const a = bus.start({ question: "q" });
    const bad = bus.ping({
      consult_id: a.consult_id,
      status: "completed",
    });
    expect(bad.ok).toBe(false);
    const ok = bus.ping({
      consult_id: a.consult_id,
      status: "completed",
      text: "answer",
    });
    expect(ok.ok).toBe(true);
    expect(bus.open()).toBeNull();
    const snap = bus.get(a.consult_id!);
    expect(snap?.text).toBe("answer");
    expect(snap?.status).toBe("completed");
  });

  it("rejects unknown consult_id instead of falling back", () => {
    const bus = createConsultBus();
    bus.start({ question: "open one" });
    const bad = bus.ping({
      consult_id: "c_does_not_exist",
      status: "completed",
      text: "nope",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("unknown_consult_id");
  });
});

describe("consult gateway", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("health + start + complete with captain push; retry after push fail", async () => {
    let failOnce = true;
    const pushed: Record<string, unknown>[] = [];
    const gw = createConsultGateway({
      port: 0,
      captainPost: "http://127.0.0.1:9/unused",
      log: () => {},
      pushCaptain: async (p) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("captain_timeout");
        }
        pushed.push(p);
        return { status: 200, body: "ok" };
      },
    });
    const listened = await gw.listen();
    expect(listened.port).toBeGreaterThan(0);
    close = () => gw.close();
    const port = listened.port;

    const health = await req(port, "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.json.ok).toBe(true);
    expect(health.json.service).toBe("consult-gateway");
    expect(health.json.port).toBe(port);

    const start = await req(port, "POST", "/consult", {
      question: "ping",
      agent: "Fast",
      agent_id: "a1",
    });
    expect(start.status).toBe(200);
    expect(start.json.ok).toBe(true);
    const id = start.json.consult_id as string;

    const failPush = await req(port, "POST", "/consult/complete", {
      consult_id: id,
      text: "pong",
    });
    expect(failPush.status).toBe(200);
    expect(failPush.json.pushed).toBe(false);
    expect(pushed).toHaveLength(0);

    const retry = await req(port, "POST", "/consult/complete", {
      consult_id: id,
      text: "pong",
    });
    expect(retry.status).toBe(200);
    expect(retry.json.pushed).toBe(true);
    expect(retry.json.delivered).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.answer).toBe("pong");

    const status = await req(port, "GET", `/consult/status?id=${id}`);
    expect(status.json.consult).toMatchObject({
      status: "completed",
      text: "pong",
      delivered: true,
    });
  });
});
