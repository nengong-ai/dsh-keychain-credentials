import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { KeychainCredentialProvider } from '../src/index.js'

// 真实 cordis 容器
const root = new Context()
const events = []
root.on('credentials/reference-updated', (ref) => events.push(['ref', ref]))
root.on('credentials/record-updated', (key) => events.push(['record', key]))

const p = new KeychainCredentialProvider(root, { servicePrefix: 'dsh-credentials-test', account: 'dsh-test' })

const REF = 'PROBE_TEST_KEY'
const SECRET = 'sk-probe-value-1234567890'

console.log('1) 初始 resolve:', await p.resolve(REF))
console.log('2) 初始 describe:', await p.describe(REF))

await p.set(REF, SECRET)
console.log('3) set 后 resolve:', await p.resolve(REF))
console.log('4) set 后 describe:', await p.describe(REF))
console.log('5) 事件:', JSON.stringify(events))

assert.equal((await p.resolve(REF))?.value, SECRET, 'set 后必须原样读回')

await p.unset(REF)
console.log('6) unset 后 resolve:', await p.resolve(REF))

try { await p.set(REF, '') } catch (e) { console.log('7) 空值拒绝 ✓') }

const KEY = 'llm-pi-ai/opencode-go'
await p.modifyRecord(KEY, () => ({ kind: 'apiKey', value: 'sk-record-abc' }))
console.log('8) readRecord:', await p.readRecord(KEY))
console.log('9) describeRecord:', await p.describeRecord(KEY))
console.log('10) listRecords:', JSON.stringify(await p.listRecords()))
await p.deleteRecord(KEY)
console.log('11) delete 后:', await p.readRecord(KEY))

// 12) 长值回归：`security add-generic-password -w` 从 stdin 读密码上限 128 字节，
// 超过会被静默截断（129 字符起只剩 128）。writeStored 对超长值改走 `security -i`
// 交互模式并读回校验。这里用超过上限的纯值覆盖那条分支。
const LONG = `sk-long-${'x'.repeat(200)}-tail`
assert.ok(Buffer.byteLength(LONG, 'utf8') > 128, '前提：用例值必须超过 128 字节')
await p.set(REF, LONG)
assert.equal((await p.resolve(REF))?.value, LONG, '超长值写入后必须原样读回，不能被截断')
console.log('12) 超长值回归 ✓ 写入并读回', Buffer.byteLength(LONG, 'utf8'), '字节')
await p.unset(REF)

// 13) 含引号 + 超长的记录回归：真实账号 token 记录就是这种形态（JSON 里的引号必须
// 在交互模式下正确转义，否则写进去的是一段废值）。
const RECORD = { kind: 'grant', payload: { version: 1, token: 'y'.repeat(80), issuer: 'https://platform.deepseek.com' } }
assert.ok(Buffer.byteLength(JSON.stringify(RECORD), 'utf8') > 128, '前提：用例记录必须超过 128 字节')
await p.modifyRecord(KEY, () => RECORD)
assert.deepEqual(await p.readRecord(KEY), RECORD, '超长且含引号的记录必须原样读回')
console.log('13) 超长含引号记录回归 ✓ 写入并读回', Buffer.byteLength(JSON.stringify(RECORD), 'utf8'), '字节')
await p.deleteRecord(KEY)

console.log('\n全部断言通过 ✓')
