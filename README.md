# Instructable

`Instructable` is a Bun/TypeScript CLI for storing reusable instruction snippets, tagging them, composing them, and exporting them into persistent files that Claude Code and Codex can consume directly.

By default, the database is global at `~/.instructable/instructable.db` rather than repo-local. You can override that path with `INSTRUCTABLE_DB_PATH`.

## Install

```sh
npm install -g instructable
```

```sh
bun add -g instructable
```

Then run:

```sh
instructable init
```

## Commands

```sh
instructable init
instructable add --title "Senior Engineer" --content "Act like a strict reviewer." --tags role:engineer,style:direct
instructable add --title "Shared Rule" --content "Applies everywhere." --tags agent:shared,policy:core
instructable add --title "Codex Rule" --content "Codex-specific guidance." --tags agent:codex,policy:core
instructable add --title "Claude Rule" --content "Claude-specific guidance." --tags agent:claude,policy:core
instructable list
instructable compose --target codex --tags policy:core
instructable export --target codex --tags role:engineer
instructable export --target claude --tags role:engineer
instructable install --target all --tags policy:core
instructable profile save --name codex-core --tags policy:core --match all --target codex
instructable profile save --name shared-core --tags policy:core --match all --target all
instructable profile list
instructable export --profile codex-core
instructable install --profile shared-core --target all
instructable template save --name codex-default --target codex --body "# AGENTS.md\n\n{{managed_notice}}\n\n## Core\n{{query tags=\"policy:core\" match=\"all\"}}"
instructable template list
instructable export --template codex-default
```

## Local Development

```sh
bun run src/index.ts init
npm run build
npm run typecheck
node dist/index.js list
```

## Notes

- SQLite is provided through Bun's native `bun:sqlite` module.
- The database defaults to `~/.instructable/instructable.db`.
- If an older repo-local `instructable.db` exists and the global DB does not, Instructable will copy the local DB to the global location on first open.
- SQLite writes should be treated as serial. Concurrent write commands against the same DB can lock.
- `add` is upsert-by-title.
- `compose` and `export` default to `--match all` when you pass `--tags`; use `--match any` if you want looser matching.
- `export --target codex` defaults to `AGENTS.md`.
- `export --target claude` defaults to `CLAUDE.md`.
- `install --target all` writes both files so the same instruction set is available to Codex and Claude Code in the current repo.
- Profiles are saved named queries with tags, match mode, and a default target.
- Use `profile save`, `profile list`, `profile show`, and `profile delete` to manage them.
- `compose`, `export`, and `install` accept `--profile <name>` so you can generate outputs from a saved preset instead of raw tags.
- Templates let you control output structure instead of only concatenating snippets.
- Use `template save`, `template list`, `template show`, and `template delete` to manage them.
- `export` and `install` accept `--template <name>`.
- Supported template directives:
- `{{managed_heading}}` inserts the target heading.
- `{{managed_notice}}` inserts the target-specific managed-file notice.
- `{{selection}}` inserts the snippets selected by the current `--tags`, `--ids`, or `--profile`.
- `{{profile:name}}` inserts snippets from a saved profile.
- `{{query tags="policy:core,workflow:coding" match="all"}}` inserts snippets from a tag query.
- Target-aware installs understand these tag conventions:
- `agent:shared`, `runtime:shared`, or `shared:true` means include in both outputs.
- `agent:codex` or `runtime:codex` means include only in Codex output.
- `agent:claude` or `runtime:claude` means include only in Claude output.
- Snippets with no agent/runtime tag are treated as shared for backward compatibility.
