import { describe, expect, test } from 'claude-code/testing'

import { bandText, complete, setup, submit } from './helpers'

const notify = ($: Parameters<typeof bandText>[0], taskId: string) =>
  $.prompt.submit({
    text: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>`,
    origin: { kind: 'task-notification' },
    wait: false,
  } as never)

describe('バックグラウンドの作業', () => {
  test('バックグラウンドのサブエージェントが残っているうちは、指示が終わっても完了と出さず件数を出す', async ($, on) => {
    const clock = setup(on)
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }) as never)

    await submit($, clock, '調べて')
    await $.turn.start({ text: '調べて', turnId: 't1' })
    await $.agent.spawn({ prompt: '調べる', background: true } as never)
    await complete($, 't1', 'answer')

    const waiting = await bandText($)
    expect(waiting).toMatch(/バックグラウンド 1件/)
    expect(waiting).not.toMatch(/完了/)

    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 'a1t', agentId: 'a1' } as never)
    expect(await bandText($)).toMatch(/完了/)
  })

  test('作業中でも、バックグラウンドの作業が残っていれば状態の欄に件数を添える', async ($, on) => {
    const clock = setup(on)
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }) as never)

    await submit($, clock, '調べて')
    await $.turn.start({ text: '調べて', turnId: 't1' })
    expect(await bandText($)).not.toMatch(/バックグラウンド/)

    await $.agent.spawn({ prompt: '調べる', background: true } as never)
    const working = await bandText($)
    expect(working).toMatch(/作業中 ・ バックグラウンド 1件/)
    expect(working.match(/バックグラウンド/g)).toHaveLength(1)
  })

  test('バックグラウンドの Bash は、終わりの通知が来るまで残り、通知の作業中は作業中に戻す', async ($, on) => {
    const clock = setup(on)
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    }) as never)

    await submit($, clock, 'テストを回して')
    await $.turn.start({ text: 'テストを回して', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true } as never)
    await complete($, 't1', 'answer')
    expect(await bandText($)).toMatch(/バックグラウンド 1件/)

    await notify($, 'b1')
    await $.turn.start({ text: '<task-notification>', turnId: 't2' })
    const working = await bandText($)
    expect(working).toMatch(/作業中/)
    expect(working).not.toMatch(/バックグラウンド/)

    await complete($, 't2', 'answer')
    expect(await bandText($)).toMatch(/完了/)
  })

  test('前景で走らせた Bash はバックグラウンドに数えない', async ($, on) => {
    const clock = setup(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)

    await submit($, clock, '確かめて')
    await $.turn.start({ text: '確かめて', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await complete($, 't1', 'answer')

    const shown = await bandText($)
    expect(shown).toMatch(/完了/)
    expect(shown).not.toMatch(/バックグラウンド/)
  })
})
