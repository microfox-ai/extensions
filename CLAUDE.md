# Rules

## Bump the version in every PR that adds a feature
- Extension (`get-into-zone/`): bump `version` in `get-into-zone/package.json` (and `package-lock.json`, via `npm version minor --no-git-tag-version`). A version that isn't tagged yet is released as is by `.github/workflows/release-browse-hack.yml`; without a bump the workflow only patch-bumps on merge.
- MCP server (`mcp/`): bump `version` in both `mcp/package.json` and `mcp/manifest.json`, kept equal.
- Features get a minor bump, fixes a patch bump.

## Install MCP servers only from the released `.mcpb`
- Never register an MCP server straight from this checkout (no `claude mcp add ... node mcp/dist/index.js`, no hand-edited `mcpServers` entries pointing at the repo).
- Install the `.mcpb` that is published after the PR merges, through MediaMake (`mcp/browse-hack`, following https://github.com/microfox-ai/mediamake/blob/main/install.md).
