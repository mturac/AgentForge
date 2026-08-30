#!/usr/bin/env node
/**
 * Entry: `npm run consult` → localhost consult gateway (default :18795).
 * Localhost Agent↔agent Consult bus (default :18795).
 */

import { createConsultGateway } from "./gateway.js";

const port = Number(process.env.CONSULT_GW_PORT || 18795);
const captain =
  process.env.CONSULT_CAPTAIN_POST === ""
    ? null
    : process.env.CONSULT_CAPTAIN_POST ||
      "http://127.0.0.1:18793/consult.result";

const gw = createConsultGateway({
  port,
  captainPost: captain,
});

await gw.listen();
console.log(`consult-gateway ${port}`);
