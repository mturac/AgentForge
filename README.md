# AgentForge

Grok Bot–shaped **multi-agent orchestration** on one shared computer.

Persistent named agents. Groups with a command chain. A shared VM workspace. OpenHands-style tools (`execute_bash`, editor, fetch, delegate). Multi-provider LLM routing. Localhost operator console.

[![CI](https://github.com/mturac/AgentForge/actions/workflows/ci.yml/badge.svg)](https://github.com/mturac/AgentForge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f9f6e.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-14201a.svg)](./package.json)

> Experimental **v0.3** · single-operator localhost tool · not multi-tenant SaaS  
> Screens ≠ isolation — see [SECURITY.md](./SECURITY.md)

---

## Screenshots

### Dashboard

![AgentForge dashboard](media/dashboard.png)

### Agent fleet

![Agent fleet cards](media/agents.png)

### Groups & command chain

![Groups](media/groups.png)

### Tools & event stream

![Tool events](media/tool-events.png)

### Shared VM

![Shared VM](media/shared-vm.png)

---

## Quick start

```bash
git clone https://github.com/mturac/AgentForge.git
cd AgentForge
npm ci
npm --prefix web ci
npm run build
AGENTFORGE_HOME=~/.agentforge npm run forge
```

Open **http://127.0.0.1:18800/**

1. Click **Seed demo team** (or `POST /setup/seed`)
2. Open **Atlas** (or any agent)
3. Try:

```text
list files
write notes/hello.md with shipped from AgentForge
```

You should see bash/editor output in chat and a **Tool events** stream on the right.

```bash
npm run ci          # typecheck + build + tests
npm run consult     # handoff bus :18795
npm run hop         # wire-map hop :18790
npm run doctor      # update tripwire
```

---

## What you get

| Piece | What it does |
| --- | --- |
| **Agents** | Persistent bots with role contracts, memory, provider binding, VM screen |
| **Groups** | 2–6 member teams; orchestrator routes chat to specialists |
| **Shared VM** | `$AGENTFORGE_HOME/vm/workspace` + shared memory + screen traces |
| **Tools** | `execute_bash` · `str_replace_editor` · `think` · `finish` · `fetch` · `browser` (stub) · `delegate` |
| **Event stream** | Action / observation / thought / finish per agent (`GET /agents/:id/events`) |
| **Providers** | mock · zai · claude · openai · openrouter · opencode |
| **Skills / routines / guardrails** | Durable instructions, schedules, approval queue |
| **Console** | React UI served from the forge gateway |
| **Wire truth** | Evidence-backed provider harness maps + doctor/hop/consult |

Optional remote OpenHands Agent Server: set `OPENHANDS_URL` (and optional `OPENHANDS_API_KEY`). Fail-soft if unset.

---

## Architecture (short)

```text
Browser ──► Forge gateway :18800 ──► AgentForge core
                 │                      ├ agents / groups / chat
                 │                      ├ tools + event stream
                 │                      ├ providers (LLM)
                 │                      └ shared VM workspace
                 └── serves web/dist (operator console)

Consult :18795   Hop :18790   Doctor CLI
```

Laws this repo refuses to break:

1. **Evidence or no ship**
2. **HTTP 200 ≠ honored**
3. **Fail closed**
4. **Silence is not cheap**
5. **Approvals for ask/irreversible**

---

## Security (read this)

- Forge binds to **127.0.0.1** by default
- Tools run as the forge OS user against the shared workspace
- Deny-list ≠ Docker sandbox
- Do **not** expose ports to the internet without your own auth/TLS/sandbox

Details: [SECURITY.md](./SECURITY.md)

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `npm run ci` must pass.

---

## License

MIT © Mehmet Turac — see [LICENSE](./LICENSE).

Wire-map / consult lineage: [NOTICE](./NOTICE).
