import { describe, expect, test } from 'claude-code/testing'

import { bandText, complete, setup, submit } from './helpers'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// $ の呼び出しを下で答えるフックは { value } で返す
const answered = (text: string) => ({ value: { isAnswered: true as const, text, usage: USAGE } })

describe('入力欄の上の帯のタイトル', () => {
  test('指示が始まると、Haiku が付けたセッションのタイトルを帯に出す', async ($, on) => {
    const clock = setup(on)
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      return answered('日付のカレンダー選択 — 実装中')
    })

    await submit($, clock, '日付の入力をカレンダーで選べるようにして')
    await $.turn.start({ text: '日付の入力をカレンダーで選べるようにして', turnId: 't1' })
    await clock.advance(0)

    expect(prompts.at(-1)).toMatch(/日付の入力をカレンダーで選べるようにして/)
    const shown = await bandText($)
    expect(shown).toMatch(/日付のカレンダー選択 — 実装中/)
    expect(shown).not.toMatch(/日付の入力をカレンダーで選べるようにして/)
  })

  test('Haiku が答えないうちは、指示の1行目を出す', async ($, on) => {
    const clock = setup(on)
    on('model.complete', () => ({
      value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE },
    }))

    await submit($, clock, '一覧を速くして\n詳しくは下の通り')
    await $.turn.start({ text: '一覧を速くして', turnId: 't1' })
    await clock.advance(0)

    expect(await bandText($)).toMatch(/一覧を速くして/)
  })

  test('次の指示でタイトルを付けられなかったら、前の指示のタイトルを残さない', async ($, on) => {
    const clock = setup(on)
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return calls === 1
        ? answered('前の作業のタイトル')
        : { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
    })

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await clock.advance(0)
    await complete($, 't1', 'answer')
    await submit($, clock, '二つ目の指示')
    await $.turn.start({ text: '二つ目の指示', turnId: 't2' })
    await clock.advance(0)

    const shown = await bandText($)
    expect(shown).toMatch(/二つ目の指示/)
    expect(shown).not.toMatch(/前の作業のタイトル/)
  })

  test('段階を申告すると、いまの段階を渡してタイトルを付け直す', async ($, on) => {
    const clock = setup(on)
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      return answered(prompts.length === 1 ? '請求書の番号 — 着手' : '請求書の番号 — テスト中')
    })

    await submit($, clock, '請求書番号の頭をなくして')
    await $.turn.start({ text: '請求書番号の頭をなくして', turnId: 't1' })
    await clock.advance(0)
    await $.tool.call({ tool: 'mcp__session-log__progress', plan: ['テストを書く', '実装', '検証'], done: 0 } as never)
    await clock.advance(0)

    expect(prompts.at(-1)).toMatch(/テストを書く/)
    expect(await bandText($)).toMatch(/請求書の番号 — テスト中/)
  })

  test('遅れて返った古いタイトルで、新しいタイトルを上書きしない', async ($, on) => {
    const clock = setup(on)
    let release: (value: ReturnType<typeof answered>) => void = () => {}
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return calls === 1
        ? new Promise<ReturnType<typeof answered>>(resolve => {
            release = resolve
          })
        : answered('新しいタイトル')
    })

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await clock.advance(0)
    await $.tool.call({ tool: 'mcp__session-log__progress', plan: ['a', 'b', 'c'] } as never)
    await clock.advance(0)
    release(answered('古いタイトル'))
    await clock.advance(0)

    const shown = await bandText($)
    expect(shown).toMatch(/新しいタイトル/)
    expect(shown).not.toMatch(/古いタイトル/)
  })
})
