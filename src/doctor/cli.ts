#!/usr/bin/env node
/**
 * CLI: `npm run doctor` / `node dist/doctor/cli.js [--init|--quiet|--json]`
 */

import { resolve } from "node:path";
import { resolveDoctorConfig, runDoctor } from "./index.js";

const args = new Set(process.argv.slice(2));
const repoRoot = resolve(
  process.env.AGENTFORGE_ROOT || process.env.OPENTHEBOT_ROOT || process.cwd(),
);
const cfg = resolveDoctorConfig(repoRoot);
const report = await runDoctor(cfg, {
  init: args.has("--init"),
  quiet: args.has("--quiet"),
  json: args.has("--json"),
});
if (report.human) console.log(report.human);
process.exit(report.exitCode);
