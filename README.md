# cpa — CLI for CLIProxyAPI

A small **command-line** tool to drive a locally-running [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) backend through its `/v0/management/*` REST surface. Forked from the upstream React WebUI and stripped down to a Node/Bun CLI for **personal local use** — no GUI, no remote management, no security hardening (treat the saved management key as you would any local credential).

## What this is (and isn't)

- A thin client for the **management API only**. It does not proxy LLM traffic itself.
- 4 OAuth providers: `codex`, `anthropic`, `antigravity`, `gemini-cli`.
- Token usage stats + per-request log inspection are preserved.
- Browser launching is **WSL-aware** (`cmd.exe /c start`, `wslview` fallback).
- The on-disk config (`~/.config/cpa/config.json`) holds the management key as plaintext. Local-only assumption.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1 to build the single binary (or to run from source).

```bash
bun install
bun run build:bin               # → dist/cpa  (~50MB self-contained)
mv dist/cpa ~/.local/bin/cpa    # or anywhere on $PATH
cpa --help
```

For development without the build step:

```bash
bun run dev -- <subcommand>     # equivalent to `cpa <subcommand>`
```

## Quick start

```bash
# 1. Tell the CLI where the proxy lives.
cpa connect --url http://localhost:8317 --key <management-key>

# 2. Log in to a provider — opens a browser tab.
cpa login codex
cpa login gemini-cli --project-id ALL

# 3. Inspect the credentials that landed + a one-screen overview.
cpa auth ls
cpa                              # bare invocation = `cpa status` dashboard

# 4. Watch usage + recent requests.
cpa usage --last 24h
cpa usage account <name>         # per-account drill-down
cpa logs --follow
cpa logs trace <request-id>     # full per-request blob

# 5. Manage multi-account routing.
cpa lb status                    # see ACTIVE / STANDBY / DISABLED per account
cpa lb set codex-foo@bar.json standby
cpa lb mode fill-first           # or `round-robin`

# 6. Discover provider-specific endpoint URLs (for client config).
cpa endpoint ls
cpa endpoint url codex --client-config
```

## Command reference

| Command | What it does |
|---|---|
| `cpa` / `cpa status [--json]` | At-a-glance dashboard: server info, accounts grouped by provider with ACTIVE/STANDBY/DISABLED counts, this month's request + token totals, active alerts. Bare `cpa` is an alias. |
| `cpa connect [-u URL] [-k KEY]` | Save server URL and management key locally. `--show` prints current. `--clear` wipes them. |
| `cpa version` | Print CLI + server version. |
| `cpa login <provider> [--project-id ID] [--manual]` | OAuth login. Opens browser, polls every 3 s, falls back to a paste prompt on timeout. |
| `cpa auth ls [--all]` | List auth files (default hides disabled). |
| `cpa auth rm <name…> \| --all` | Delete one or more auth files. |
| `cpa auth toggle <name> [--enable\|--disable]` | Flip the disabled state. |
| `cpa auth cat <name> [--raw]` | Print credential JSON (or raw text). |
| `cpa auth save <name> <dest>` | Save the credential to a local file. |
| `cpa auth relogin <name>` | Delete `<name>` and tell you which `cpa login` to run next. |
| `cpa usage [-l 1h\|6h\|24h\|7d\|all] [-s SOURCE]` | Token usage tables (by model and by source/auth-index). |
| `cpa usage account <name> [-l 1h\|…\|30d\|all]` | Per-account breakdown: identity, Codex plan info, monthly tokens by type, top models, recent activity. `<name>` accepts the full filename, an email, or a unique substring. |
| `cpa lb status [--json]` | Print routing strategy + per-account ACTIVE/STANDBY/DISABLED state with health and recent traffic. |
| `cpa lb mode <round-robin\|fill-first>` | Switch global selector strategy. |
| `cpa lb set <name> <active\|standby\|disabled>` | Promote/demote one account: ACTIVE = priority 10, STANDBY = priority 0, DISABLED = `disabled=true`. |
| `cpa endpoint ls [--json]` | Map each provider to its local URL with isolation status (most are isolated by handler type; `/v1/chat/completions` dispatches by model). |
| `cpa endpoint url <provider> [--client-config]` | Print just the URL for `codex`, `anthropic`, `gemini`, or `gemini-cli`. `--client-config` adds an env-var snippet. |
| `cpa endpoint plan` | Recipe for running one backend instance per provider when hard isolation is required. |
| `cpa logs [tail] [-f] [-n N] [-l LEVEL]` | Tail server logs. `-f` follows. |
| `cpa logs trace [id] [-o file] [-n 50]` | Download the full per-request log blob. With `[id]` omitted, scans recent logs and prompts you to pick one. |
| `cpa logs errors` / `cpa logs download <name>` | List/download saved error log files. |
| `cpa logs clear [-y]` | Wipe the server log buffer. |
| `cpa config get [key] [--full]` | Print full YAML, or look up a key (dotted path supported). |
| `cpa config set <key> <value>` | Fast set: `debug`, `request-log`, `logging-to-file`, `usage-statistics-enabled`, `force-model-prefix`, `ws-auth`, `proxy-url`, `routing.strategy`, `request-retry`, `logs-max-total-size-mb`, `quota-exceeded.switch-project`, `quota-exceeded.switch-preview-model`. |
| `cpa config edit` | Open the YAML in `$EDITOR` (or `nano`) and round-trip the change. |
| `cpa providers ls [provider] [--json]` | List configured provider keys (`gemini\|codex\|claude\|vertex\|openai`). |
| `cpa providers add-model <provider> <index> [model] [-a alias] [-p priority] [-t test-model]` | Add or update a model alias. With `[model]` omitted, fetches upstream models and prompts you to pick. |
| `cpa providers rm-model <provider> <index> <model>` | Remove a model alias. |
| `cpa apikeys ls [--json] / add [key] / rm <index\|key> [-y]` | Manage downstream proxy api-keys (clients use these to talk to the proxy). |
| `cpa doctor` | Diagnose WSL/network issues that block OAuth auto-callback. |

