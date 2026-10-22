import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type {
  PersistedProjectRecord,
  PersistedProjectRepoSettings,
  ProjectRegistry,
} from "../workspace-registry.js";
import { resolvePaseoWorktreesBaseRoot } from "../../utils/worktree.js";
import { areEquivalentPaths } from "../../utils/path.js";
import { discoverRepos, type DiscoveredRepo } from "./repo-discovery.js";

/**
 * Daemon-wide cache of repositories per project folder.
 *
 * Discovery is slow enough (one git invocation per repository) that project descriptors read from
 * this cache instead of scanning. The cache persists under `<paseoHome>/projects/` so a restarted
 * daemon serves the last known tree before its first rescan completes. A rescan runs when a project
 * is added, when its root path or repo settings change, and on explicit refresh.
 */

const CachedCheckoutSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  detached: z.boolean(),
  bare: z.boolean(),
  insideProject: z.boolean(),
});

const CachedRepoSchema = z.object({
  relPath: z.string(),
  rootPath: z.string(),
  commonDir: z.string(),
  commonDirHash: z.string(),
  checkouts: z.array(CachedCheckoutSchema),
});

const CachedCatalogSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  scannedAt: z.string(),
  repos: z.array(CachedRepoSchema),
});

type CachedCatalog = z.infer<typeof CachedCatalogSchema>;

export interface ProjectReposSnapshot {
  repos: ProjectRepoPayload[];
  scannedAt: string;
}

export interface ProjectRepoCatalogOptions {
  paseoHome: string;
  worktreesRoot?: string;
  projectRegistry: ProjectRegistry;
  logger: Logger;
  /** Called after a scan changes what a project's descriptor would show. */
  onChanged?: (project: PersistedProjectRecord) => void;
  /** Test seam. */
  discover?: typeof discoverRepos;
}

export class ProjectRepoCatalog {
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly cache = new Map<string, CachedCatalog>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly excludeRoots: string[];
  private readonly discover: typeof discoverRepos;
  private unsubscribe: (() => void) | null = null;
  private loaded: Promise<void> | null = null;

  constructor(private readonly options: ProjectRepoCatalogOptions) {
    this.directory = path.join(options.paseoHome, "projects");
    this.logger = options.logger.child({ module: "project-repo-catalog" });
    this.excludeRoots = [
      resolvePaseoWorktreesBaseRoot({
        paseoHome: options.paseoHome,
        worktreesRoot: options.worktreesRoot,
      }),
      path.join(options.paseoHome, "worktrees"),
    ];
    this.discover = options.discover ?? discoverRepos;
  }

