import { describe, expect, test } from 'claude-code/testing'

import { bandText, complete, setup, submit } from './helpers'

const PROGRESS = 'mcp__session-log__progress'

describe('入力欄の上の帯の進捗バー', () => {
  test('作業中は段階の申告が無くても、段階なしの空のバーを出す', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '文言を直して')
    await $.turn.start({ text: '文言を直して', turnId: 't1' })

    const shown = await bandText($)
    expect(shown).toMatch(/作業中/)
    expect(shown).toMatch(/段階なし/)
    expect(shown).toMatch(/ 0%/)
  })

  test('待機中も直前の作業のタイトルと、終わった進み具合を出し続ける', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '文言を直して')
    await $.turn.start({ text: '文言を直して', turnId: 't1' })
    await complete($, 't1', 'answer')

    const shown = await bandText($)
    expect(shown).toMatch(/文言を直して/)
    expect(shown).toMatch(/完了/)
    expect(shown).toMatch(/100%/)
  })

  test('段階を申告した作業は、最後の done を送らずに終わっても完了なら100%にする', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '一覧を直して')
    await $.turn.start({ text: '一覧を直して', turnId: 't1' })
    await $.tool.call({ tool: PROGRESS, plan: ['調べる', '直す', '確かめる'], done: 2 } as never)
    await complete($, 't1', 'answer')

    const shown = await bandText($)
    expect(shown).toMatch(/3\/3 完了/)
    expect(shown).toMatch(/100%/)
  })

  test('中断した作業は、止まったところの進み具合のまま中断と出す', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '一覧を直して')
    await $.turn.start({ text: '一覧を直して', turnId: 't1' })
    await $.tool.call({ tool: PROGRESS, plan: ['調べる', '直す', '確かめる', '仕上げ'], done: 1 } as never)
    await complete($, 't1', 'aborted')

    const shown = await bandText($)
    expect(shown).toMatch(/中断/)
    expect(shown).toMatch(/ 25%/)
  })
})

describe('帯を押してペインを開け閉めする', () => {
  const mountBand = ($: Parameters<typeof bandText>[0], surface: 'terminal' | 'desktop') =>
    $.ui.mount({
      plugin: 'session-log',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100 },
    } as never)

  // テストのエンジンはペインを持たないので、開いている id だけを覚える偽の実装を置く
  const fakePanes = (on: Parameters<typeof setup>[0]) => {
    const open = new Set<string>()
    on('ui.panes', () => ({
      value: [...open].map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true as const })),
    }))
    on('ui.open', (_$, e) => {
      open.add(e.id)
      return { value: { isPlaced: true as const } }
    })
    on('ui.close', (_$, e) => {
      open.delete(e.id)
      return { value: undefined }
    })
    return open
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: ペインは帯を押すまで開かず、押すと開き、もう一度押すと閉じる`, async ($, on) => {
      const clock = setup(on)
      const open = fakePanes(on)

      await submit($, clock, '文言を直して')
      await $.turn.start({ text: '文言を直して', turnId: 't1' })
      expect(open.has('session-log')).toBe(false)

      const band = await mountBand($, surface)
      await band.press({ key: 'session-log' })
      expect(open.has('session-log')).toBe(true)

      await band.press({ key: 'session-log' })
      expect(open.has('session-log')).toBe(false)
      await band.unmount()
    })
  }
})
