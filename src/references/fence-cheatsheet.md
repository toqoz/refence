# fence.json reference

sence typically starts from `{"extends": "code-strict"}` (or `code` / `code-relaxed`).
Your patch only needs the additions that the current denials require.

## Pick the right key for each denial

The monitor emits denials with different actions. Each action maps to ONE
section — propose additions only in that section. Do not try to express a
denial in an unrelated section (e.g. a `mach-lookup` denial is NOT a
filesystem issue).

| Denial action                  | Where it shows up               | Propose addition under        |
|--------------------------------|---------------------------------|-------------------------------|
| `CONNECT … 403 host`           | `deniedNetwork[]`               | `network.allowedDomains`      |
| `file-read` / `file-read-data` | `deniedFiles[].action`          | `filesystem.allowRead`        |
| `file-write*`                  | `deniedFiles[].action`          | `filesystem.allowWrite`       |
| `mach-lookup <service>`        | `deniedFiles[].action`, path = service name | `macos.mach.lookup` |
| `mach-register <service>`      | `deniedFiles[].action`, path = service name | `macos.mach.register` |

Note: fence groups non-network denials under `deniedFiles` regardless of
whether the `path` is an actual filesystem path or a mach-service name. Always
branch on `action`, not the array it lives in.

## Schema (only write what you're changing)

```
{
  "extends": "code-strict",
  "network": {
    "allowedDomains": [],    // ["example.com", "*.npmjs.org"]
    "deniedDomains": []      // takes precedence over allowed
  },
  "filesystem": {
    "allowRead": [],         // ["~/extra-dir"]
    "denyRead": [],          // takes precedence; ["~/.secret/**"]
    "allowWrite": [],        // ["./dist"]
    "denyWrite": []          // takes precedence; ["**/.env"]
  },
  "command": {
    "deny": []               // ["rm -rf"]
  },
  "macos": {
    "mach": {
      "lookup": [],          // macOS only. ["com.apple.pasteboard.1"]
      "register": []         // macOS only. Rare.
    }
  }
}
```

## What code-strict gives you

- `defaultDenyRead: true` — only project dir + essential system paths readable
- AI API domains, package registries, git hosts already allowed
- Write to workspace + /tmp + tool config dirs
- Credential paths denied
- Destructive commands denied (git push, npm publish, sudo, etc.)

## Syntax

- Paths: `.` = cwd, `~` = home, `**` = recursive glob, `*` = single-level glob
- Domains: `example.com` = exact, `*.example.com` = any subdomain
- Mach services: exact (`com.apple.pasteboard.1`) or trailing prefix
  (`org.chromium.*`). Avoid `*`.
- deny > allow (both filesystem and network)
- `extends` base + local keys merged

## Credential paths (never allow)

```
~/.ssh/id_*, ~/.ssh/config, ~/.ssh/*.pem, ~/.gnupg/**
~/.aws/**, ~/.config/gcloud/**, ~/.kube/**, ~/.docker/**
~/.config/gh/**, ~/.pypirc, ~/.netrc, ~/.git-credentials
~/.cargo/credentials, ~/.cargo/credentials.toml
```

## Anti-patterns to avoid

- Do not propose `command.deny` entries for commands that were never denied.
  The goal is to unblock the current denial, not to harden policy.
- Do not propose `filesystem.allow*` for a mach-lookup denial. The service
  name (`com.apple.pasteboard.1`) is not a filesystem path.
- Do not propose `command.deny pbcopy` to "fix" a pasteboard denial — denying
  the command does not grant mach access, and the agent probably needs
  clipboard access anyway.
