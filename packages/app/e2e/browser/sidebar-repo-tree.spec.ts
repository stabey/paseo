import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectSeedClient, type SeedDaemonClient } from "../support/helpers/seed-client";
import { createTempDirectory, type TempDirectory } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "e2e@paseo.test");
  git(dir, "config", "user.name", "e2e");
  git(dir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "# repo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "initial");
}

async function enableRepoTree(page: Page): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await page.getByTestId("sidebar-display-repo-tree").click();
  await page.keyboard.press("Escape");
}

interface RepoTreeFixture {
  folder: TempDirectory;
  client: SeedDaemonClient;
  projectId: string;
  projectKey: string;
  externalPath: string;
}

async function createRepoTreeFixture(): Promise<RepoTreeFixture> {
  // A plain folder holding two repositories; `app` has a worktree made with plain git.
  const folder = await createTempDirectory("repo-tree-");
  await initRepo(path.join(folder.path, "app"));
  await initRepo(path.join(folder.path, "docs"));
  const externalPath = path.join(folder.path, "app.wt", "ext");
  git(path.join(folder.path, "app"), "worktree", "add", "-q", "-b", "ext", externalPath);

  const client = await connectSeedClient();
  const created = await client.createWorkspace({
    source: { kind: "directory", path: folder.path },
  });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create workspace");
  const projectId = created.workspace.projectId;
  await client.setProjectRepoSettings({ projectId, relPath: "docs", role: "reference" });
  await client.refreshProjectRepos(projectId);
  const listed = await client.listProjects();
  const descriptor = listed.projects.find((project) => project.projectId === projectId);
  if (!descriptor?.projectKey) throw new Error("Created project has no project key");
  return { folder, client, projectId, projectKey: descriptor.projectKey, externalPath };
}

test.describe("Sidebar repository tree", () => {
  let fixture: RepoTreeFixture | null = null;

  test.afterEach(async () => {
    if (!fixture) return;
    await fixture.client.removeProject(fixture.projectId).catch(() => undefined);
    await fixture.client.close().catch(() => undefined);
    await fixture.folder.cleanup().catch(() => undefined);
    fixture = null;
  });

  test("groups the project by repository and checkout, and adopts an external worktree", async ({
    page,
  }) => {
    fixture = await createRepoTreeFixture();
    const { folder, projectKey, externalPath } = fixture;
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await enableRepoTree(page);

    const tree = page.getByTestId(`sidebar-repo-tree-${projectKey}`);
    await expect(tree).toBeVisible({ timeout: 30_000 });

    // Repo > checkout: the main checkout carries a badge, the plain-git worktree reads external.
    await expect(tree.getByTestId("sidebar-repo-row-app")).toBeVisible();
    const appMain = tree.getByTestId(`sidebar-checkout-row-${path.join(folder.path, "app")}`);
    await expect(appMain).toContainText("main");
    const external = tree.getByTestId(`sidebar-checkout-row-${externalPath}`);
    await expect(external).toContainText("external");

    // Reference repositories start collapsed and open on press.
    const docsRow = tree.getByTestId("sidebar-repo-row-docs");
    await expect(docsRow).toContainText("reference");
    const docsMain = tree.getByTestId(`sidebar-checkout-row-${path.join(folder.path, "docs")}`);
    await expect(docsMain).toBeHidden();
    await docsRow.click();
    await expect(docsMain).toBeVisible();

    // The root workspace is not inside any checkout.
    await expect(tree.getByTestId("sidebar-repo-tree-other")).toBeVisible();

    await external.click({ button: "right" });
    await page.getByTestId(`sidebar-checkout-menu-${externalPath}-adopt`).click();
    await expect(external).not.toContainText("external", { timeout: 15_000 });
  });
});
