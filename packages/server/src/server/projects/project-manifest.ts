import pLimit from "p-limit";
import type { ProjectManifest, ProjectRepoPayload } from "@getpaseo/protocol/messages";

import { READ_ONLY_GIT_ENV } from "../checkout-git-utils.js";
import { createRunGitCommand, type RunGitCommand } from "../../utils/run-git-command.js";

/**
 * The project manifest: the catalog's repositories and checkouts plus, per checkout, the last
 * commit and the size of the uncommitted change. Built on request, never cached: it exists to
 * be handed to an agent as context, and stale numbers there are worse than a slower call.
 *
 * Every checkout costs three read-only git calls, run a few at a time so a project with many
 * worktrees does not starve the daemon's git queue.
 */

type ManifestRepo = ProjectManifest["repos"][number];
type ManifestCheckout = ManifestRepo["checkouts"][number];

const CHECKOUT_CONCURRENCY = 4;
const GIT_TIMEOUT_MS = 10_000;

export async function buildProjectManifest(input: {
  projectId: string;
  rootPath: string;
  repos: readonly ProjectRepoPayload[];
  now?: () => Date;
  runGit?: RunGitCommand;
}): Promise<ProjectManifest> {
  const runGit = input.runGit ?? createRunGitCommand("project-manifest");
  const limit = pLimit(CHECKOUT_CONCURRENCY);
  const repos = await Promise.all(
    input.repos
      .filter((repo) => repo.role !== "hidden")
      .map(
        async (repo): Promise<ManifestRepo> => ({
          relPath: repo.relPath,
          rootPath: repo.rootPath,
          role: repo.role,
          checkouts: await Promise.all(
            repo.checkouts
              .filter((checkout) => !checkout.bare)
              .map((checkout) =>
                limit(
                  async (): Promise<ManifestCheckout> => ({
                    path: checkout.path,
                    branch: checkout.branch,
                    isMain: checkout.isMain,
                    managed: checkout.managed,
                    lastCommit: await readLastCommit(runGit, checkout.path),
                    uncommitted: await readUncommitted(runGit, checkout.path),
                  }),
                ),
              ),
          ),
        }),
      ),
  );
  return {
    projectId: input.projectId,
    rootPath: input.rootPath,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    repos,
  };
}

async function git(runGit: RunGitCommand, cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(args, {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
      timeout: GIT_TIMEOUT_MS,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

async function readLastCommit(
  runGit: RunGitCommand,
  cwd: string,
): Promise<ManifestCheckout["lastCommit"]> {
  const stdout = await git(runGit, cwd, ["log", "-1", "--format=%H%x00%s%x00%cI"]);
  const [sha, subject, committedAt] = (stdout ?? "").trim().split("\0");
  if (!sha || subject === undefined || !committedAt) return null;
  return { sha, subject, committedAt };
}

async function readUncommitted(
  runGit: RunGitCommand,
  cwd: string,
): Promise<ManifestCheckout["uncommitted"]> {
  const status = await git(runGit, cwd, ["status", "--porcelain"]);
  if (status === null) return null;
  const files = status.split("\n").filter((line) => line.trim().length > 0).length;
  if (files === 0) return { files: 0, insertions: 0, deletions: 0 };
  // Untracked files count toward `files` only; a repository without commits has no HEAD to diff.
  const shortstat = (await git(runGit, cwd, ["diff", "HEAD", "--shortstat"])) ?? "";
  return {
    files,
    insertions: matchCount(shortstat, /(\d+) insertions?\(\+\)/),
    deletions: matchCount(shortstat, /(\d+) deletions?\(-\)/),
  };
}

function matchCount(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : 0;
}
