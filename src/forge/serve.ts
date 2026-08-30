#!/usr/bin/env node
/** Entry: `npm run forge` */

import { createForgeGateway } from "./gateway.js";

const port = Number(process.env.FORGE_PORT || 18800);
const gw = createForgeGateway({ port });
await gw.listen();
console.log(`agentforge ${port}`);
