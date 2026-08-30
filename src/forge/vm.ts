/**
 * Shared member-scoped VM — one workspace for all bots.
 * Screens are work surfaces, not security boundaries.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { ForgeStore } from "./store.js";
import { pushAudit } from "./store.js";
import {
  SCREEN_LINE_CAP,
  type ScreenLine,
  type VmFileMeta,
} from "./types.js";

function workspaceRoot(home: string): string {
  return join(home, "vm", "workspace");
}

function safeRelPath(p: string): string {
  const raw = String(p || "").replace(/^\/+/, "").trim();
  if (!raw) throw new Error("missing_path");
  if (raw.includes("\0")) throw new Error("invalid_path");
  const norm = normalize(raw);
  if (norm.startsWith("..") || norm.split(sep).includes("..")) {
    throw new Error("path_escape");
  }
  return norm;
}

export function createVmApi(store: ForgeStore) {
  const root = workspaceRoot(store.home);

  function ensure(): void {
    mkdirSync(root, { recursive: true });
  }

  function abs(rel: string): string {
    const safe = safeRelPath(rel);
    const full = join(root, safe);
    const relBack = relative(root, full);
    if (relBack.startsWith("..") || relBack === "") {
      if (relBack === "" || relBack === ".") {
        /* listing root ok */
      } else if (relBack.startsWith("..")) {
        throw new Error("path_escape");
      }
    }
    if (!full.startsWith(root)) throw new Error("path_escape");
    return full;
  }

  function listFiles(dir = ""): VmFileMeta[] {
    ensure();
    const base = dir ? abs(dir) : root;
    if (!existsSync(base)) return [];
    const out: VmFileMeta[] = [];
    const walk = (d: string, prefix: string) => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const st = statSync(full);
        if (st.isDirectory()) walk(full, rel);
        else out.push({ path: rel, bytes: st.size, updatedAt: st.mtimeMs });
      }
    };
    walk(base, dir ? safeRelPath(dir) : "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  function readFile(path: string): { path: string; content: string } {
    const full = abs(path);
    if (!existsSync(full)) throw new Error("file_not_found");
    return {
      path: safeRelPath(path),
      content: readFileSync(full, "utf8"),
    };
  }

  function writeFile(
    path: string,
    content: string,
    actorId: string,
  ): VmFileMeta {
    ensure();
    const safe = safeRelPath(path);
    const full = abs(safe);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, String(content ?? ""), { mode: 0o600 });
    const st = statSync(full);
    store.update((state) => {
      pushAudit(state, "vm.write", actorId, { path: safe, bytes: st.size });
      appendScreen(state, actorId, "vm.write", `wrote ${safe} (${st.size}b)`);
    });
    return { path: safe, bytes: st.size, updatedAt: st.mtimeMs };
  }

  function removeFile(path: string, actorId: string): void {
    const full = abs(path);
    if (!existsSync(full)) throw new Error("file_not_found");
    unlinkSync(full);
    store.update((state) => {
      pushAudit(state, "vm.delete", actorId, { path: safeRelPath(path) });
    });
  }

  function getMemory(): Record<string, string> {
    return { ...store.load().vmMemory };
  }

  function setMemory(key: string, value: string, actorId: string): void {
    const k = String(key || "").trim();
    if (!k) throw new Error("missing_key");
    store.update((state) => {
      state.vmMemory[k] = String(value ?? "");
      pushAudit(state, "vm.memory", actorId, { key: k });
      appendScreen(state, actorId, "vm.memory", `memory[${k}]=${String(value).slice(0, 80)}`);
    });
  }

  function deleteMemory(key: string, actorId: string): void {
    store.update((state) => {
      delete state.vmMemory[key];
      pushAudit(state, "vm.memory.delete", actorId, { key });
    });
  }

  function getScreen(agentId: string): ScreenLine[] {
    return [...(store.load().screens[agentId] || [])];
  }

  function pushScreen(agentId: string, kind: string, text: string): void {
    store.update((state) => {
      appendScreen(state, agentId, kind, text);
    });
  }

  return {
    root,
    listFiles,
    readFile,
    writeFile,
    removeFile,
    getMemory,
    setMemory,
    deleteMemory,
    getScreen,
    pushScreen,
  };
}

function appendScreen(
  state: {
    screens: Record<string, ScreenLine[]>;
  },
  agentId: string,
  kind: string,
  text: string,
): void {
  if (!agentId) return;
  const lines = state.screens[agentId] || (state.screens[agentId] = []);
  lines.push({ at: Date.now(), kind, text: String(text).slice(0, 2000) });
  if (lines.length > SCREEN_LINE_CAP) {
    state.screens[agentId] = lines.slice(-SCREEN_LINE_CAP);
  }
}

export type VmApi = ReturnType<typeof createVmApi>;
