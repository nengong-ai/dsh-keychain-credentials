// 端到端契约检查：面向官方 DeepSeek Harness 0.2 的挂载形态
//
// 2026-09-29 重写。旧版引用第三方 DSH Desktop 的已退役目录，并假定插件按「绝对路径行」
// 挂载 —— 官方版下这条路径有两个硬问题：
//   1) DSH 0.2 对插件行同样做兼容门禁，peer 范围不含运行时版本 → 整行被禁用 → 启动失败
//   2) 绝对路径加载的插件拿不到宿主 peer 解析（app 的包在 app.asar 里，磁盘上无副本）
// 正确形态是「作为包链接/安装进 profile」，peer 由宿主提供（routeLinked）。
//
// 覆盖：peer 范围 / seam 完整 / 可加载 / Keychain 直读（只报有无，不打印值）
// 用法: node test/test-e2e.mjs [profile 名]（给了 profile 名才检查该 profile 的挂载形态）
import { readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = dirname(HERE)
const PACKAGE_NAME = 'dsh-keychain-credentials'
const APP_PLIST = '/Applications/DeepSeek Harness.app/Contents/Info.plist'
const PROFILE = process.argv[2]

let failed = 0
function check(label, condition, extra = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failed++
}

// 简化版 semver 覆盖判定：只支持本仓库实际使用的「^x.y.z[-pre]」与「>=a <b」两种形式。
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  return m === null ? undefined : { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] }
}
function compare(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch) ||
    ((a.pre === undefined ? 1 : 0) - (b.pre === undefined ? 1 : 0)) ||
    String(a.pre ?? '').localeCompare(String(b.pre ?? ''))
}
function rangeCovers(range, version) {
  const target = parseVersion(version)
  if (target === undefined) return false
  return range.split('||').map((part) => part.trim()).some((part) => {
    const caret = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(part)
    if (caret !== null) {
      const low = { major: +caret[1], minor: +caret[2], patch: +caret[3], pre: caret[4] }
      if (compare(target, low) < 0) return false
      if (low.major > 0) return target.major === low.major
      if (low.minor > 0) return target.major === 0 && target.minor === low.minor
      return target.major === 0 && target.minor === 0 && target.patch === low.patch
    }
    const bounds = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(part)
    if (bounds !== null) {
      const low = parseVersion(bounds[1])
      const high = parseVersion(bounds[2])
      if (low === undefined || high === undefined) return false
      return compare(target, low) >= 0 && compare(target, high) < 0
    }
    return false
  })
}

// 1) 运行时版本 + peer 覆盖（版本读不到就跳过，不让 macOS 路径问题伪装成插件问题）
let runtime
try {
  runtime = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', APP_PLIST], { encoding: 'utf8' }).trim()
} catch { /* 非 macOS 或无官方 app：跳过 */ }
const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
// 参照版本：优先用已安装的 devDependency（它们钉的正是宿主版本）；cordis/schemastery 这类
// 不跟随 DSH 版本号的 peer，不能拿 app 版本去比。
function installedVersion(name) {
  try { return JSON.parse(readFileSync(join(PKG_DIR, 'node_modules', name, 'package.json'), 'utf8')).version } catch { return undefined }
}
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  const reference = installedVersion(name) ?? (name.startsWith('@deepseek-ai/dsh-') ? runtime : undefined)
  if (reference === undefined || reference.length === 0) {
    console.log(`! peer ${name}: 无参照版本（未装 devDependency 且非 dsh-*），跳过`)
    continue
  }
  check(`peer ${name} 覆盖 ${reference}`, rangeCovers(range, reference), range)
}

// 2) 可加载 + 完整 seam
const { Context } = await import('@deepseek-ai/cordis')
const { KeychainCredentialProvider } = await import('../src/index.js')
const provider = new KeychainCredentialProvider(new Context(), { servicePrefix: 'dsh-credentials-e2e', account: 'dsh-e2e' })
const SEAM = ['resolve', 'describe', 'set', 'unset', 'readRecord', 'describeRecord', 'listRecords', 'modifyRecord', 'deleteRecord']
const missing = SEAM.filter((name) => typeof provider[name] !== 'function')
check('插件加载并实现全部 9 个 seam 方法', missing.length === 0, missing.length > 0 ? `缺: ${missing.join(',')}` : '')

// 3) 挂载形态（仅在指明 profile 时检查）
if (PROFILE !== undefined) {
  const profileDir = join(homedir(), '.dsh/profiles', PROFILE)
  if (existsSync(profileDir)) {
    const linked = join(profileDir, 'node_modules', PACKAGE_NAME)
    let linkOk = false
    let linkTarget = ''
    if (existsSync(linked)) {
      const stat = lstatSync(linked)
      linkOk = stat.isSymbolicLink()
      linkTarget = linkOk ? readlinkSync(linked) : '(非软链)'
    }
    check(`profile ${PROFILE} 里 ${PACKAGE_NAME} 是软链（链接形态）`, linkOk, linkTarget)
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    check(`profile ${PROFILE} 的 patch 用包名引用（非绝对路径）`, patch.includes(`name: ${PACKAGE_NAME}`) || patch.includes(`name: '${PACKAGE_NAME}'`))
    check('patch 禁用了明文 credentials 行', /- id: credentials\b[\s\S]{0,60}disabled: true/.test(patch))
  } else {
    console.log(`! 未找到 profile 目录 ${profileDir}`)
  }
}

// 4) Keychain 真实引用（只报有无，不打印值）
for (const ref of ['OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY']) {
  const described = await provider.describe(ref)
  const resolved = await provider.resolve(ref)
  const hasValue = resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0
  console.log(`  ${ref}: configured=${described.configured} source=${described.source ?? '-'} 有值=${hasValue}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
