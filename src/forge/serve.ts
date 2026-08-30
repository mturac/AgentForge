#!/usr/bin/env node
/**
 * Entry: `npm run forge`
 * Env: FORGE_PORT (18800), FORGE_HOST, AGENTFORGE_HOME (or OPENTHEBOT_HOME)
 */

import { createForgeGateway } from "./gateway.js";

const port = Number(process.env.FORGE_PORT || 18800);
const host = process.env.FORGE_HOST || "127.0.0.1";
const home = process.env.AGENTFORGE_HOME || process.env.OPENTHEBOT_HOME;

const gw = createForgeGateway({ port, host, home });
await gw.listen();
console.log(`agentforge ${gw.port} home=${gw.forge.store.home}`);