Most `ls`-style commands and `cpa usage` accept `--json` for piping into `jq`.

## Multi-account load balancing

The backend's selector picks the highest `auth.priority` value first; lower
priorities are only used when every higher-priority auth in that provider is
cooling down. `cpa lb` exposes a 3-state convention on top of this:

| State | Mechanism | Meaning |
|---|---|---|
| `ACTIVE` | `priority = 10` (or any value tied for the highest in that provider) | Routed first. |
| `STANDBY` | `priority = 0` (default — backend deletes the field when 0 is sent) | Used only when every ACTIVE peer is exhausted. |
| `DISABLED` | `disabled = true` | Excluded entirely; priority preserved. |

Within a provider, accounts that share the highest priority all render as
ACTIVE. If you have one peer to demote but every account currently shares the
default priority, `cpa lb set <name> standby` warns that the change is a no-op
until at least one peer is promoted to ACTIVE.

## Per-provider endpoints

The backend exposes provider-specific local routes that are locked to one auth
pool by handler type:

| Provider | Endpoint | Notes |
|---|---|---|
| `codex` | `/backend-api/codex/responses` (or `/v1/responses`) | OpenAI Responses protocol — Codex auths only. |
| `anthropic` | `/v1/messages` | Anthropic Messages protocol — Claude auths only. |
| `gemini` | `/v1beta/models/<MODEL>:<METHOD>` | Gemini API — Gemini auths only. |
| `gemini-cli` | `/v1internal:<METHOD>` | Gemini CLI internal — gemini-cli auths only. |
| (mixed) | `/v1/chat/completions` | OpenAI Chat — dispatched by model name across whichever pool covers the requested model. |

Run `cpa endpoint ls` to see this table prefixed with your local base URL plus
a "has auth" indicator. Run `cpa endpoint url <provider> --client-config` to
print env-var snippets ready to paste into client tooling.

**Limitation**: proxy api-keys (`cpa apikeys`) are **not** scoped per provider
on the backend; the same key works against every endpoint above. If you need
hard separation (separate keys, separate auth-files dir, separate process per
provider), `cpa endpoint plan` prints the multi-instance recipe.

**Model whitelist**: each provider's auth file embeds an upstream model
allowlist; the backend rejects requests for models outside that list. If you
need a non-default model, register it via `cpa providers add-model <provider>
<index> <model>` first.

## How OAuth works in this CLI

`cpa login codex` (or any of the four providers):

1. Server gives back `{ url, state }` for the OAuth authorization URL (with `is_webui=true`).
2. CLI prints the URL and tries to open it (`cmd.exe /c start` on WSL → `wslview` → `open` on macOS/Linux native). If every launch path fails you can copy-paste the printed URL.
3. The CLI then **races two paths concurrently**:
   - Auto-poll `GET /get-auth-status?state=…` every 3 s (default 10 min, override with `--timeout`).
   - A paste prompt that accepts the redirect URL at any time (submits via `/oauth-callback`).
