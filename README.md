# dsh-keychain-credentials

macOS Keychain credentials provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

The stock provider (`dsh-credentials-local`) stores secrets in `$DSH_HOME/.credentials.yaml` with `0600` permissions. As its own README states: that file is protected from other OS users, **but not from the model** — tool processes (bash, filesystem tools) run as the same user and can read it like any other file.

This provider moves secrets into the macOS login keychain. A file that does not exist cannot be `cat`-ed; nothing lands in backups, sync folders, or git.

## What this buys you

- **Fixed:** the secret is no longer a file. The stock file is reachable by every read primitive the model has — `read`, `cat`, `grep`, `tar`, `node -e …`, in-process or subprocess. With this provider, values live in the login keychain.
- **Not fixed (be honest):** while the login keychain is unlocked (the default once you are logged in), any same-user process can read the item by invoking `/usr/bin/security` — the CLI is ACL-trusted and no prompt appears. An agent with an unrestricted shell that *knows to ask the keychain* can still exfiltrate. Pairing with a sandbox that constrains tool subprocesses narrows this; a hard boundary needs OS-level separation (a signed broker with a private access group, e.g. [keyringseam](https://github.com/fieldnote-ops/keyringseam), or a separate OS user).

Net: the bar rises from "any read primitive" to "must exec `/usr/bin/security` as the same user" — a real improvement, not a complete boundary.

## Why this one, not the others

- **Full seam coverage:** implements **both halves** of `ctx.credentials` — `refs` (API keys) **and** `records` (structured credentials like `client-connection/browser-session` grants). Several other providers implement only the refs half, which means DSH's own session records fall back to the plaintext file.
- **Zero build step:** pure JavaScript, no Swift, no code-signing certificate, no Xcode. Install and go.
- **No auth prompts:** reads and writes never ask the user for Touch ID / password. (That is a deliberate trade: keyringseam offers device-owner authentication at the cost of a prompt on every operation.)

## Requirements

- macOS (`/usr/bin/security`)
- DeepSeek Harness ≥ 0.1.0-rc.6

## Install

```sh
dsh plugin --profile web add dsh-keychain-credentials
# or from source:
dsh plugin --profile web add github:<you>/dsh-keychain-credentials
```

Then the bundle's `cordis.patch.yml` disables the stock provider and mounts this one. If you prefer to wire it by hand, add to your patch layer (`~/.dsh/cordis.patch.yml` or `--patch <file>`):

```yaml
- id: credentials
  disabled: true
- insert:
    - id: credentials-keychain
      name: dsh-keychain-credentials
      config:
        servicePrefix: dsh-credentials   # keychain service prefix
        account: dsh                     # keychain account name
```

## Usage

Store a secret (account = credential reference name):

```sh
security add-generic-password -U -s dsh-credentials -a DEEPSEEK_API_KEY -w 'sk-…'
```

The LLM adapter resolves the reference per request — no restart needed after rotation.

Semantics kept from the seam contract:

- Process environment shadows the keychain (per-run operator intent wins).
- An empty stored value counts as absent.
- `set`/`unset` reject while a read-only source (the environment) shadows the ref.
- `describe` checks existence **without reading the value** — a status query never pulls plaintext into the agent process.
- Errors from the `security` CLI are sanitized: exit code and stderr only, never the command line (which would carry the secret on a failed `set`).
- Secrets are always fed to `security` over stdin, never argv, so they never appear in `ps`.
- Values longer than 128 bytes are written through `security -i` rather than the stdin password prompt: that prompt stores at most 128 bytes and truncates anything longer **silently**. Interactive mode has no such limit but reports no failure exit code, so those writes are confirmed by reading the value back. (The account token DSH stores as a `records` entry is one such value.)

## Test

```sh
npm test
```

Requires a real DSH `node_modules` (peer deps) — run from a profile with `@deepseek-ai/dsh-credentials` installed, or symlink one.

## License

MIT
