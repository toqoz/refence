# sence

A thin fence wrapper - suggests policy refinements.

## Synopsis

    sence <command> [args...]
    sence --interactive -- <agent-command...>
    sence --patch <file> -- <command> [args...]
    sence --rollback [STEP]

## Requirements

- Node.js >= 20
- [`fence(1)`](https://github.com/Use-Tusk/fence) >= 0.1.48 — sandbox runtime (uses `--fence-log-file`)
- [`codex(1)`](https://github.com/openai/codex) — LLM backend for policy suggestions
- `tmux(1)` >= 3.2 (only for `--interactive` mode)

## Install

    npm install -g @toqoz/sence

Or use the flake (`packages.default` exposes `sence`):

    # one-shot
    nix run github:toqoz/sence -- npm install

As a flake input (e.g. for home-manager):

    {
      inputs.sence.url = "github:toqoz/sence";
      outputs = { self, nixpkgs, sence, ... }: {
        # home.packages = [ sence.packages.${system}.default ];
      };
    }

`fence(1)` and `codex(1)` are not packaged in nixpkgs and must be
available on `PATH` separately. `tmux` is bundled into the wrapper.

## Description

sence wraps any command with `fence(1)`, monitors sandbox violations,
and uses an LLM to suggest minimal policy changes as a patch file.

The default profile starts with an empty policy. Use
`--profile <template>:<name>` to start from a fence built-in template
(e.g. `code:myproj`). Changes are never applied automatically.

## Usage

Run a command:

    $ sence npm install
    [sence] exit: 1
    Audit summary:
      - denied network: registry.npmjs.org:443
    Recommendation: Allow registry.npmjs.org for npm install.
    Proposed policy diff:
      ...
    To apply and re-run:
      sence --patch /tmp/sence-xxxxx/policy.json -- npm install

Apply the suggestion:

    $ sence --patch /tmp/sence-xxxxx/policy.json -- npm install

Undo it:

    $ sence --rollback

### Interactive mode

For coding agents that run interactively (Claude Code, Codex, etc.),
use `--interactive`. sence runs the agent under fence and tails the
monitor log in a split pane so you can watch denials as they happen:

    $ sence --interactive -- claude

While the agent runs, sence does not interrupt it. When you decide
the agent is stuck, interrupt it yourself (ESC, Ctrl+C). After the
agent exits, if any denials were logged, sence:

1. Captures the pane (often contains the session/resume id)
2. Prints an audit summary to stderr
3. Runs the LLM suggester (unless `--suggest never`)
4. Writes a patch file and prints a `sence --patch … --interactive --
   <resume>` line for you to copy and run

## Template profiles

Use `--profile <template>:<name>` to start a profile from a fence
built-in template:

    $ sence --profile code:npm-i npm install
    $ sence --profile code:build npm run build

On first run, `code:npm-i` is initialized with `{ "extends": "code" }`.
It then behaves like any normal profile — patches, rollbacks, and
suggestions all work. Each `<template>:<name>` profile evolves
independently.

`default:<name>` starts from an empty policy `{}`.

Profiles without `:` (e.g. `--profile myproj`) are shorthand for
`default:<name>` — they also start from an empty policy.

### Workspace-local config

Append a third field to relocate `fence.json` itself:

    $ sence --profile code:local:. -- npm install           # fence.json in cwd
    $ sence --profile code:build:./sandbox -- npm run build # fence.json under ./sandbox

The `<config-dir>` is resolved against `process.cwd()` at run time and
holds `fence.json` flat (no `sence/<profile>/` subdirectory). sence's
own runtime state — snapshots and monitor log — still lives under
`$XDG_STATE_HOME/sence/<key>/`, keyed by `<template>-<name>-<abs-path>`
so two workspaces with the same `<template>:<name>` never collide.

Available fence templates can be listed with:

    $ fence --list-templates

sence ships a snapshot of the allowed fence templates under
`docs/fence-templates/` so the suggester can see exactly what the
current `extends` baseline already provides and propose minimal
additions on top. sence refuses any patch or LLM suggestion that
would rewrite `extends`. Refresh the snapshots after a fence upgrade
with:

    $ bin/refresh-fence-templates.sh

## Options

    --interactive         interactive agent mode (real-time denial monitoring)
    --profile <name>      policy profile (default: default)
                          <name>                        → default:<name>
                          <template>:<name>             → start from a fence template
                          <template>:<name>:<config-dir> → fence.json at <config-dir>/fence.json
    --model <name>        LLM model for policy suggestions (default: gpt-5.4-mini)
    --patch <file>        apply a policy patch before running
    --rollback [STEP]     rollback to a previous policy snapshot (default: 1)
    --suggest auto|never
    --report text|json
    --verbose
    --help

## Policy

Policies live in `$XDG_CONFIG_HOME/sence/<profile>/fence.json`.
Snapshots are kept in `$XDG_STATE_HOME/sence/<key>/snapshots/`.
(With a workspace-local profile, `fence.json` moves to
`<config-dir>/fence.json` but snapshots and logs stay under
`$XDG_STATE_HOME`.)

The default profile (`default:default`) starts with an empty policy
`{}`. Use `--profile <template>:<name>` to start from a fence template.

See `docs/fence-cheatsheet.md` for the fence.json format.

`--rollback` restores a previous snapshot. Snapshots are immutable;
rollback writes directly without creating a new snapshot, so repeated
rollback to the same step always reaches the same state.

## Known limitations

- **codex dependency**: policy suggestions require `codex(1)`.
  Without it, `--suggest auto` falls back to showing raw audit
  summaries without proposed diffs.

## File layout

sence writes in three places:

    $XDG_CONFIG_HOME/sence/<profile>/fence.json     persistent policy
    $XDG_STATE_HOME/sence/<key>/
      ├── monitor.log                               fence audit log (--interactive)
      └── snapshots/<timestamp>-<seq>.json          rollback points, newest first
    $TMPDIR/sence-XXXXXX/policy.json                ephemeral; pass to --patch

XDG defaults when unset: `$XDG_CONFIG_HOME` → `~/.config`,
`$XDG_STATE_HOME` → `~/.local/state`.

`<profile>` and `<key>` are derived from the `--profile` argument:

    --profile form                    <profile> path segment        <key>
    <name>                            default:<name>                default:<name>
    <template>:<name>                 <template>:<name>             <template>:<name>
    <template>:<name>:<config-dir>    (fence.json moves to          <template>-<name>-<abs-config-dir>
                                       <config-dir>/fence.json,      (slashes replaced with `-`)
                                       flat — no sence/ prefix)

With a 3-component profile, `fence.json` lives at `<config-dir>/fence.json`
(workspace-local). Runtime state still lives under `$XDG_STATE_HOME` and is
keyed so two workspaces sharing the same `<template>:<name>` never collide.

## License

MIT
