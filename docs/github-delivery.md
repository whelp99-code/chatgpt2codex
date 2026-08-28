# GitHub delivery tools

chatgpt2codex can use the GitHub CLI login already stored on the host to manage
Issues and Pull Requests for a selected project. It does not accept a repository
name from the model: every operation derives `owner/repository` from that
project's `origin` remote and accepts only `github.com`.

## Host setup

Install `gh` and authenticate the operating-system user that runs
chatgpt2codex:

```bash
gh auth login
gh auth status
```

The current OAuth credential remains in the GitHub CLI credential store. It is
not copied into chatgpt2codex configuration, tool arguments, logs, or results.
Private repositories require the OAuth `repo` scope. CI inspection requires
read access to the repository's checks.

The repository must have GitHub Issues enabled before Issue tools can create or
update Issues.

## Allowed operations

- List and read Issues
- Create and update Issue title/body
- Add Issue comments
- Add or remove existing labels
- Add or remove assignees
- Close or reopen Issues
- Create a Pull Request from the current named branch
- Update Pull Request title/body
- Add Pull Request comments
- Request Pull Request reviewers
- Read Pull Request CI and check results

Issue and Pull Request writes require `project_select` with
`preset=full-write`. Read operations require a selected project with read
access.

## Deliberately unavailable

- Pull Request merge
- Arbitrary `gh` or `gh api` execution through `local_shell_run`
- Workflow dispatch
- Release creation
- Repository, collaborator, secret, variable, webhook, or permission changes
- Operations against a caller-supplied repository

The MCP catalog exposes dedicated tools for each operation. The GPT Actions
schema exposes one `github_delivery` operation because GPT Actions permit at
most 30 operations per schema.
