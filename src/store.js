import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * AI-Company 的 SQLite 持久化层。
 * 所有领域对象均以 JSON 文本保存；调用方可用 atomic 将多次写入合并为一个事务。
 */
export class CompanyStore {
  /** 当前事务嵌套层级，0 表示不在事务中。 */
  depth = 0
  /** 各 SAVEPOINT 层级登记的提交后回调。 */
  committed = []

  constructor(path, report = () => {}) {
    this.report = report
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      this.atomic(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS trigger (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS disposition (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS thread (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ticket (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS decision (
            id TEXT PRIMARY KEY,
            thread TEXT NOT NULL,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS effect (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            seq INTEGER NOT NULL,
            generation INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            due INTEGER NOT NULL,
            since TEXT NOT NULL,
            PRIMARY KEY (kind, key)
          );
          CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
          CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
          CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
        `)
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** 关闭底层数据库连接。 */
  close() {
    this.db.close()
  }

  /** 将查询结果中的 value 列逐行解析为 JSON。 */
  values(sql, ...parameters) {
    return this.db.prepare(sql).all(...parameters)
      .map(row => JSON.parse(String(row.value)))
  }

  /**
   * 在 SAVEPOINT 中同步执行 work，嵌套调用使用新的 SAVEPOINT。
   * 任一层失败只回滚该层；最外层成功释放后才执行全部 afterCommit 回调。
   */
  atomic(work) {
    const level = this.depth++
    const name = `company_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value
    try {
      value = work()
      this.db.exec(`RELEASE ${name}`)
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`)
      this.db.exec(`RELEASE ${name}`)
      // 回滚层及其更深层的回调立即作废，不能泄漏到后续事务。
      this.committed.splice(level)
      throw error
    } finally {
      this.depth--
    }

    // 提交后取出当前层回调，并清除可能残留的更深层记录。
    const actions = this.committed.splice(level)[0] ?? []
    if (level) {
      this.committed[level - 1].push(...actions)
    } else {
      for (const action of actions) {
        try {
          action()
        } catch (error) {
          this.report(error)
        }
      }
    }
    return value
  }

  /** 在事务中登记提交后回调；不在事务中时立即执行。 */
  afterCommit(action) {
    if (this.depth) {
      this.committed[this.depth - 1].push(action)
      return
    }
    try {
      action()
    } catch (error) {
      this.report(error)
    }
  }

  /** 读取一个 KV JSON 值，不存在时返回 undefined。 */
  get(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    return row === undefined ? undefined : JSON.parse(String(row.value))
  }

  /** 写入或更新一个 KV JSON 值。 */
  set(key, value) {
    this.db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value))
  }

  /** 删除一个 KV 值。 */
  delete(key) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  /** 返回以 prefix 开头的键；这里使用二进制相等的前缀比较，不解释 LIKE 通配符。 */
  keys(prefix) {
    return this.db.prepare('SELECT key FROM kv WHERE substr(key, 1, length(?)) = ? ORDER BY key')
      .all(prefix, prefix)
      .map(row => String(row.key))
  }

  /** 当前公司设置；尚未保存时返回 undefined。 */
  settings() {
    return this.get('company-settings')
  }

  /** 保存并返回公司设置。 */
  saveSettings(value) {
    this.set('company-settings', value)
    return value
  }

  triggers = {
    get: id => {
      const row = this.db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
      return row === undefined ? undefined : JSON.parse(String(row.value))
    },
    save: trigger => {
      this.db.prepare(`INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value, at = excluded.at`)
        .run(trigger.id, JSON.stringify(trigger), trigger.at)
    },
    disposition: id => {
      const row = this.db.prepare('SELECT value FROM disposition WHERE id = ?').get(id)
      return row === undefined ? undefined : JSON.parse(String(row.value))
    },
    saveDisposition: (id, value) => {
      this.db.prepare(`INSERT INTO disposition (id, value) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`)
        .run(id, JSON.stringify(value))
    },
    /** 按事件发生时间新到旧排列，同一时间按写入顺序新到旧排列。 */
    list: () => this.values('SELECT value FROM trigger ORDER BY at DESC, rowid DESC'),
  }

  threads = {
    get: key => {
      const row = this.db.prepare('SELECT value FROM thread WHERE key = ?').get(key)
      return row === undefined ? undefined : JSON.parse(String(row.value))
    },
    save: thread => {
      this.db.prepare(`INSERT INTO thread (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(thread.key, JSON.stringify(thread))
    },
    /** 保持首次插入顺序；更新已有 thread 不改变其位置。 */
    list: () => this.values('SELECT value FROM thread ORDER BY rowid'),
    /** 活动集合在 JS 中筛选，避免读取路径依赖生成列或额外索引。 */
    active: () => this.threads.list().filter(thread =>
      (thread.pending?.length ?? 0) > 0 || thread.evaluating !== undefined && thread.evaluating !== null),
  }

  tickets = {
    get: id => {
      const row = this.db.prepare('SELECT value FROM ticket WHERE id = ?').get(id)
      return row === undefined ? undefined : JSON.parse(String(row.value))
    },
    save: ticket => {
      this.db.prepare(`INSERT INTO ticket (id, value) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`)
        .run(ticket.id, JSON.stringify(ticket))
    },
    /** 所有列表均按写入顺序新到旧返回。 */
    list: () => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    active: () => this.tickets.list().filter(ticket => {
      const assignments = ticket.assignments ?? []
      const last = assignments[assignments.length - 1]
      return (ticket.undelivered?.length ?? 0) > 0 || last?.state === 'pending' || last?.state === 'running'
    }),
  }

  decisions = {
    get: id => {
      const row = this.db.prepare('SELECT value FROM decision WHERE id = ?').get(id)
      return row === undefined ? undefined : JSON.parse(String(row.value))
    },
    save: decision => {
      this.db.prepare(`INSERT INTO decision (id, thread, value) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET thread = excluded.thread, value = excluded.value`)
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    /** 同一线程的决策保持插入顺序。 */
    byThread: threadKey => this.values(
      'SELECT value FROM decision WHERE thread = ? ORDER BY rowid', threadKey),
  }

  receipts = {
    get: id => this.values('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** 相同消息 ID 只保留首条回执，返回值表示本次是否新增。 */
    add: message => {
      const receipt = { ...message, status: 'pending' }
      const result = this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(message.id, JSON.stringify(receipt))
      return Number(result.changes) > 0
    },
    /** 将待投递回执标为 sent 或 dropped；已撤回的回执可按原消息重新落账。 */
    settle: (message, outcome) => {
      const settled = outcome === 'sent'
        ? { status: 'sent' }
        : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const updated = this.db.prepare(`UPDATE outbox SET value = json_patch(value, ?)
        WHERE id = ? AND value ->> '$.status' = 'pending'`)
        .run(JSON.stringify(settled), message.id)
      if (Number(updated.changes)) return

      // 已结束的回执保持不变；只有不存在时才补建，防止同一 ID 再次进入队列。
      const receipt = { ...message, ...settled }
      this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(message.id, JSON.stringify(receipt))
    },
    /** 只撤回仍为 pending 的回执，返回值表示是否实际删除。 */
    withdraw: id => Number(this.db.prepare(
      "DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'",
    ).run(id).changes) > 0,
    /** 待投递回执按插入顺序旧到新返回。 */
    waiting: () => this.values(
      "SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** 公司 Outbox 对 ordered 效果做全局串行化，因此无需按会话判断前序阻塞。 */
    behind: () => false,
  }
}

export default CompanyStore
