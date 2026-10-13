import { describe, expect, test } from 'claude-code/testing'

import { bandText, paneText, setup, submit, type Engine } from './helpers'

const PROGRESS = 'mcp__session-log__progress'
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const answered = (text: string) => ({ value: { isAnswered: true as const, text, usage: USAGE } })

const finish = ($: Engine, turnId: string, answer: string) =>
  $.turn.complete({ reason: 'answer', answer, durationMs: 0, isAborted: false, turnId })

const cardColors = async ($: Engine, surface: 'terminal' | 'desktop') => {
  const ui = await $.ui.mount({
    plugin: 'session-log',
    surface,
    component: 'Pane',
    requestId: 'session-log',
    props: { title: '指示の履歴', isFocused: false },
  } as never)
  const boxes = await ui.findAll({ type: 'Box' })
  const svgs = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  return { colors: boxes.map(box => box.props.borderColor).filter(Boolean), svgCount: svgs.length }
}

describe('入力欄の上の帯', () => {
  test('タイトルの頭に状態の矢印や印を付けない', async ($, on) => {
    const clock = setup(on)

    await submit($, clock, '文言を直して')
    await $.turn.start({ text: '文言を直して', turnId: 't1' })
    expect(await bandText($)).not.toMatch(/[▶✓■✗]/)

    await finish($, 't1', '')
    expect(await bandText($)).not.toMatch(/[▶✓■✗]/)
  })
})

describe('ペインのカード', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: 作業中のカードは青い枠で段階を出し、進捗バーは出さない`, async ($, on) => {
      const clock = setup(on)

      await submit($, clock, '一覧を直して')
      await $.turn.start({ text: '一覧を直して', turnId: 't1' })
      await $.tool.call({ tool: PROGRESS, plan: ['調べる', '直す', '確かめる'], done: 1 } as never)

      const shown = await paneText($, surface)
      expect(shown).toMatch(/調べる/)
      expect(shown).toMatch(/確かめる/)
      expect(shown).not.toMatch(/%|█|░/)
      const { colors, svgCount } = await cardColors($, surface)
      expect(colors).toContain('blue')
      expect(svgCount).toBe(0)
    })
  }

  test('終わった指示は、Haiku が要約した指示と作業を出し、全文は出さない', async ($, on) => {
    const clock = setup(on)
    const prompts: string[] = []
    on('model.complete', (_$, e) => {
      if (!e.system?.includes('要約')) return answered('タイトル')
      prompts.push(e.prompt)
      return answered('指示: 一覧の見出しの文言修正\n作業: 見出しを3か所直し、テストを通した')
    })

    await submit($, clock, '一覧の見出しの文言を直して\n対象は下の3か所')
    await $.turn.start({ text: '一覧の見出しの文言を直して', turnId: 't1' })
    await finish($, 't1', '見出しを3か所直しました。テストは通っています。')
    await clock.advance(0)

    expect(prompts.at(-1)).toMatch(/見出しを3か所直しました/)
    const shown = await paneText($)
    expect(shown).toMatch(/指示 一覧の見出しの文言修正/)
    expect(shown).toMatch(/作業 見出しを3か所直し、テストを通した/)
    expect(shown).not.toMatch(/対象は下の3か所/)
  })

  test('要約が付かないうちは、指示の1行目だけを出す', async ($, on) => {
    const clock = setup(on)
    on('model.complete', () => ({
      value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE },
    }))

    await submit($, clock, '一覧を速くして\n詳しくは下の通り')
    await $.turn.start({ text: '一覧を速くして', turnId: 't1' })
    await finish($, 't1', '速くしました。')
    await clock.advance(0)

    const shown = await paneText($)
    expect(shown).toMatch(/指示 一覧を速くして/)
    expect(shown).not.toMatch(/詳しくは下の通り/)
    expect(shown).not.toMatch(/^作業 /m)
  })

  test('途中から読み込んだ過去の指示も、直近のものは返答から要約を付ける', async ($, on) => {
    const clock = setup(on)
    const prompts: string[] = []
    on('session.messages', () => ({
      value: [
        { role: 'user' as const, text: '古い指示', toolUses: [] },
        { role: 'assistant' as const, text: '古い作業を終えました。', toolUses: [] },
        { role: 'user' as const, text: '請求書の番号を直して', toolUses: [] },
        { role: 'assistant' as const, text: '調べます。', toolUses: [] },
        { role: 'assistant' as const, text: '番号の頭を消しました。', toolUses: [] },
      ],
    }))
    on('model.complete', (_$, e) => {
      prompts.push(e.prompt)
      return answered(e.prompt.includes('請求書') ? '指示: 請求書番号の修正\n作業: 頭を消した' : '指示: 古い指示\n作業: 終えた')
    })

    // テストのエンジンは起動まわりを持たないので、下で答える
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
    on('session.repo', () => ({ value: null }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.advance(0)

    expect(prompts.some(prompt => prompt.includes('番号の頭を消しました。') && !prompt.includes('調べます。'))).toBe(true)
    expect(await paneText($)).toMatch(/作業 頭を消した/)
  })
})