  async start(): Promise<void> {
    await this.load();
    this.unsubscribe =
      this.options.projectRegistry.subscribeToMutations?.((mutation) => {
        if (mutation.kind === "upsert" && mutation.project && !mutation.project.archivedAt) {
          void this.ensureFresh(mutation.project);
          return;
        }
        this.cache.delete(mutation.projectId);
        void fs.rm(this.cacheFile(mutation.projectId), { force: true }).catch(() => undefined);
      }) ?? null;
    for (const project of await this.options.projectRegistry.list()) {
      if (!project.archivedAt) void this.ensureFresh(project);
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Cached view merged with the project's persisted repo settings; null before the first scan. */
  snapshot(project: PersistedProjectRecord): ProjectReposSnapshot | null {
    const cached = this.cache.get(project.projectId);
    if (!cached || !areEquivalentPaths(cached.rootPath, project.rootPath)) return null;
    return {
      scannedAt: cached.scannedAt,
      repos: mergeRepos(cached.repos, project),
    };
  }

  /** Rescan now. Resolves when the cache reflects the scan. */
  async refresh(project: PersistedProjectRecord): Promise<ProjectReposSnapshot> {
    await this.scan(project);
    const snapshot = this.snapshot(project);
    if (!snapshot) throw new Error(`Project scan produced no catalog: ${project.projectId}`);
    return snapshot;
  }

  private async ensureFresh(project: PersistedProjectRecord): Promise<void> {
    const cached = this.cache.get(project.projectId);
    const pinned = pinnedRelPaths(project);
    const needsScan =
      !cached ||
      !areEquivalentPaths(cached.rootPath, project.rootPath) ||
      pinned.some((relPath) => !cached.repos.some((repo) => repo.relPath === relPath));
    if (!needsScan) return;
    await this.scan(project);
  }

  private scan(project: PersistedProjectRecord): Promise<void> {
    const existing = this.inflight.get(project.projectId);
    if (existing) return existing;
    const run = (async () => {
      try {
        const result = await this.discover({
          rootPath: project.rootPath,
          excludeRoots: this.excludeRoots,
          pinnedRelPaths: pinnedRelPaths(project),
        });
        const next: CachedCatalog = {
          projectId: project.projectId,
          rootPath: result.rootPath,
          scannedAt: result.scannedAt,
          repos: result.repos.map(toCachedRepo),
        };
        const previous = this.cache.get(project.projectId);
        this.cache.set(project.projectId, next);
        await writeJsonFileAtomic(this.cacheFile(project.projectId), next);
        if (!previous || JSON.stringify(previous.repos) !== JSON.stringify(next.repos)) {
          this.options.onChanged?.(project);
        }
      } catch (error) {
        this.logger.warn(
          { err: error, projectId: project.projectId, rootPath: project.rootPath },
          "Repository discovery failed",
        );
      } finally {
        this.inflight.delete(project.projectId);
      }
    })();
    this.inflight.set(project.projectId, run);
    return run;
  }

  private cacheFile(projectId: string): string {
    return path.join(this.directory, `${projectId}.json`);
  }

  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      let names: string[];
      try {
        names = await fs.readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const parsed = CachedCatalogSchema.parse(
            JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8")),
          );
          this.cache.set(parsed.projectId, parsed);
        } catch (error) {
          this.logger.warn({ err: error, file: name }, "Ignoring unreadable project catalog");
        }
      }
    })());
  }
}

function pinnedRelPaths(project: PersistedProjectRecord): string[] {
  return project.repos.filter((repo) => repo.pinned).map((repo) => repo.relPath);
}

function toCachedRepo(repo: DiscoveredRepo): CachedCatalog["repos"][number] {
  return {
    relPath: repo.relPath,
    rootPath: repo.rootPath,
    commonDir: repo.commonDir,
    commonDirHash: repo.commonDirHash,
    checkouts: repo.checkouts,
  };
}

function mergeRepos(
  discovered: CachedCatalog["repos"],
  project: PersistedProjectRecord,
): ProjectRepoPayload[] {
  const settingsByPath = new Map<string, PersistedProjectRepoSettings>(
    project.repos.map((repo) => [repo.relPath, repo]),
  );
  return discovered.map((repo) => {
    const settings = settingsByPath.get(repo.relPath);
    const adopted = settings?.adoptedWorktrees ?? [];
    return {
      relPath: repo.relPath,
      rootPath: repo.rootPath,
      commonDirHash: repo.commonDirHash,
      role: settings?.role ?? "normal",
      pinned: settings?.pinned ?? false,
      worktreeLocation: settings?.worktreeLocation ?? project.worktreeLocation ?? null,
      checkouts: repo.checkouts.map((checkout) => ({
        ...checkout,
        managed:
          checkout.isMain ||
          adopted.some((entry) => areEquivalentPaths(entry, checkout.path)) ||
          isUnderManagedRoot(checkout.path, repo, project),
      })),
    };
  });
}

/** Paseo-created worktrees live under `<worktreesRoot>/<commonDirHash>/` or the sibling folder. */
function isUnderManagedRoot(
  checkoutPath: string,
  repo: CachedCatalog["repos"][number],
  project: PersistedProjectRecord,
): boolean {
  const sibling = path.join(project.rootPath, `${path.basename(repo.rootPath)}.wt`);
  const relative = path.relative(sibling, checkoutPath);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
  return checkoutPath.split(path.sep).includes(repo.commonDirHash);
}
