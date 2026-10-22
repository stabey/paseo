import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { PaseoConfigSchema } from "@getpaseo/protocol/paseo-config-schema";

import { readPaseoConfigJson, resolvePaseoConfigPath } from "./paseo-config-file.js";

/**
 * Untracked material a new worktree needs from the source checkout, declared in `paseo.json`:
 *
 * - `worktree.include`: paths copied into the worktree (`.env`, local certificates).
 *   Existing files in the worktree win, so tracked files are never overwritten.
 * - `worktree.linkDirectories`: directories symlinked back to the source checkout
 *   (`node_modules`, build caches). The target must already exist in the worktree-free form:
 *   the entry is skipped when the worktree already has something at that path.
 *
 * Entries are relative to the checkout root and may not escape it. Runs after `git worktree add`
 * and before setup commands, so setup can rely on the material being there.
 */

export interface WorktreeIncludesPlan {
  include: string[];
  linkDirectories: string[];
}

export interface AppliedWorktreeIncludes {
  copied: string[];
  linked: string[];
  skipped: string[];
}

export function readWorktreeIncludesPlan(sourceRoot: string): WorktreeIncludesPlan {
  let worktree: { include?: unknown; linkDirectories?: unknown } | undefined;
  try {
    const json = readPaseoConfigJson(sourceRoot);
    worktree = json === null ? undefined : PaseoConfigSchema.parse(json).worktree;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse paseo.json at ${resolvePaseoConfigPath(sourceRoot)}: ${detail}`,
      {
        cause: error,
      },
    );
  }
  return {
    include: normalizeEntries(worktree?.include),
    linkDirectories: normalizeEntries(worktree?.linkDirectories),
  };
}

export async function applyWorktreeIncludes(input: {
  sourceRoot: string;
  worktreePath: string;
  plan?: WorktreeIncludesPlan;
}): Promise<AppliedWorktreeIncludes> {
  const plan = input.plan ?? readWorktreeIncludesPlan(input.sourceRoot);
  const applied: AppliedWorktreeIncludes = { copied: [], linked: [], skipped: [] };

  for (const entry of plan.include) {
    const source = resolveInside(input.sourceRoot, entry);
    const target = resolveInside(input.worktreePath, entry);
    if (!(await exists(source))) {
      applied.skipped.push(entry);
      continue;
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
    applied.copied.push(entry);
  }

  for (const entry of plan.linkDirectories) {
    const source = resolveInside(input.sourceRoot, entry);
    const target = resolveInside(input.worktreePath, entry);
    if (!(await isDirectory(source)) || (await exists(target))) {
      applied.skipped.push(entry);
      continue;
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    applied.linked.push(entry);
  }

  return applied;
}

function normalizeEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length > 0) entries.push(trimmed);
  }
  return entries;
}

function resolveInside(root: string, entry: string): string {
  if (isAbsolute(entry)) {
    throw new Error(`paseo.json worktree entry must be relative: ${entry}`);
  }
  const target = normalize(join(root, entry));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`paseo.json worktree entry escapes the checkout: ${entry}`);
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}
