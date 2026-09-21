import { Context } from '@deepseek-ai/cordis'
import { KeychainCredentialProvider } from './index.js'

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
