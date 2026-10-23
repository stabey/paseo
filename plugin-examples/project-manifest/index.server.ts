import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProjectManifest } from "@getpaseo/protocol/messages";

const MAX_CHECKOUTS_PER_REPO = 8;

/**
 * Agents started in the root folder of a project that holds several repositories get a summary
 * of them: branch, last commit and uncommitted files per checkout. Single-repository projects and
 * agents started inside one repository or worktree are left alone; their own git status already
 * tells them that much.
 */
export default function contribute(server: PluginServerContext) {
  server.before("agent.create", async ({ request }, { paseo }) => {
    const { projects } = await paseo.projects.list();
    const project = projects.find((entry) => samePath(entry.projectRootPath, request.config.cwd));
    if (!project || (project.repos?.length ?? 0) < 2) {
      return request;
    }

    let manifest: ProjectManifest;
    try {
      manifest = await paseo.projects.manifest(project.projectId);
    } catch {
      // Hosts without `projectManifest` reject the request; start the agent unchanged.
      return request;
    }

    const summary = formatSummary(manifest);
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt: request.config.systemPrompt
          ? `${request.config.systemPrompt}\n\n${summary}`
          : summary,
      },
    };
  });

  return () => {};
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function formatSummary(manifest: ProjectManifest): string {
  const lines = [
    `This folder (${manifest.rootPath}) holds several git repositories. Snapshot from ${manifest.generatedAt}:`,
  ];
  for (const repo of manifest.repos) {
    lines.push(`- ${repo.relPath}${repo.role === "reference" ? " (reference, read-only)" : ""}`);
    const shown = repo.checkouts.slice(0, MAX_CHECKOUTS_PER_REPO);
    for (const checkout of shown) {
      const branch = checkout.branch ?? "detached HEAD";
      const where = checkout.isMain ? "main checkout" : checkout.path;
      const commit = checkout.lastCommit
        ? `${checkout.lastCommit.sha.slice(0, 9)} ${checkout.lastCommit.subject}`
        : "no commits";
      const changes = checkout.uncommitted?.files
        ? `; ${checkout.uncommitted.files} uncommitted files`
        : "";
      lines.push(`  - ${branch} (${where}): ${commit}${changes}`);
    }
    if (repo.checkouts.length > shown.length) {
      lines.push(`  - ${repo.checkouts.length - shown.length} more checkouts`);
    }
  }
  return lines.join("\n");
}
