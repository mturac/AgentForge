#!/usr/bin/env node
/**
 * Entry: `npm run hop`
 * Env: HOP_PORT (18790), HOP_HOST, HOP_UPSTREAM, HOP_API_KEY / API_SERVER_KEY
 */

import { createHop } from "./index.js";

const port = Number(process.env.HOP_PORT || 18790);
const host = process.env.HOP_HOST || "127.0.0.1";
const upstream = process.env.HOP_UPSTREAM || "http://127.0.0.1:8642";

const hop = createHop({ port, host, upstream });
await hop.listen();
console.log(`agentforge-hop ${hop.port} -> ${upstream}`);
