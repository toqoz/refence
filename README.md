# sence

A thin fence wrapper - suggests policy refinements.

## Synopsis

    sence <command> [args...]
    sence --interactive -- <agent-command...>
    sence --patch <file> -- <command> [args...]
    sence --rollback [STEP]

## Requirements

- Node.js >= 20
- [`fence(1)`](https://github.com/Use-Tusk/fence) — sandbox runtime
- [`codex(1)`](https://github.com/openai/codex) — LLM backend for policy suggestions
- `tmux(1)` >= 3.2 (only for `--interactive` mode)

## Install

    npm install -g @toqoz/sence

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
use `--interactive`. sence monitors sandbox violations in real-time
and interrupts the agent when access is denied:

    $ sence --interactive -- claude

When a denial is detected:

1. ESC is sent to the agent (graceful interrupt)
2. The process is killed to apply new sandbox settings
3. The terminal screen is captured (includes session ID)
4. An LLM analyzes the violation and proposes a policy change
5. A tmux popup shows the proposal for approval
6. If accepted, the resume command is prefilled in your terminal

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

Available fence templates can be listed with:

    $ fence --list-templates

## Options

    --interactive         interactive agent mode (real-time denial monitoring)
    --profile <name>      policy profile (default: default)
                          use <template>:<name> to start from a fence template
    --model <name>        LLM model for policy suggestions (default: gpt-5.4-mini)
    --patch <file>        apply a policy patch before running
    --rollback [STEP]     rollback to a previous policy snapshot (default: 1)
    --suggest auto|never
    --report text|json
    --verbose
    --help

## Policy

Policies live in `$XDG_CONFIG_HOME/sence/<profile>/fence.json`.
Snapshots are kept in `$XDG_DATA_HOME/sence/<profile>/snapshots/`.

The default profile (`default:default`) starts with an empty policy
`{}`. Use `--profile <template>:<name>` to start from a fence template.

See `docs/fence-cheatsheet.md` for the fence.json format.

`--rollback` restores a previous snapshot. Snapshots are immutable;
rollback writes directly without creating a new snapshot, so repeated
rollback to the same step always reaches the same state.

## Known limitations

- **TTY-dependent features**: with a TTY, sence passes an extra
  inherited fd to isolate fence monitor output from agent stderr.
  Without a TTY (e.g. CI), this isolation is unavailable — policy
  suggestions are disabled and audit output is marked as unverified,
  since a wrapped command could emit fake fence monitor lines.
  Sandbox enforcement still works regardless.
  Once `fence --fence-log-file` (Use-Tusk/fence#126) is broadly
  available, this workaround will be replaced by reading monitor
  output from a log file, removing the TTY dependency entirely.

- **codex dependency**: policy suggestions require `codex(1)`.
  Without it, `--suggest auto` falls back to showing raw audit
  summaries without proposed diffs.

## License

MIT
