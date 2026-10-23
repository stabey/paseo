# Project manifest

Gives agents started in a project's root folder a summary of the git repositories inside it,
through `server.before("agent.create", ...)`:

- Finds the project whose root folder is the agent's `cwd` and holds two or more repositories.
  Single-repository projects and agents started inside a repository or worktree are unchanged.
- Reads `paseo.projects.manifest(projectId)`: every repository and checkout with its branch, last
  commit and uncommitted file count. Hidden repositories are left out.
- Appends the summary to `config.systemPrompt`, keeping any prompt an earlier plugin set.

Install on a daemon with plugins enabled:

```bash
paseo plugin install /absolute/path/to/plugin-examples/project-manifest
```

The manifest is read once, when the agent is created. It is not refreshed during the session.
Hosts without the `projectManifest` feature reject the request; the plugin then starts the agent
unchanged.

The callback has the same shape as [agent configuration](../agent-configuration), so both can run
on one daemon: each spreads the request it receives and changes only its own fields. See the
[lifecycle reference](../../public-docs/plugins/reference.md#lifecycle-hooks) for ordering.
