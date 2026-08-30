# Security

AgentForge is a **localhost operator tool**, not a hardened multi-user service.

## Threat model (current)

| Assumption | Implication |
| --- | --- |
| Single trusted operator | Forge binds to `127.0.0.1` by default |
| Shared account-scoped VM | Agent screens ≠ isolation; any bot can see shared workspace files |
| Tools run as the forge process user | `execute_bash` / editor touch the real workspace under `AGENTFORGE_HOME` |
| Provider API keys in forge-state | Stored locally (`0600`); never commit `forge-state.json` or `.env` |
| Deny-list, not sandbox | Dangerous bash patterns are blocked; this is not Docker isolation |

Do **not** expose `:18800` / `:18795` / `:18790` to the public internet without your own auth, TLS, and sandboxing.

For stronger isolation, point `OPENHANDS_URL` at a remote OpenHands Agent Server
(optional; fail-soft if unset).

## Reporting

If you find a vulnerability, open a private security advisory on the GitHub repo (or email the maintainer listed on the profile) **before** a public issue. Please include:

- Affected surface (`forge` / `consult` / `hop` / `web`)
- Repro steps
- Impact (RCE, key leak, cross-agent data read, etc.)

## Maintainer hygiene

- Keep `forge-state.json`, `.env*`, and `wire-captures/**/raw/` out of git (see `.gitignore`)
- Rotate any key that was ever pasted into chat or logged
- Prefer mock provider in tests; never commit live credentials
