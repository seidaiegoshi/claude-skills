import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PLUGIN, setup, type Engine } from './helpers'

// develop に feat をマージした形。feat はワークツリーで開いている
const LOG = [
  ['c4', 'c3 c2', 'HEAD -> develop', 'Merge feat'],
  ['c3', 'c1', '', '一覧を直す'],
  ['c2', 'c1', 'claude/feat, origin/claude/feat', '機能を足す'],
  ['c1', '', 'tag: v1', '始まり'],
]
  .map(([sha, parents, refs, subject]) => [sha, parents, refs, 'egoshi', '999000', subject].join('\t'))
  .join('\n')

const fakeRepo = (on: On, { isBroken = false } = {}) => {
  // pbcopy に渡した文字と、出したトースト
  const copied: string[] = []
  const toasts: string[] = []
  let logs = 0
  const answer = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  mock.env(on, {})
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('process.run', (_$, e) => {
    const [, ...args] = e.argv
    if (e.argv[0] === 'pbcopy') {
      copied.push(e.init?.stdin ?? '')
      return answer('')
    }
    if (args[0] === 'log' && args.includes('--all')) {
      logs += 1
      return isBroken ? answer('', 128) : answer(LOG)
    }
    if (args.join(' ') === 'worktree list --porcelain') {
      return answer('worktree /repo\nbranch refs/heads/develop\n\nworktree /repo-wt\nbranch refs/heads/claude/feat')
    }
    return answer('', 1)
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // デスクトップの画面には $.ui.copy の経路がまだ無い
  on('ui.copy', () => ({ value: { isCopied: false as const, reason: 'no-clipboard' as const } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { copied, toasts, logCalls: () => logs }
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PLUGIN,
    props: { title: '指示の履歴', isFocused: false },
  } as never)

describe('ペインの Git タブ', () => {
  test('terminal: Git タブを押すと、全ブランチのコミットをレーンの文字と印つきで並べる', async ($, on) => {
    setup(on)
    fakeRepo(on)

    const pane = await mountPane($, 'terminal')
    await pane.press({ key: 'tab-git' })
    const texts = (await pane.findAll({ type: 'Text' })).map(text => text.text)
    await pane.unmount()

    const shown = texts.join('\n')
    expect(shown).toMatch(/全ブランチの直近 4 コミット/)
    // マージの子は左のレーン、マージされた側は右のレーンに出る
    expect(texts).toContain('●│')
    expect(texts).toContain('│●')
    expect(texts).toContain(' develop ')
    expect(texts).toContain(' 🌳 feat ')
    expect(texts).toContain('[origin/claude/feat]')
    expect(texts).toContain('[🏷 v1]')
    expect(shown).toMatch(/機能を足す/)
  })

  test('desktop: レーンを1行ずつの SVG で描き、マージは2本の線で親へ伸ばす', async ($, on) => {
    setup(on)
    fakeRepo(on)

    const pane = await mountPane($, 'desktop')
    await pane.press({ key: 'tab-git' })
    const svgs = await pane.findAll({ type: 'Svg' })
    await pane.unmount()

    expect(svgs.map(svg => svg.props.alt)).toEqual(['c4', 'c3', 'c2', 'c1'])
    const merge = String(svgs[0]?.props.source)
    // HEAD は輪の印、親へは左のレーン(x=6)と右のレーン(x=18)へ伸びる
    expect(merge).toMatch(/stroke-width="2.5"/)
    expect(merge).toMatch(/M6 12C6 18 6 18 6 24/)
    expect(merge).toMatch(/M6 12C6 18 18 18 18 24/)
    // 最初のコミットへは右のレーンが合流する
    expect(String(svgs[3]?.props.source)).toMatch(/M18 0C18 6 6 6 6 12/)
  })

  test('desktop: 件名を押すと短いハッシュを、ブランチ名を押すとその名前をコピーしてトーストで知らせる', async ($, on) => {
    setup(on)
    const repo = fakeRepo(on)

    const pane = await mountPane($, 'desktop')
    await pane.press({ key: 'tab-git' })
    await pane.press({ key: 'copy-c3' })
    await pane.press({ key: 'ref-c2-origin/claude/feat' })
    await pane.press({ key: 'ref-c1-v1' })
    await pane.unmount()

    expect(repo.copied).toEqual(['c3', 'origin/claude/feat', 'v1'])
    expect(repo.toasts).toEqual(['コピーしました: c3', 'コピーしました: origin/claude/feat', 'コピーしました: v1'])
  })

  test('タブはボタンの見た目で、選んでいる側を強調する', async ($, on) => {
    setup(on)
    fakeRepo(on)

    const pane = await mountPane($, 'desktop')
    const variants = async () =>
      Object.fromEntries((await pane.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('tab-')).map(b => [b.props.label, b.props.variant]))
    expect(await variants()).toEqual({ セッション履歴: 'primary', GitGraph: 'secondary' })
    await pane.press({ key: 'tab-git' })
    expect(await variants()).toEqual({ セッション履歴: 'secondary', GitGraph: 'primary' })
    await pane.unmount()
  })

  test('更新ボタンを押すと git を読み直し、読み込んだ時刻を出し直す', async ($, on) => {
    const clock = setup(on)
    const repo = fakeRepo(on)

    const pane = await mountPane($, 'terminal')
    await pane.press({ key: 'tab-git' })
    const before = repo.logCalls()
    await clock.advance(60_000)
    await pane.press({ key: 'graph-refresh' })
    const shown = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    await pane.unmount()

    expect(repo.logCalls()).toBe(before + 1)
    expect(shown).toMatch(/時点/)
  })

  test('履歴タブに戻すと指示の履歴を出す', async ($, on) => {
    setup(on)
    fakeRepo(on)

    const pane = await mountPane($, 'terminal')
    await pane.press({ key: 'tab-git' })
    await pane.press({ key: 'tab-history' })
    const shown = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    await pane.unmount()

    expect(shown).toMatch(/指示 0件/)
    expect(shown).not.toMatch(/機能を足す/)
  })

  test('git を読めなかったら、読み込み中のまま止めずに読めなかったと出す', async ($, on) => {
    setup(on)
    fakeRepo(on, { isBroken: true })

    const pane = await mountPane($, 'desktop')
    await pane.press({ key: 'tab-git' })
    const shown = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    await pane.unmount()

    expect(shown).toMatch(/git の履歴を読めませんでした/)
    expect(shown).not.toMatch(/読み込んでいます/)
  })
})
