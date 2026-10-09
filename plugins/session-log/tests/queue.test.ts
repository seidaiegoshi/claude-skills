import { describe, expect, test } from 'claude-code/testing'

import { complete, paneText, setup, submit } from './helpers'

describe('作業中に打った指示の待ち', () => {
  test('作業中に打った指示は待ちになり、自分のターンが始まると作業中に移る', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await submit($, clock, '二つ目', 't1')

    let shown = await paneText($)
    expect(shown).toMatch(/作業中 #1/)
    expect(shown).toMatch(/待ち 1番目 #2/)

    await complete($, 't1', 'answer')
    shown = await paneText($)
    expect(shown).toMatch(/完了 #1/)
    expect(shown).toMatch(/待ち 1番目 #2/)

    await $.turn.start({ text: '二つ目', turnId: 't2' })
    shown = await paneText($)
    expect(shown).toMatch(/作業中 #2/)
    expect(shown).not.toMatch(/待ち \d+番目/)
  })

  test('走っているターンに取り込まれた待ちは作業中になり、そのターンと一緒に終わる', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await submit($, clock, '追加の指示', 't1')
    await $.prompt.attachment({ type: 'queued_command', text: 'The user sent: 追加の指示' } as never)

    let shown = await paneText($)
    expect(shown).toMatch(/作業中 #2/)
    expect(shown).not.toMatch(/待ち \d+番目/)

    await complete($, 't1', 'answer')
    shown = await paneText($)
    expect(shown).toMatch(/完了 #1/)
    expect(shown).toMatch(/完了 #2/)
  })

  test('中断すると待ちの指示も中断になる', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await submit($, clock, '二つ目', 't1')
    await complete($, 't1', 'aborted')

    const shown = await paneText($)
    expect(shown).toMatch(/中断 #1/)
    expect(shown).toMatch(/中断 #2/)
  })
})

describe('モデルのタスク一覧', () => {
  test('TaskCreate で積み、TaskUpdate で状態を変え、deleted で消す', async ($, on) => {
    let created = 0
    on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({
      result: { task: { id: String(++created), subject: e.subject } },
    }))
    on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
      result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
    }))

    await $.tool.call({ tool: 'TaskCreate', subject: '型を読む', description: '' })
    await $.tool.call({ tool: 'TaskCreate', subject: '実装する', description: '' })
    await $.tool.call({ tool: 'TaskCreate', subject: '捨てる作業', description: '' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' })

    const shown = await paneText($)
    expect(shown).toMatch(/タスク 残り2/)
    expect(shown.indexOf('実装する')).toBeLessThan(shown.indexOf('型を読む'))
    expect(shown).not.toMatch(/捨てる作業/)
  })

  test('TodoWrite は一覧を丸ごと置き換え、終わったタスクは出さない', async ($, on) => {
    on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))

    await $.tool.call({
      tool: 'TodoWrite',
      todos: [{ content: '古い作業', status: 'pending', activeForm: '' }],
    })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: '終わった作業', status: 'completed', activeForm: '' },
        { content: '進めている作業', status: 'in_progress', activeForm: '' },
      ],
    })

    for (const surface of ['terminal', 'desktop'] as const) {
      const shown = await paneText($, surface)
      expect(shown).toMatch(/タスク 残り1/)
      expect(shown).toMatch(/進めている作業/)
      expect(shown).not.toMatch(/終わった作業/)
      expect(shown).not.toMatch(/古い作業/)
    }
  })
})
