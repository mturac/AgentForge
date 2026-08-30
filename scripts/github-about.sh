#!/usr/bin/env bash
# One-shot GitHub About / topics for AgentForge (needs repo admin).
set -euo pipefail
REPO="${1:-mturac/AgentForge}"

gh repo edit "$REPO" \
  --description "AgentForge — Grok Bot–shaped multi-agent orchestration on a shared VM" \
  --homepage "https://github.com/${REPO}" \
  --add-topic agentforge \
  --add-topic multi-agent \
  --add-topic ai-agents \
  --add-topic orchestration \
  --add-topic typescript \
  --add-topic llm \
  --add-topic openhands \
  --add-topic shared-vm \
  --add-topic mit-license

gh api -X PUT "repos/${REPO}/topics" \
  -H "Accept: application/vnd.github.mercy-preview+json" \
  -f names[]=agentforge \
  -f names[]=multi-agent \
  -f names[]=ai-agents \
  -f names[]=orchestration \
  -f names[]=typescript \
  -f names[]=llm \
  -f names[]=openhands \
  -f names[]=shared-vm \
  -f names[]=mit-license \
  >/dev/null

echo "OK — check https://github.com/${REPO}"
