import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanyStore } from '../src/store.js'

/** 每个测试只创建并清理自己的随机临时目录。 */
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-company-store-'))
  const path = join(directory, 'nested', 'state', 'company.sqlite')
  const stores = new Set()
  t.after(() => {
    for (const store of stores) {
      try { store.close() } catch { /* 测试已显式关闭时无需重复处理。 */ }
    }
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    path,
    open(report) {
      const store = new CompanyStore(path, report)
      stores.add(store)
      return store
    },
    close(store) {
      store.close()
      stores.delete(store)
    },
  }
}

function trigger(id, at, text = id) {
  return { id, at, text, source: 'test', meta: {} }
}

function thread(key, pending = [], evaluating) {
  return { key, pending, ...evaluating === undefined ? {} : { evaluating } }
}

function ticket(id, patch = {}) {
  return { id, undelivered: [], assignments: [], ...patch }
}

function decision(id, threadKey) {
  return { id, threadKey, kind: 'accept', triggerIds: [] }
}

function message(id, text = id) {
  return {
    id,
    text,
    kind: 'reply',
    channel: { source: 'test', thread: 'thread-1' },
  }
}

test('KV 保存 JSON、更新删除，并按字面精确前缀列键', t => {
  const env = database(t)
  const store = env.open()

  assert.equal(store.get('missing'), undefined)
  store.set('company-alpha', { nested: { values: [1, true, null] } })
  store.set('company-beta', [1, '二'])
  assert.deepEqual(store.get('company-alpha'), { nested: { values: [1, true, null] } })

  store.set('company-alpha', { version: 2 })
  store.set('other', true)
  assert.deepEqual(store.get('company-alpha'), { version: 2 })
  assert.deepEqual(store.keys('company-'), ['company-alpha', 'company-beta'])
  assert.deepEqual(store.keys(''), ['company-alpha', 'company-beta', 'other'])

  // %、_、反斜杠和大小写都只能是普通前缀字符，不能被当成模式或忽略。
  store.set('literal%_\\one', 1)
  store.set('literal%_\\two', 2)
  store.set('literalXX/one', 3)
  store.set('Literal%_\\upper', 4)
  assert.deepEqual(store.keys('literal%_\\'), ['literal%_\\one', 'literal%_\\two'])

  store.delete('company-beta')
  assert.equal(store.get('company-beta'), undefined)
  assert.deepEqual(store.keys('company-'), ['company-alpha'])

  assert.equal(String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal')
  assert.equal(Number(store.db.prepare('PRAGMA synchronous').get().synchronous), 2)
})

test('settings 与 KV 在 close 后重开恢复', t => {
  const env = database(t)
  const first = env.open()
  const settings = { paused: false, policy: { mode: 'observe', owners: ['alice'] } }

  assert.equal(first.settings(), undefined)
  assert.equal(first.saveSettings(settings), settings)
  first.set('persistent-value', { answer: 42 })
  first.triggers.save(trigger('persisted-trigger', '2026-01-01T00:00:00.000Z'))
  assert.deepEqual(first.settings(), settings)
  env.close(first)

  const second = env.open()
  assert.deepEqual(second.settings(), settings)
  assert.deepEqual(second.get('persistent-value'), { answer: 42 })
  assert.deepEqual(second.triggers.get('persisted-trigger'), trigger('persisted-trigger', '2026-01-01T00:00:00.000Z'))

  const updated = { ...settings, paused: true }
  assert.equal(second.saveSettings(updated), updated)
  env.close(second)
  const third = env.open()
  assert.deepEqual(third.settings(), updated)
})

test('Trigger 与 disposition 可读写，Trigger 列表按时间新到旧', t => {
  const env = database(t)
  const store = env.open()
  const oldest = trigger('trigger-1', '2026-01-01T00:00:00.000Z')
  const newest = trigger('trigger-2', '2026-01-03T00:00:00.000Z')
  const middle = trigger('trigger-3', '2026-01-02T00:00:00.000Z')

  assert.equal(store.triggers.get(oldest.id), undefined)
  store.triggers.save(oldest)
  store.triggers.save(newest)
  store.triggers.save(middle)
  assert.deepEqual(store.triggers.get(oldest.id), oldest)
  assert.deepEqual(store.triggers.list().map(item => item.id), ['trigger-2', 'trigger-3', 'trigger-1'])

  const replacement = trigger('trigger-1', '2026-01-04T00:00:00.000Z', 'updated')
  store.triggers.save(replacement)
  assert.deepEqual(store.triggers.get('trigger-1'), replacement)
  assert.deepEqual(store.triggers.list().map(item => item.id), ['trigger-1', 'trigger-2', 'trigger-3'])

  assert.equal(store.triggers.disposition('trigger-1'), undefined)
  const disposition = { fanout: ['ticket-1'], at: '2026-01-04T00:00:01.000Z' }
  store.triggers.saveDisposition('trigger-1', disposition)
  assert.deepEqual(store.triggers.disposition('trigger-1'), disposition)
  const filtered = { filtered: { code: 'scope' }, fanout: [] }
  store.triggers.saveDisposition('trigger-1', filtered)
  assert.deepEqual(store.triggers.disposition('trigger-1'), filtered)
})

test('Thread 保持插入序，active 筛选 pending 或非空 evaluating', t => {
  const env = database(t)
  const store = env.open()
  store.threads.save(thread('thread-1'))
  store.threads.save(thread('thread-2', ['trigger-1']))
  store.threads.save(thread('thread-3', [], { id: 'eval-1' }))
  store.threads.save(thread('thread-4', [], null))

  assert.deepEqual(store.threads.list().map(item => item.key), ['thread-1', 'thread-2', 'thread-3', 'thread-4'])
  assert.deepEqual(store.threads.active().map(item => item.key), ['thread-2', 'thread-3'])
  assert.deepEqual(store.threads.get('thread-3'), thread('thread-3', [], { id: 'eval-1' }))
  assert.equal(store.threads.get('unknown'), undefined)

  // 更新已有记录不改变首次插入位置。
  store.threads.save(thread('thread-1', ['trigger-2']))
  assert.deepEqual(store.threads.list().map(item => item.key), ['thread-1', 'thread-2', 'thread-3', 'thread-4'])
  assert.deepEqual(store.threads.active().map(item => item.key), ['thread-1', 'thread-2', 'thread-3'])
})

test('Ticket 的 list/open/active 均为新到旧，active 只看未投递与最后 assignment', t => {
  const env = database(t)
  const store = env.open()
  store.tickets.save(ticket('ticket-1', { ended: { at: '2026-01-01T00:00:00.000Z' } }))
  store.tickets.save(ticket('ticket-2'))
  store.tickets.save(ticket('ticket-3', { undelivered: ['input-1'] }))
  store.tickets.save(ticket('ticket-4', { assignments: [{ state: 'done' }, { state: 'pending' }] }))
  store.tickets.save(ticket('ticket-5', { assignments: [{ state: 'running' }, { state: 'done' }] }))
  store.tickets.save(ticket('ticket-6', { assignments: [{ state: 'running' }] }))

  assert.deepEqual(store.tickets.list().map(item => item.id),
    ['ticket-6', 'ticket-5', 'ticket-4', 'ticket-3', 'ticket-2', 'ticket-1'])
  assert.deepEqual(store.tickets.open().map(item => item.id),
    ['ticket-6', 'ticket-5', 'ticket-4', 'ticket-3', 'ticket-2'])
  assert.deepEqual(store.tickets.active().map(item => item.id), ['ticket-6', 'ticket-4', 'ticket-3'])
  assert.deepEqual(store.tickets.get('ticket-2'), ticket('ticket-2'))
  assert.equal(store.tickets.get('unknown'), undefined)
})

test('Decision 可按 ID 读写，byThread 保持插入序', t => {
  const env = database(t)
  const store = env.open()
  const first = decision('decision-1', 'thread-a')
  const other = decision('decision-2', 'thread-b')
  const third = decision('decision-3', 'thread-a')
  store.decisions.save(first)
  store.decisions.save(other)
  store.decisions.save(third)

  assert.deepEqual(store.decisions.get('decision-2'), other)
  assert.deepEqual(store.decisions.byThread('thread-a'), [first, third])
  assert.deepEqual(store.decisions.byThread('thread-b'), [other])
  assert.deepEqual(store.decisions.byThread('missing'), [])

  const updated = { ...first, kind: 'reopen' }
  store.decisions.save(updated)
  assert.deepEqual(store.decisions.byThread('thread-a'), [updated, third])
})

test('atomic 支持嵌套 SAVEPOINT，内层或外层失败均正确回滚', t => {
  const env = database(t)
  const store = env.open()
  store.set('stable', { kept: true })

  const result = store.atomic(() => {
    store.set('outer', 'before')
    try {
      store.atomic(() => {
        store.set('discarded-inner', true)
        store.set('outer', 'inner')
        throw new Error('inner rollback')
      })
    } catch (error) {
      assert.match(error.message, /inner rollback/)
    }
    store.set('outer', 'after')
    store.atomic(() => store.set('kept-inner', 42))
    return 'return value'
  })

  assert.equal(result, 'return value')
  assert.equal(store.get('outer'), 'after')
  assert.equal(store.get('discarded-inner'), undefined)
  assert.equal(store.get('kept-inner'), 42)

  assert.throws(() => store.atomic(() => {
    store.set('discarded-outer', true)
    store.atomic(() => store.set('discarded-nested', true))
    throw new Error('outer rollback')
  }), /outer rollback/)
  assert.equal(store.get('discarded-outer'), undefined)
  assert.equal(store.get('discarded-nested'), undefined)
  assert.equal(store.get('kept-inner'), 42)
  assert.deepEqual(store.get('stable'), { kept: true })
})

test('afterCommit 仅在最外层提交后执行，回滚丢弃且异常交给 report', t => {
  const env = database(t)
  const errors = []
  const events = []
  const store = env.open(error => errors.push(error))

  store.atomic(() => {
    store.afterCommit(() => events.push('outer-start'))
    store.atomic(() => store.afterCommit(() => events.push('inner-kept')))
    try {
      store.atomic(() => {
        store.afterCommit(() => events.push('inner-discarded'))
        throw new Error('discard inner callback')
      })
    } catch { /* 外层继续提交。 */ }
    store.afterCommit(() => events.push('outer-end'))
  })
  assert.deepEqual(events, ['outer-start', 'inner-kept', 'outer-end'])

  assert.throws(() => store.atomic(() => {
    store.set('rolled-back', true)
    store.afterCommit(() => events.push('outer-discarded'))
    throw new Error('rollback outer callback')
  }), /rollback outer callback/)
  assert.equal(store.get('rolled-back'), undefined)
  assert.deepEqual(events, ['outer-start', 'inner-kept', 'outer-end'])

  store.afterCommit(() => events.push('immediate'))
  const expected = new Error('callback failure')
  store.atomic(() => {
    store.afterCommit(() => { throw expected })
    store.afterCommit(() => events.push('after-callback-error'))
  })
  assert.deepEqual(errors, [expected])
  assert.deepEqual(events, ['outer-start', 'inner-kept', 'outer-end', 'immediate', 'after-callback-error'])
})

test('receipts 幂等添加、结算、撤回与 waiting 顺序正确', t => {
  const env = database(t)
  const store = env.open()
  const first = message('message-1', 'first')
  const second = message('message-2', 'second')

  assert.equal(store.receipts.get(first.id), undefined)
  assert.equal(store.receipts.add(first), true)
  assert.equal(store.receipts.add({ ...first, text: 'duplicate must not replace' }), false)
  assert.deepEqual(store.receipts.get(first.id), { ...first, status: 'pending' })
  assert.equal(store.receipts.add(second), true)
  assert.deepEqual(store.receipts.waiting().map(item => item.id), ['message-1', 'message-2'])
  assert.equal(store.receipts.behind('message-2', 3), false)

  store.receipts.settle(first, 'sent')
  assert.equal(store.receipts.get(first.id).status, 'sent')
  assert.equal(store.receipts.add(first), false)
  assert.equal(store.receipts.get(first.id).status, 'sent')
  assert.deepEqual(store.receipts.waiting().map(item => item.id), ['message-2'])
  assert.equal(store.receipts.withdraw(first.id), false)

  assert.equal(store.receipts.withdraw(second.id), true)
  assert.equal(store.receipts.withdraw(second.id), false)
  assert.equal(store.receipts.get(second.id), undefined)
  assert.deepEqual(store.receipts.waiting(), [])

  // 投递途中被撤回时，settle 仍能补记最终回执。
  store.receipts.settle(second, 'channelGone')
  const dropped = store.receipts.get(second.id)
  assert.equal(dropped.status, 'dropped')
  assert.equal(dropped.dropped.reason, 'channelGone')
  assert.equal(typeof dropped.dropped.at, 'string')

  const third = message('message-3')
  assert.equal(store.receipts.add(third), true)
  store.receipts.settle(third, 'dropped')
  assert.equal(store.receipts.get(third.id).status, 'dropped')
  assert.equal(store.receipts.withdraw(third.id), false)
})

test('effect 表结构支持上游 Effects 的 SQL 与复合主键', t => {
  const env = database(t)
  const store = env.open()

  assert.deepEqual(store.db.prepare('PRAGMA table_info(effect)').all().map(column => column.name), [
    'kind', 'key', 'value', 'seq', 'generation', 'attempts', 'error', 'due', 'since',
  ])
  assert.deepEqual(store.db.prepare('PRAGMA index_info(effect_due)').all()
    .sort((a, b) => a.seqno - b.seqno).map(column => column.name), ['kind', 'due', 'seq'])

  // 与上游 Effects.enqueue 使用同一条 upsert；seq 保持队位，generation 标识载荷更新。
  const enqueue = store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE
    SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
  const firstAt = '2026-01-01T00:00:00.000Z'
  const secondAt = '2026-01-01T00:00:01.000Z'
  enqueue.run('reply', 'message-1', JSON.stringify({ text: 'old' }), 1, 100, firstAt)

  let row = store.db.prepare("SELECT * FROM effect WHERE kind = 'reply' AND key = 'message-1'").get()
  assert.equal(row.seq, 1)
  assert.equal(row.generation, 0)
  assert.equal(row.attempts, 0)
  assert.equal(row.error, '')
  assert.equal(row.due, 100)
  assert.equal(row.since, firstAt)

  enqueue.run('reply', 'message-1', JSON.stringify({ text: 'new' }), 2, 200, secondAt)
  row = store.db.prepare("SELECT * FROM effect WHERE kind = 'reply' AND key = 'message-1'").get()
  assert.equal(row.seq, 1)
  assert.equal(row.generation, 1)
  assert.equal(row.due, 200)
  assert.deepEqual(JSON.parse(row.value), { text: 'new' })

  enqueue.run('notice', 'message-1', '{}', 3, 300, secondAt)
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS count FROM effect').get().count), 2)
  const queued = store.db.prepare('SELECT kind, key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq')
    .all('reply')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].key, 'message-1')
})
