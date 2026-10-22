import { promises as fs } from "node:fs";
import path from "node:path";

import { runGitCommand } from "../../utils/run-git-command.js";
import { deriveWorktreeProjectHash, getGitCommonDir } from "../../utils/worktree.js";
import { readPaseoWorktreeMetadata } from "../../utils/worktree-metadata.js";
import { areEquivalentPaths } from "../../utils/path.js";

/**
 * Repository discovery for a project folder.
 *
 * A project root is a plain folder. It may itself be a repository and may contain any number of
 * independent repositories at any depth. Discovery walks the folder, stops at every `.git`
 * boundary, and asks git for the checkouts of each repository found. Checkouts can live anywhere,
 * including outside the project folder.
 *
 * Membership rules that are not obvious from the walk:
 * - A `.git` *file* marks a linked worktree or a submodule. Neither is a repository of its own, so
 *   the walk neither records nor descends into it. A linked worktree is still reported, through the
 *   `git worktree list` of the main checkout when that checkout is part of the project.
 * - Paseo-managed worktree folders can sit physically inside a project root (a daemon home under
 *   the project folder is the common case). They belong to whichever project created them, so the
 *   caller passes them as `excludeRoots`.
 * - Symlinked directories are not followed.
 */

export const DEFAULT_REPO_DISCOVERY_IGNORE = [
  "node_modules",
  ".git",
  ".cache",
  ".dev",
  "dist",
  "build",
  "cache",
  "data",
  "backups",
  "tmp",
] as const;

export const DEFAULT_REPO_DISCOVERY_MAX_DEPTH = 4;

export interface DiscoveredCheckout {
  /** Absolute path of the working tree. */
  path: string;
  branch: string | null;
  head: string | null;
  /** The first entry of `git worktree list`: the main checkout (or bare repository). */
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  /** Whether the checkout lives under the project root. */
  insideProject: boolean;
  /**
   * Whether Paseo's metadata record exists for the checkout. Paseo writes it for every worktree
   * it creates or adopts, wherever that worktree lives; plain `git worktree add` never does.
   */
  paseoMetadata: boolean;
}

export type ParsedCheckout = Omit<DiscoveredCheckout, "paseoMetadata">;

export interface DiscoveredRepo {
  /** Path relative to the project root, `.` when the root itself is the repository. */
  relPath: string;
  rootPath: string;
  commonDir: string;
  /** Same hash Paseo uses to group managed worktrees for this repository. */
  commonDirHash: string;
  checkouts: DiscoveredCheckout[];
}

export interface RepoDiscoveryOptions {
  rootPath: string;
  /** Directory names skipped at every level. Defaults to {@link DEFAULT_REPO_DISCOVERY_IGNORE}. */
  ignore?: readonly string[];
  /** Absolute directories never entered, such as the managed worktrees root. */
  excludeRoots?: readonly string[];
  maxDepth?: number;
  /** Repositories to include even when the walk does not reach them (relative to rootPath). */
  pinnedRelPaths?: readonly string[];
}

export interface RepoDiscoveryResult {
  rootPath: string;
  repos: DiscoveredRepo[];
  scannedAt: string;
}

export async function discoverRepos(options: RepoDiscoveryOptions): Promise<RepoDiscoveryResult> {
  const rootPath = path.resolve(options.rootPath);
  const ignore = new Set(options.ignore ?? DEFAULT_REPO_DISCOVERY_IGNORE);
  const excludeRoots = (options.excludeRoots ?? []).map((entry) => path.resolve(entry));
  const maxDepth = options.maxDepth ?? DEFAULT_REPO_DISCOVERY_MAX_DEPTH;

  const repoRoots: string[] = [];
  await walk({
    directory: rootPath,
    depth: 0,
    rootPath,
    ignore,
    excludeRoots,
    maxDepth,
    repoRoots,
  });

  for (const relPath of options.pinnedRelPaths ?? []) {
    const pinnedRoot = path.resolve(rootPath, relPath);
    if (repoRoots.some((entry) => areEquivalentPaths(entry, pinnedRoot))) continue;
    if (await isGitDirectory(path.join(pinnedRoot, ".git"))) repoRoots.push(pinnedRoot);
  }

  const repos = await Promise.all(
    repoRoots.map((repoRoot) => describeRepo({ repoRoot, rootPath })),
  );
  repos.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return { rootPath, repos, scannedAt: new Date().toISOString() };
}

interface WalkState {
  directory: string;
  depth: number;
  rootPath: string;
  ignore: Set<string>;
  excludeRoots: string[];
  maxDepth: number;
  repoRoots: string[];
}

async function walk(state: WalkState): Promise<void> {
  const { directory } = state;
  if (isUnderAny(directory, state.excludeRoots)) return;

  const gitEntry = path.join(directory, ".git");
  const gitKind = await classifyGitEntry(gitEntry);
  if (gitKind === "directory") {
    state.repoRoots.push(directory);
    // Repositories nested inside a repository (vendored checkouts, plugin repos) are still
    // independent repositories: keep walking below a repo root, just never into `.git`.
  } else if (gitKind === "file") {
    // Linked worktree or submodule. Reported through its main checkout when applicable.
    return;
  }

  if (state.depth >= state.maxDepth) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (state.ignore.has(entry.name)) continue;
    await walk({ ...state, directory: path.join(directory, entry.name), depth: state.depth + 1 });
  }
}

async function classifyGitEntry(gitEntry: string): Promise<"directory" | "file" | "none"> {
  try {
    const stat = await fs.lstat(gitEntry);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "none";
  } catch {
    return "none";
  }
}

async function isGitDirectory(gitEntry: string): Promise<boolean> {
  return (await classifyGitEntry(gitEntry)) === "directory";
}

function isUnderAny(directory: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, directory);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

async function describeRepo(input: {
  repoRoot: string;
  rootPath: string;
}): Promise<DiscoveredRepo> {
  const [commonDir, commonDirHash, checkouts] = await Promise.all([
    getGitCommonDir(input.repoRoot),
    deriveWorktreeProjectHash(input.repoRoot),
    listCheckouts(input.repoRoot, input.rootPath),
  ]);
  const relative = path.relative(input.rootPath, input.repoRoot);
  return {
    relPath: relative === "" ? "." : relative.split(path.sep).join("/"),
    rootPath: input.repoRoot,
    commonDir,
    commonDirHash,
    checkouts,
  };
}

export async function listCheckouts(
  repoRoot: string,
  projectRoot: string,
): Promise<DiscoveredCheckout[]> {
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
  });
  const checkouts: DiscoveredCheckout[] = [];
  for (const checkout of parseWorktreeList(stdout, projectRoot)) {
    checkouts.push(
      Object.assign(checkout, {
        paseoMetadata:
          !checkout.isMain && !checkout.bare && hasPaseoWorktreeMetadata(checkout.path),
      }),
    );
  }
  return checkouts;
}

function hasPaseoWorktreeMetadata(worktreePath: string): boolean {
  try {
    return readPaseoWorktreeMetadata(worktreePath) !== null;
  } catch {
    return false;
  }
}

/** Parses `git worktree list --porcelain`. Exported for tests. */
export function parseWorktreeList(stdout: string, projectRoot: string): ParsedCheckout[] {
  const checkouts: ParsedCheckout[] = [];
  let current: Partial<ParsedCheckout> | null = null;
  const flush = () => {
    if (!current?.path) return;
    checkouts.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      isMain: checkouts.length === 0,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      insideProject: isUnderAny(current.path, [projectRoot]),
    });
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: path.resolve(line.slice("worktree ".length)) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch "))
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
  }
  flush();
  return checkouts;
}
