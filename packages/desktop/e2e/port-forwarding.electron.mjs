import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";

async function expectClosed(port) {
  await expect
    .poll(async () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      try {
        await once(socket, "connect");
        return false;
      } catch (error) {
        return error.code === "ECONNREFUSED";
      } finally {
        socket.destroy();
      }
    })
    .toBe(true);
}

async function localAddress(row) {
  await expect(row).toContainText(/→ 127\.0\.0\.1:\d+/);
  const match = (await row.textContent()).match(/→ 127\.0\.0\.1:(\d+)/);
  assert.ok(match);
  return { port: Number(match[1]), url: `http://127.0.0.1:${match[1]}/` };
}

async function downloadConnectedFile({ page, workspaceId, fileHome, fileSocket, artifactDir }) {
  const workspaces = JSON.parse(
    await fs.readFile(path.join(fileHome, "projects/workspaces.json"), "utf8"),
  );
  const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId);
  const fileName = "forwarding-download.bin";
  const contents = Buffer.alloc(512 * 1024, 157);
  const saved = path.join(artifactDir, fileName);
  await fs.rm(saved, { force: true });
  await fs.writeFile(path.join(workspace.cwd, fileName), contents);
  await page.evaluate(
    ({ socketPath, isWindows }) => {
      const key = "@paseo:daemon-registry";
      const hosts = JSON.parse(localStorage.getItem(key));
      const connection = {
        id: `socket:${socketPath}`,
        type: isWindows ? "directPipe" : "directSocket",
        path: socketPath,
      };
      const now = new Date().toISOString();
      hosts.push({
        serverId: "port-download-ipc",
        label: "IPC downloads",
        connections: [connection],
        preferredConnectionId: connection.id,
        createdAt: now,
        updatedAt: now,
      });
      localStorage.setItem(key, JSON.stringify(hosts));
    },
    { socketPath: fileSocket, isWindows: process.platform === "win32" },
  );
  await page.reload();
  await page.getByTestId(`sidebar-workspace-row-port-download-ipc:${workspaceId}`).click();
  const session = await page.context().newCDPSession(page);
  await session.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: artifactDir,
    eventsEnabled: true,
  });
  const explorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
  if (!(await explorer.count()))
    await page.getByTestId("workspace-explorer-toggle").first().click();
  await explorer.getByTestId("workspace-tab-files").click({ position: { x: 12, y: 13 } });
  const tree = page.getByTestId("file-explorer-tree-scroll").filter({ visible: true });
  await tree.getByText(fileName, { exact: true }).click({ button: "right" });
  const downloading = page.waitForEvent("download");
  await page.getByText("Download", { exact: true }).click();
  const download = await downloading;
  assert.ok(
    download.url().startsWith("blob:"),
    `Expected connection download, received ${download.url()}`,
  );
  await expect
    .poll(() =>
      fs.stat(saved).then(
        (stat) => stat.size,
        () => 0,
      ),
    )
    .toBe(contents.length);
  assert.deepEqual(await fs.readFile(saved), contents);
  await session.detach();
  await fs.rm(path.join(workspace.cwd, fileName));
  await page.evaluate(() => {
    const key = "@paseo:daemon-registry";
    localStorage.setItem(
      key,
      JSON.stringify(
        JSON.parse(localStorage.getItem(key)).filter(
          (host) => host.serverId !== "port-download-ipc",
        ),
      ),
    );
  });
  await page.reload();
  return contents.length;
}

export async function runPortForwardingRegression({
  page,
  serverId,
  workspaceId,
  otherWorkspaceId,
  paseoHome,
  fileHome,
  fileSocket,
  artifactDir,
}) {
  const service = http.createServer((request, response) => request.pipe(response));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const remotePort = service.address().port;
  const sheet = page.getByTestId("workspace-ports-sheet");
  const row = page.getByTestId(`forwarded-port-${remotePort}`);
  const workspaceRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  const openSheet = async () => {
    await page.getByTestId("workspace-scripts-button").filter({ visible: true }).click();
    await page.getByTestId("workspace-ports-menu-item").click();
    await expect(sheet).toBeVisible();
  };
  const readPorts = async () => {
    const workspaces = JSON.parse(
      await fs.readFile(path.join(paseoHome, "projects/workspaces.json"), "utf8"),
    );
    return workspaces.find((workspace) => workspace.workspaceId === workspaceId).portForwards ?? [];
  };
  try {
    await workspaceRow.waitFor({ state: "visible", timeout: 90_000 });
    await workspaceRow.click();
    await openSheet();
    await page.getByTestId("port-remote").fill("65536");
    await expect(page.getByTestId("port-save")).toBeDisabled();
    await page.getByTestId("port-remote").fill(String(remotePort));
    await page.getByTestId("port-label").fill("Preview service");
    await page.getByTestId("port-save").click();
    const first = await localAddress(row);
    const payload = Buffer.alloc(512 * 1024, 123);
    const response = await fetch(first.url, {
      method: "POST",
      body: payload,
      headers: { Connection: "close" },
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    await expect
      .poll(readPorts)
      .toEqual([{ port: remotePort, label: "Preview service", protocol: "http" }]);
    await page.screenshot({ path: path.join(artifactDir, "workspace-ports-forwarding.png") });

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${otherWorkspaceId}`).click();
    assert.equal(
      await (
        await fetch(first.url, {
          method: "POST",
          body: "still connected",
          headers: { Connection: "close" },
        })
      ).text(),
      "still connected",
    );
    await workspaceRow.click();
    await openSheet();
    await row.getByRole("button", { name: "Stop forwarding", exact: true }).click();
    await expect(row).toContainText("Not forwarded");
    await expectClosed(first.port);

    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
    await row.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(row.getByRole("alert")).toBeVisible();
    assert.equal((await readPorts()).length, 1);
    service.listen(remotePort, "127.0.0.1");
    await once(service, "listening");
    await row.getByRole("button", { name: "Forward", exact: true }).click();
    const retried = await localAddress(row);
    await expect(row.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expectClosed(retried.port);
    await workspaceRow.click();
    await openSheet();
    await expect(row).toContainText("Not forwarded");
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(readPorts).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    const downloadedBytes = await downloadConnectedFile({
      page,
      workspaceId,
      fileHome,
      fileSocket,
      artifactDir,
    });
    await workspaceRow.click();
    return {
      manualPort: remotePort,
      payloadBytes: payload.length,
      downloadedBytes,
      navigation: "passed",
      retry: "passed",
      reloadCleanup: "passed",
      persistence: "passed",
    };
  } catch (error) {
    await page
      .screenshot({ path: path.join(artifactDir, "workspace-ports-failure.png") })
      .catch(() => {});
    throw error;
  } finally {
    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
  }
}
