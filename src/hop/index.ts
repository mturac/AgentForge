import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type HopProvider = "codex" | "claude" | "gemini" | "opencode";

export type HopRunRequest = {
  from: HopProvider;
  to: HopProvider;
  prompt: string;
  context?: string;
};

export type HopArtifact = {
  id: string;
  createdAt: string;
  request: HopRunRequest;
  fromOutput: string;
  handoffPrompt: string;
  toOutput: string;
  status: "completed" | "failed";
  error?: string;
};

export type HopCliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

type SpawnFn = (command: string, args: string[], options: { cwd?: string }) => Promise<HopCliResult>;

const DEFAULT_ROOT = path.join(process.cwd(), ".agentforge", "hop");

function artifactPath(root: string, id: string): string {
  return path.join(root, `${id}.json`);
}

export function buildHandoffPrompt(input: {
  from: HopProvider;
  to: HopProvider;
  originalPrompt: string;
  context?: string;
  priorOutput: string;
}): string {
  const contextBlock = input.context?.trim()
    ? `\nShared context:\n${input.context.trim()}\n`
    : "";
  return [
    `You are continuing a handoff from ${input.from} to ${input.to}.`,
    "Treat the prior output as draft work to refine, not as final truth.",
    "Preserve useful structure, correct mistakes, and produce the best next version.",
    "",
    `Original prompt:\n${input.originalPrompt.trim()}`,
    contextBlock,
    `Prior ${input.from} output:\n${input.priorOutput.trim()}`,
    "",
    `Now produce the improved ${input.to} result.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function providerCommand(provider: HopProvider): { command: string; argsPrefix: string[] } {
  switch (provider) {
    case "codex":
      return { command: "codex", argsPrefix: ["exec", "--skip-git-repo-check"] };
    case "claude":
      return { command: "claude", argsPrefix: ["-p"] };
    case "gemini":
      return { command: "gemini", argsPrefix: ["--prompt"] };
    case "opencode":
      return { command: "opencode", argsPrefix: ["run"] };
  }
}

export async function runProviderPrompt(input: {
  provider: HopProvider;
  prompt: string;
  cwd?: string;
  spawn: SpawnFn;
}): Promise<HopCliResult> {
  const spec = providerCommand(input.provider);
  return input.spawn(spec.command, [...spec.argsPrefix, input.prompt], { cwd: input.cwd });
}

export async function runHop(input: {
  request: HopRunRequest;
  cwd?: string;
  rootDir?: string;
  spawn: SpawnFn;
  now?: () => Date;
  id?: () => string;
}): Promise<HopArtifact> {
  const root = input.rootDir ?? DEFAULT_ROOT;
  await mkdir(root, { recursive: true });
  const id = input.id?.() ?? randomUUID();
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const request: HopRunRequest = {
    from: input.request.from,
    to: input.request.to,
    prompt: input.request.prompt.trim(),
    context: input.request.context?.trim() || undefined,
  };

  if (!request.prompt) {
    const failed: HopArtifact = {
      id,
      createdAt,
      request,
      fromOutput: "",
      handoffPrompt: "",
      toOutput: "",
      status: "failed",
      error: "prompt is required",
    };
    await writeFile(artifactPath(root, id), `${JSON.stringify(failed, null, 2)}\n`, "utf8");
    return failed;
  }

  if (request.from === request.to) {
    const failed: HopArtifact = {
      id,
      createdAt,
      request,
      fromOutput: "",
      handoffPrompt: "",
      toOutput: "",
      status: "failed",
      error: "from and to providers must differ",
    };
    await writeFile(artifactPath(root, id), `${JSON.stringify(failed, null, 2)}\n`, "utf8");
    return failed;
  }

  const fromResult = await runProviderPrompt({
    provider: request.from,
    prompt: request.prompt,
    cwd: input.cwd,
    spawn: input.spawn,
  });
  if (!fromResult.ok) {
    const failed: HopArtifact = {
      id,
      createdAt,
      request,
      fromOutput: fromResult.stdout,
      handoffPrompt: "",
      toOutput: "",
      status: "failed",
      error: fromResult.stderr || `${request.from} failed with code ${fromResult.code ?? "unknown"}`,
    };
    await writeFile(artifactPath(root, id), `${JSON.stringify(failed, null, 2)}\n`, "utf8");
    return failed;
  }

  const handoffPrompt = buildHandoffPrompt({
    from: request.from,
    to: request.to,
    originalPrompt: request.prompt,
    context: request.context,
    priorOutput: fromResult.stdout,
  });
  const toResult = await runProviderPrompt({
    provider: request.to,
    prompt: handoffPrompt,
    cwd: input.cwd,
    spawn: input.spawn,
  });

  const artifact: HopArtifact = {
    id,
    createdAt,
    request,
    fromOutput: fromResult.stdout,
    handoffPrompt,
    toOutput: toResult.stdout,
    status: toResult.ok ? "completed" : "failed",
    error: toResult.ok
      ? undefined
      : toResult.stderr || `${request.to} failed with code ${toResult.code ?? "unknown"}`,
  };
  await writeFile(artifactPath(root, id), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export async function listHopArtifacts(rootDir = DEFAULT_ROOT): Promise<HopArtifact[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(rootDir);
    const artifacts: HopArtifact[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await readFile(path.join(rootDir, entry), "utf8");
      artifacts.push(JSON.parse(raw) as HopArtifact);
    }
    return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function readHopArtifact(id: string, rootDir = DEFAULT_ROOT): Promise<HopArtifact | null> {
  try {
    const raw = await readFile(artifactPath(rootDir, id), "utf8");
    return JSON.parse(raw) as HopArtifact;
  } catch {
    return null;
  }
}

export function hopFingerprint(artifact: HopArtifact): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        from: artifact.request.from,
        to: artifact.request.to,
        prompt: artifact.request.prompt,
        context: artifact.request.context ?? "",
        fromOutput: artifact.fromOutput,
        toOutput: artifact.toOutput,
        status: artifact.status,
      }),
    )
    .digest("hex");
}
