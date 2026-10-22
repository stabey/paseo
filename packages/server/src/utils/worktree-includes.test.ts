import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyWorktreeIncludes, readWorktreeIncludesPlan } from "./worktree-includes.js";

describe("worktree includes", () => {
  let base: string;
  let source: string;
  let worktree: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-includes-")));
    source = path.join(base, "source");
    worktree = path.join(base, "worktree");
    mkdirSync(path.join(source, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(source, "config"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(source, ".env"), "SECRET=1\n");
    writeFileSync(path.join(source, "config", "local.json"), "{}\n");
    writeFileSync(path.join(source, "tracked.txt"), "source\n");
    writeFileSync(path.join(worktree, "tracked.txt"), "worktree\n");
    writeFileSync(
      path.join(source, "paseo.json"),
      JSON.stringify({
        worktree: {
          include: [".env", "config", "missing.txt", "tracked.txt"],
          linkDirectories: ["node_modules", "not-a-dir"],
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("copies includes without overwriting and links directories", async () => {
    const plan = readWorktreeIncludesPlan(source);
    expect(plan).toEqual({
      include: [".env", "config", "missing.txt", "tracked.txt"],
      linkDirectories: ["node_modules", "not-a-dir"],
    });

    const applied = await applyWorktreeIncludes({ sourceRoot: source, worktreePath: worktree });

    expect(applied).toEqual({
      copied: [".env", "config", "tracked.txt"],
      linked: ["node_modules"],
      skipped: ["missing.txt", "not-a-dir"],
    });
    expect(readFileSync(path.join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(path.join(worktree, "config", "local.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(path.join(worktree, "tracked.txt"), "utf8")).toBe("worktree\n");
    expect(lstatSync(path.join(worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect(realpathSync(path.join(worktree, "node_modules"))).toBe(
      path.join(source, "node_modules"),
    );
  });

  it("does nothing without configuration and rejects escaping entries", async () => {
    rmSync(path.join(source, "paseo.json"));
    await expect(
      applyWorktreeIncludes({ sourceRoot: source, worktreePath: worktree }),
    ).resolves.toEqual({ copied: [], linked: [], skipped: [] });
    await expect(
      applyWorktreeIncludes({
        sourceRoot: source,
        worktreePath: worktree,
        plan: { include: ["../outside"], linkDirectories: [] },
      }),
    ).rejects.toThrow(/escapes the checkout/);
  });
});
