/**
 * macOS Keychain-backed credentials provider for the DeepSeek Harness.
 *
 * Drop-in replacement for `@deepseek-ai/dsh-credentials-local` on the
 * `ctx.credentials` seam: same abstract `CredentialProvider` contract, same
 * precedence rules, but the stored values live in the login Keychain instead of
 * a plaintext `$DSH_HOME/.credentials.yaml`.
 *
 * Layer order is inherited unchanged from the local provider:
 *
 * ```text
 * inherited process environment      (read-only, wins)
 * > macOS Keychain                   (provider-managed, writable)
 * > <invocation cwd>/.env            (read-only fallback)
 * > $DSH_HOME/.env                   (read-only fallback)
 * ```
 *
 * The inherited environment still wins because `OPENCODE_GO_API_KEY=… dsh` is
 * this run's explicit intent. The Keychain sits where the managed file used to
 * sit, so a key written through the Models page takes effect immediately and is
 * never displaced by a stale `.env`.
 *
 * Two halves, matching the seam:
 * - **refs** — `OPENCODE_GO_API_KEY`-style references resolved per request.
 *   Stored as generic passwords with service `<prefix>:<ref>`.
 * - **records** — `<scope>/<id>` keys owned by a plugin, holding either a
 *   `grant` (arbitrary JSON payload) or an `apiKey`. Stored as generic
 *   passwords with service `<prefix>:record:<scope>/<id>`, the JSON-encoded
 *   record as the password value.
 *
 * Values never touch disk. Reads go through `security find-generic-password`,
 * writes through `security add-generic-password -U` fed over stdin so the
 * secret never appears in the process argument list.
 *
 * @module dsh-credentials-keychain
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Service-name prefix so these entries are recognisable and easy to audit. */
const DEFAULT_SERVICE_PREFIX = 'dsh-credentials'

/** Separator between the prefix and the record key in a record's service name. */
const RECORD_MARKER = 'record'

/** The `security` binary; absolute so a hostile PATH cannot shadow it. */
const SECURITY_BIN = '/usr/bin/security'

/** `security` exits 44 when the requested item does not exist. */
const ERR_SEC_ITEM_NOT_FOUND = 44

/** Run `security` with the given argv, feeding `stdin` when provided. */
function runSecurity(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY_BIN, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: String(stderr ?? '') }))
        return
      }
      resolve(String(stdout ?? ''))
    })
    if (stdin !== undefined) {
      child.stdin.end(stdin)
    } else {
      child.stdin.end()
    }
  })
}

/** Whether a `security` failure means "no such item" rather than a real fault. */
function isMissingItem(error) {
  return error?.code === ERR_SEC_ITEM_NOT_FOUND || /could not be found in the keychain/i.test(error?.stderr ?? '')
}

/** Service name for a reference entry. */
function refService(prefix, ref) {
  return `${prefix}:${ref}`
}

/** Service name for a record entry. */
function recordService(prefix, key) {
  return `${prefix}:${RECORD_MARKER}:${key}`
}

/**
 * Decode the JSON payload of a record entry, treating a corrupt or truncated
 * value as "nothing stored" rather than as a thrown error: a record whose
 * payload cannot be read is indistinguishable from an absent one for every
 * caller, and failing the whole profile load over one bad entry would be worse
 * than reporting it as unset.
 */