4. Whichever wins first, the other is cancelled. The latest auth file matching the provider prefix is printed for confirmation.

`gemini-cli` accepts `--project-id <id>` (or `ALL` to enrol every project the user has access to).

`--manual` skips auto-poll and only accepts a pasted value (URL, bare code, or `code#state`).

`--code <code>` finishes the exchange without opening the browser at all — useful when you already have a code from a previous failed attempt or from another machine.

The paste prompt accepts three formats:

| Pasted value | What we do |
|---|---|
| `http://...?code=...&state=...` | Forward as-is to `/oauth-callback`. |
| `code#state` (Anthropic console format) | Split on `#`, build a synthetic redirect URL, submit. |
| Bare code (e.g. `abc123def…`) | Use the state from `startAuth`, build a synthetic redirect URL, submit. |

### Diagnose WSL networking with `cpa doctor`

If `cpa login` keeps hanging or timing out, run `cpa doctor`. It checks:

- Whether the backend URL is reachable from inside WSL (curl-style probe).
- Whether the backend URL is reachable from the **Windows host** (via `cmd.exe + curl.exe`). This is the real test for OAuth auto-callback because the browser lives on Windows.
- Whether `~/.wslconfig` has `networkingMode=mirrored` (recommended for reliable localhost forwarding).

If the Windows-side reach fails, the doctor prints concrete fixes (enable mirrored mode, check 0.0.0.0 binding, check Windows Firewall, fall back to `--manual`).

### WSL OAuth notes — read this if `cpa login` hangs

If you run the CLI inside WSL and the OAuth provider redirects to `http://localhost:<port>` the redirect target may not reach the backend, because:

- WSL2 *usually* forwards Windows `localhost` to WSL automatically — but only when the backend listens on `0.0.0.0` (not `127.0.0.1`) and Windows Firewall doesn't block the port.
- Mirrored networking mode (Windows 11 22H2+, set `networkingMode=mirrored` in `~/.wslconfig`) makes the forwarding much more reliable. Worth enabling.
- Some providers (Anthropic Claude, in particular) redirect to a public webpage like `console.anthropic.com/oauth/code/callback` rather than `localhost`. In that case there is no auto-callback at all by design; you must copy the URL/code and paste it.

What this means in practice: when `cpa login` opens the browser and you finish authenticating, **watch what happens next**:

- ✅ Browser shows a "success" or "you may close this tab" page → auto-poll detects it and the CLI prints `Authorised (auto-callback).` Done.
- ⚠ Browser shows an error like "this site can't be reached" or a public page with a code/URL → copy the **full URL** from the browser's address bar (or the displayed URL/code) and paste it into the CLI's prompt that's already waiting. The CLI will POST it to `/oauth-callback` and finish.

You don't need to wait for the 10-minute timeout — the paste prompt is live from the start.

## Config file

Plain JSON at `~/.config/cpa/config.json` (or `%APPDATA%/cpa/config.json` on Windows). Override with `CPA_CONFIG=/path/to/file`.

```json
{
  "apiBase": "http://localhost:8317",
  "managementKey": "…"
}
```

The file is `chmod 0600` after every write where supported. Treat the management key as sensitive even on a single-user machine.

## Repo layout

```
src/
  cli/
    index.ts                    # bin entry, commander setup
    commands/                   # one file per subcommand
    state/                      # config + bootstrap (axios singleton init)
    ui/                         # browser opener, table builder, spinner
  services/api/                 # wire-format clients (reused from upstream SPA)
  utils/                        # helpers (usage, latency, log parsing, …)
  types/                        # shared TS types
```

`src/services/api/*` is intentionally untouched apart from `client.ts` losing two `window.dispatchEvent` lines. That folder is the value carried over from the original WebUI.

## Build

| Command | What it does |
|---|---|
| `bun run dev -- <args>` | Run the CLI from source. |
| `bun run build` | Bundle to `dist/cpa.js` (still needs `bun` to run). |
| `bun run build:bin` | Compile to `dist/cpa`, a self-contained executable. |
| `bun run type-check` | `tsc --noEmit`. |

Cross-compile per-platform:

```bash
bun build src/cli/index.ts --compile --target=bun-linux-x64   --outfile dist/cpa-linux-x64
bun build src/cli/index.ts --compile --target=bun-windows-x64 --outfile dist/cpa-win-x64.exe
bun build src/cli/index.ts --compile --target=bun-darwin-arm64 --outfile dist/cpa-mac-arm64
```

## License

MIT — same as the upstream project.
