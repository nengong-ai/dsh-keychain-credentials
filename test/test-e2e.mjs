// 端到端：模拟 DSH 的解析路径 —— 用 loader 同款 createRequire 解析插件名
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const profileBase = '/Users/c.k/Library/Application Support/dsh-desktop/harness/profiles/web/'
const pluginName = '/Users/c.k/coding-agent-hub/tools/dsh-keychain-credentials/index.js'

// 1) loader 先试 import(name)
try {
  const m = await import(pluginName)
  console.log('✓ 绝对路径 import 成功:', typeof m.default)
} catch (e) {
  console.log('✗ import 失败:', e.message)
  process.exit(1)
}

// 2) 用 profile 的 baseUrl 解析（loader 的 fallback 路径）
const req = createRequire(new URL('package.json', pathToFileURL(profileBase).href))
try {
  const resolved = req.resolve('@deepseek-ai/dsh-credentials')
  console.log('✓ createRequire(baseUrl) 可解析官方依赖:', resolved.includes('dsh-credentials'))
} catch (e) {
  console.log('! 官方依赖解析:', e.message.slice(0,60))
}

// 3) 关键：验证插件能读到 Keychain 里的真实值
const { Context } = await import('@deepseek-ai/cordis')
const { KeychainCredentialProvider } = await import(pluginName)
const root = new Context()
const p = new KeychainCredentialProvider(root, { servicePrefix: 'dsh-credentials', account: 'dsh' })

for (const ref of ['OPENCODE_GO_API_KEY','DEEPSEEK_API_KEY']) {
  const d = await p.describe(ref)
  const r = await p.resolve(ref)
  const has = r && typeof r.value === 'string' && r.value.length > 0
  console.log(`  ${ref}: describe=${JSON.stringify(d)} resolve有值=${has} source=${r?.source}`)
}
