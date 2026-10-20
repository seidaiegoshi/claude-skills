import { describe, expect, test } from 'claude-code/testing'

import { bandText, setup, submit } from './helpers'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const answered = (text: string) => ({ value: { isAnswered: true as const, text, usage: USAGE } })
const failed = () => ({ value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } })

// タイトル・要約・概要は system の文面で見分ける
const kindOf = (system: string | undefined) =>
  system?.includes('セッション全体') ? 'overview' : system?.includes('要約する') ? 'summary' : 'title'

const finish = async ($: Parameters<typeof bandText>[0], turnId: string, answer: string) => {
  await $.turn.complete({ reason: 'answer', answer, durationMs: 0, isAborted: false, turnId } as never)
}

// 要約 → 概要と続く返事を流し切る
const settle = async (clock: ReturnType<typeof setup>) => {
  for (let i = 0; i < 4; i += 1) await clock.advance(0)
}

describe('入力欄の上の帯のセッションの概要', () => {
  test('最初の指示が終わるまでは概要を出さず、終わると Haiku が付けた概要を「セッション」の文言なしで出す', async ($, on) => {
    const clock = setup(on)
    on('model.complete', (_$, e) =>
      answered(kindOf(e.system) === 'overview' ? '請求書の番号体系の見直し' : '請求書の番号 — 実装中'),
    )

    await submit($, clock, '請求書番号の頭をなくして')
    await $.turn.start({ text: '請求書番号の頭をなくして', turnId: 't1' })
    await settle(clock)
    expect(await bandText($)).not.toMatch(/セッション|請求書の番号体系/)

    await finish($, 't1', '番号を直した')
    await settle(clock)

    const lines = (await bandText($)).split('\n')
    expect(lines).not.toContain('セッション')
    expect(lines).toContain('請求書の番号体系の見直し')
    // 概要の行は進行中の作業のタイトルより上に出す
    expect(lines.indexOf('請求書の番号体系の見直し')).toBeLessThan(lines.indexOf('請求書の番号 — 実装中'))
  })

  test('概要は、要約が付いてから、指示の要点と作業の要約を渡して付け直す。要約の無い指示は1行目で補う', async ($, on) => {
    const clock = setup(on)
    const calls: { kind: string; prompt: string }[] = []
    on('model.complete', (_$, e) => {
      const kind = kindOf(e.system)
      calls.push({ kind, prompt: e.prompt })
      return answered(kind === 'summary' ? '指示: 日付入力の改善\n作業: カレンダー選択を追加した' : '日付入力の改善')
    })

    await submit($, clock, '日付をカレンダーで選べるようにして\nくわしくは下')
    await $.turn.start({ text: '日付をカレンダーで選べるようにして', turnId: 't1' })
    await finish($, 't1', '追加しました')
    await settle(clock)

    const kinds = calls.map(call => call.kind)
    expect(kinds.lastIndexOf('summary')).toBeLessThan(kinds.lastIndexOf('overview'))
    const prompt = calls.findLast(call => call.kind === 'overview')?.prompt ?? ''
    expect(prompt).toMatch(/指示: 日付入力の改善/)
    expect(prompt).toMatch(/作業: カレンダー選択を追加した/)

    await submit($, clock, '色も直して\n詳しくは下')
    await $.turn.start({ text: '色も直して', turnId: 't2' })
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't2' } as never)
    await settle(clock)
    const next = calls.findLast(call => call.kind === 'overview')?.prompt ?? ''
    expect(next).toMatch(/指示: 日付入力の改善/)
    expect(next).toMatch(/指示: 色も直して$/m)
    expect(next).not.toMatch(/詳しくは下/)
  })

  test('概要を付けられなかったときは、前の概要を残す', async ($, on) => {
    const clock = setup(on)
    let overviews = 0
    on('model.complete', (_$, e) => {
      if (kindOf(e.system) !== 'overview') return answered('タイトル')
      overviews += 1
      return overviews === 1 ? answered('最初の概要') : failed()
    })

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await finish($, 't1', '')
    await settle(clock)
    await submit($, clock, '二つ目')
    await $.turn.start({ text: '二つ目', turnId: 't2' })
    await finish($, 't2', '')
    await settle(clock)

    expect(overviews).toBe(2)
    expect((await bandText($)).split('\n')).toContain('最初の概要')
  })

  test('遅れて返った古い概要で、新しい概要を上書きしない', async ($, on) => {
    const clock = setup(on)
    let release: (value: ReturnType<typeof answered>) => void = () => {}
    let overviews = 0
    on('model.complete', (_$, e) => {
      if (kindOf(e.system) !== 'overview') return answered('タイトル')
      overviews += 1
      return overviews === 1
        ? new Promise<ReturnType<typeof answered>>(resolve => {
            release = resolve
          })
        : answered('新しい概要')
    })

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await finish($, 't1', '')
    await settle(clock)
    await submit($, clock, '二つ目')
    await $.turn.start({ text: '二つ目', turnId: 't2' })
    await finish($, 't2', '')
    await settle(clock)
    release(answered('古い概要'))
    await settle(clock)

    const lines = (await bandText($)).split('\n')
    expect(lines).toContain('新しい概要')
    expect(lines).not.toContain('古い概要')
  })
})
