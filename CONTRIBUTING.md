# Contributing

Thanks for hacking on AgentForge.

## Setup

```
git clone https://github.com/mturac/AgentForge.git
cd AgentForge
npm ci
npm --prefix web ci
npm run ci
```

Node **≥ 18**.

## Dev loop

```
npm run forge          # API + UI on :18800
npm run forge:web      # Vite HMR for web/ only (API still from forge)
npm test               # vitest
npm run typecheck
```

Forge data lives under `AGENTFORGE_HOME` (e.g. `~/.agentforge`). `OPENTHEBOT_HOME` is still accepted as a legacy alias.

## PRs

1. Branch from `main`
2. Keep changes focused (one concern per PR)
3. `npm run ci` must pass
4. Prefer evidence (tests, curl transcripts, screenshots) for wire/tool behavior
5. Do not commit secrets, `forge-state.json`, or raw captures

## Scope

In scope: AgentForge control plane, wire maps, consult/hop/doctor, console UI, OpenHands-style tools on the shared VM.

Out of scope for this repo: RightStack product code, Consule process skills, MiraView merge gates, Feature Parity scoreboard.

## Style

- TypeScript ESM (`"type": "module"`)
- Fail closed on unknown/bound routes
- No silent provider/model substitution
