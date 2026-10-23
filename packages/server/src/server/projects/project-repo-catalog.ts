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
 * is added, when its root path or repo settings change, when Paseo adds or removes a worktree
 * (`handleWorktreesChanged`), and on explicit refresh. Worktrees made with plain git show up on
 * the next of those.
 */

/** Coalesces the invalidations of one create or archive, which can fire more than once. */
const WORKTREE_CHANGE_DEBOUNCE_MS = 250;

const CachedCheckoutSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  detached: z.boolean(),
  bare: z.boolean(),
  insideProject: z.boolean(),
  paseoMetadata: z.boolean().default(false),
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
  /** Test seam; defaults to WORKTREE_CHANGE_DEBOUNCE_MS. */
  worktreeChangeDebounceMs?: number;
}

export class ProjectRepoCatalog {
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly cache = new Map<string, CachedCatalog>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly pendingRescans = new Map<string, ReturnType<typeof setTimeout>>();
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
    for (const timer of this.pendingRescans.values()) clearTimeout(timer);
    this.pendingRescans.clear();
  }

  /**
   * A worktree was added to or removed from the repository at `changedPath` (main root or any of its
   * checkouts). Rescans the projects whose cached tree contains it; `null` rescans every cached
   * project.
   */
  handleWorktreesChanged(changedPath: string | null): void {
    for (const cached of this.cache.values()) {
      if (changedPath === null || catalogContainsPath(cached, changedPath)) {
        this.scheduleRescan(cached.projectId);
      }
    }
  }

  private scheduleRescan(projectId: string): void {
    const existing = this.pendingRescans.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingRescans.delete(projectId);
      void (async () => {
        const project = await this.options.projectRegistry.get(projectId);
        if (project && !project.archivedAt) await this.scan(project);
      })().catch((error: unknown) => {
        this.logger.warn(
          { err: error, projectId },
          "Repository rescan after worktree change failed",
        );
      });
    }, this.options.worktreeChangeDebounceMs ?? WORKTREE_CHANGE_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingRescans.set(projectId, timer);
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

function catalogContainsPath(cached: CachedCatalog, target: string): boolean {
  return cached.repos.some(
    (repo) =>
      areEquivalentPaths(repo.rootPath, target) ||
      repo.checkouts.some((checkout) => areEquivalentPaths(checkout.path, target)),
  );
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
    checkouts: repo.checkouts.map((checkout) => ({ ...checkout })),
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
    return {
      relPath: repo.relPath,
      rootPath: repo.rootPath,
      commonDirHash: repo.commonDirHash,
      role: settings?.role ?? "normal",
      pinned: settings?.pinned ?? false,
      worktreeLocation: settings?.worktreeLocation ?? project.worktreeLocation ?? null,
      // Managed = Paseo may archive and delete it. Read from the same proof archive checks: Paseo
      // metadata in the worktree's git admin dir, written on create and on adoption. The
      // project's `adoptedWorktrees` list is not consulted: git reuses a path after a worktree is
      // removed, and a plain-git worktree there must read as external again.
      checkouts: repo.checkouts.map(({ paseoMetadata, ...checkout }) => ({
        ...checkout,
        managed: checkout.isMain || paseoMetadata,
      })),
    };
  });
}
