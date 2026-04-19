# fence.json reference

sence starts from `{"extends": "code-strict"}`. Your policy only needs to add or override what's different.

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
- deny > allow (both filesystem and network)
- `extends` base + local keys merged

## Credential paths (never allow)

```
~/.ssh/id_*, ~/.ssh/config, ~/.ssh/*.pem, ~/.gnupg/**
~/.aws/**, ~/.config/gcloud/**, ~/.kube/**, ~/.docker/**
~/.config/gh/**, ~/.pypirc, ~/.netrc, ~/.git-credentials
~/.cargo/credentials, ~/.cargo/credentials.toml
```
