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

# 3. Inspect the credentials that landed.
cpa auth ls

# 4. Watch usage + recent requests.
cpa usage --last 24h
cpa logs --follow
cpa logs trace <request-id>     # full per-request blob
```

## Command reference

| Command | What it does |
|---|---|
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
| `cpa logs [tail] [-f] [-n N] [-l LEVEL]` | Tail server logs. `-f` follows. |
| `cpa logs trace <id> [-o file]` | Download the full per-request log blob. |
| `cpa logs errors` / `cpa logs download <name>` | List/download saved error log files. |
| `cpa logs clear [-y]` | Wipe the server log buffer. |
| `cpa config get [key] [--full]` | Print full YAML, or look up a key (dotted path supported). |
| `cpa config set <key> <value>` | Fast set: `debug`, `request-log`, `logging-to-file`, `usage-statistics-enabled`, `force-model-prefix`, `ws-auth`, `proxy-url`, `routing.strategy`, `request-retry`, `logs-max-total-size-mb`, `quota-exceeded.switch-project`, `quota-exceeded.switch-preview-model`. |
| `cpa config edit` | Open the YAML in `$EDITOR` (or `nano`) and round-trip the change. |
| `cpa providers ls [provider]` | List configured provider keys (`gemini\|codex\|claude\|vertex\|openai`). |
| `cpa providers add-model <provider> <index> <model> [-a alias] [-p priority] [-t test-model]` | Add or update a model alias on a provider key entry. |
| `cpa providers rm-model <provider> <index> <model>` | Remove a model alias. |
| `cpa apikeys ls / add [key] / rm <index\|key> [-y]` | Manage downstream proxy api-keys (clients use these to talk to the proxy). |

## How OAuth works in this CLI

`cpa login codex` (or any of the four providers):

1. Server gives back `{ url, state }` for the OAuth authorization URL (with `is_webui=true`).
2. CLI prints the URL and tries to open it (`cmd.exe /c start` on WSL → `wslview` → `open` on macOS/Linux native). If everything fails you can copy-paste the printed URL.
3. CLI polls `GET /get-auth-status?state=…` every 3 s for up to 5 minutes.
4. On `status: ok` the server has already exchanged the code for a token and written an auth file. CLI lists the newest file matching the provider prefix.
5. If the auto-callback can't reach the server (uncommon for localhost), pass `--manual` (or wait for the timeout) and paste the redirect URL — the CLI POSTs it to `/oauth-callback`.

`gemini-cli` accepts `--project-id <id>` (or `ALL` to enrol every project the user has access to).

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
