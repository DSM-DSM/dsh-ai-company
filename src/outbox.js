// 公司结果 Outbox：先持久化，再向请求方 Session 投递；失败由 Effects 退避重试。
import { Later } from '../vendor/dsh-superagent/lib/company-kernel.js'

export class CompanyOutbox {
  constructor({ store, effects, sessions, paused }) {
    this.store = store
    this.sessions = sessions
    this.paused = paused
    effects.handle('reply', (_payload, id) => this.deliver(id), {
      limit: () => paused() ? 0 : 1,
      retry: [2000, 60_000],
      ordered: true,
    })
    this.effects = effects
  }

  send(message) {
    this.store.atomic(() => {
      if (this.store.receipts.add(message)) this.effects.enqueue('reply', message.id, {})
    })
  }

  status(id) { return this.store.receipts.get(id)?.status }

  withdraw(id) {
    this.store.atomic(() => {
      if (this.store.receipts.withdraw(id)) this.effects.cancel('reply', id)
    })
  }

  async deliver(id) {
    const receipt = this.store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (this.paused()) throw new Later('AI-Company 已暂停')
    const sessionId = receipt.channel?.address?.sessionId
    if (!sessionId) {
      this.store.receipts.settle(receipt, 'channelGone')
      return
    }
    const delivered = await this.sessions.promptReport(sessionId, `outbox:${id}`, receipt.text, 'steer')
    this.store.receipts.settle(receipt, delivered?.deadLetter ? 'channelGone' : 'sent')
  }
}