function decodeRecord(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The provider. Mount it in place of `dsh-credentials-local`. */
export class KeychainCredentialProvider extends CredentialProvider {
  static Config = z.object({
    servicePrefix: z.string().default(DEFAULT_SERVICE_PREFIX),
    account: z.string().default('dsh')
  })

  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }

  /** A value supplied read-only by the launching environment, if any. */
  inherited(ref) {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== void 0 && entry.value.length > 0 ? entry.value : undefined
  }

  /** A value supplied by the project or user `.env` layer, if any. */
  dotenvFallback(ref) {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== void 0 && entry.value.length > 0 ? entry : undefined
  }

  /** Read one stored value; `undefined` when absent or unreadable. */
  async readStored(service) {
    try {
      const out = await runSecurity(['find-generic-password', '-s', service, '-a', this.config.account, '-w'])
      // `-w` prints the password followed by a newline; strip exactly that one.
      return out.replace(/\n$/, '')
    } catch (error) {
      if (isMissingItem(error)) return undefined
      this.ctx.logger.warn('credentials-keychain: read failed for %s', service)
      this.ctx.logger.warn(error)
      return undefined
    }
  }

  /** Write (or with `value === undefined`, delete) one stored value. */
  async writeStored(service, value) {
    if (value === undefined) {
      try {
        await runSecurity(['delete-generic-password', '-s', service, '-a', this.config.account])
      } catch (error) {
        if (!isMissingItem(error)) throw error
      }
      return
    }
    // Two copies over stdin: `security` prompts for confirmation. Passing the
    // value as argv would expose it in `ps` for the life of the process.
    await runSecurity(
      ['add-generic-password', '-U', '-s', service, '-a', this.config.account, '-w'],
      `${value}\n${value}\n`
    )
  }

  async resolve(ref) {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return { value: inherited, source: 'env' }
    const stored = await this.readStored(refService(this.config.servicePrefix, ref))
    if (stored !== undefined) return { value: stored, source: 'keychain' }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { value: fallback.value, source: fallback.source }
    return undefined
  }

  async describe(ref) {
    if (this.inherited(ref) !== undefined) return { configured: true, source: 'env', writable: false }
    if ((await this.readStored(refService(this.config.servicePrefix, ref))) !== undefined) {
      return { configured: true, source: 'keychain', writable: true }
    }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { configured: true, source: fallback.source, writable: true }
    return { configured: false, writable: true }
  }

  async set(ref, value) {
    if (value.length === 0) {
      throw new Error(`credentials-keychain: an empty value cannot be stored for "${ref}"; use unset`)
    }
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `credentials-keychain: "${ref}" is supplied read-only by the launching environment, so set would be shadowed; unset it in the shell you start dsh from instead`
      )
    }
    await this.writeStored(refService(this.config.servicePrefix, ref), value)
    this.notifyUpdated(ref)
  }

  async unset(ref) {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `credentials-keychain: "${ref}" is supplied read-only by the launching environment, so unset would be shadowed; unset it in the shell you start dsh from instead`
      )
    }
    await this.writeStored(refService(this.config.servicePrefix, ref), undefined)
    this.notifyUpdated(ref)
  }

  async readRecord(key) {
    const raw = await this.readStored(recordService(this.config.servicePrefix, key))
    return raw === undefined ? undefined : decodeRecord(raw)
  }

  async describeRecord(key) {
    const stored = await this.readRecord(key)
    if (stored === undefined) return { configured: false, writable: true }
    return { configured: true, kind: stored.kind, writable: true }
  }

  async listRecords() {
    let out
    try {
      out = await runSecurity(['dump-keychain'])
    } catch (error) {
      this.ctx.logger.warn('credentials-keychain: could not enumerate records')
      this.ctx.logger.warn(error)
      return []
    }
    const marker = `${this.config.servicePrefix}:${RECORD_MARKER}:`
    const keys = new Set()
    for (const match of out.matchAll(/"svce"<blob>="([^"]*)"/g)) {
      const service = match[1]
      if (!service.startsWith(marker)) continue
      try {
        keys.add(parseCredentialKey(service.slice(marker.length)))
      } catch {
        // A malformed service name is not a record this provider owns.
      }
    }
    const records = []
    for (const key of keys) {
      const stored = await this.readRecord(key)
      if (stored !== undefined) records.push({ key, kind: stored.kind })
    }
    return records
  }

  async modifyRecord(key, mutate) {
    const service = recordService(this.config.servicePrefix, key)
    const current = await this.readRecord(key)
    const next = await mutate(current)
    if (next === undefined) return current
    await this.writeStored(service, JSON.stringify(next))
    this.notifyRecordUpdated(key)
    return next
  }

  async deleteRecord(key) {
    const service = recordService(this.config.servicePrefix, key)
    if ((await this.readStored(service)) === undefined) return
    await this.writeStored(service, undefined)
    this.notifyRecordUpdated(key)
  }
}

export { DEFAULT_SERVICE_PREFIX, refService, recordService }
export default KeychainCredentialProvider
