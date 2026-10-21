import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bandText, complete, paneText, setup, submit, type Engine } from './helpers'

type FakeRepo = {
  // 古い順のコミット。HEAD は末尾
  history: { sha: string; subject: string }[]
  // コミットごとに、それを含むブランチ(git branch -a --contains の答え)
  holders: Record<string, string[]>
  dirty: string[]
  ahead: number
  branch: string
  // 作業ツリーの最上位。/repo ならメインの作業ツリーで作業している
  top: string
  // メインの作業ツリーで開いているブランチ
  mainBranch: string
  // 手元のブランチごとに、HEAD にあってそのブランチに無いコミットの数(切った元の推定に使う)
  distance: Record<string, number>
  // メイン以外のワークツリーで開いているブランチ
  otherWorktrees: string[]
  // origin の URL。無ければ null
  remote: string | null
}

const sha = (n: number) => `${String(n).repeat(7)}${'0'.repeat(33)}`

// git の呼び出しを手元の偽リポジトリで答える。メインの作業ツリーは /repo、ワークツリーは /repo-wt
const fakeGit = (on: On) => {
  const repo: FakeRepo = {
    history: [{ sha: sha(1), subject: '始まり' }],
    holders: {},
    dirty: [],
    ahead: 0,
    branch: 'claude/1-work',
    top: '/repo-wt',
    mainBranch: 'develop',
    distance: {},
    otherWorktrees: [],
    remote: null,
  }
  const head = () => repo.history.at(-1)?.sha ?? ''
  const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  mock.env(on, {})
  on('session.repo', () => ({ value: { root: '/repo', remote: repo.remote, internal: false, name: null } }))
  on('process.run', (_$, e) => {
    const [, ...args] = e.argv
    const command = args.join(' ')
    if (command === 'rev-parse HEAD') return answer(head())
    if (command === 'rev-parse --show-toplevel') return answer(repo.top)
    if (command === 'branch --show-current') return answer(e.init?.cwd === '/repo' ? repo.mainBranch : repo.branch)
    if (command === 'worktree list --porcelain') {
      const blocks = [
        ['worktree /repo', `branch refs/heads/${repo.mainBranch}`],
        ['worktree /repo-wt', `branch refs/heads/${repo.branch}`],
        ...repo.otherWorktrees.map((name, i) => [`worktree /other-${i}`, `branch refs/heads/${name}`]),
      ]
      return answer(blocks.map(block => block.join('\n')).join('\n\n'))
    }
    if (command === 'for-each-ref --format=%(refname:short) refs/heads') {
      return answer([repo.branch, ...Object.keys(repo.distance)].join('\n'))
    }
    const counted = /^rev-list --count (.+)\.\.HEAD$/.exec(command)
    if (counted && counted[1] !== undefined && counted[1] in repo.distance) {
      return answer(String(repo.distance[counted[1]]))
    }
    if (command === 'symbolic-ref --short refs/remotes/origin/HEAD') return answer('origin/develop')
    if (command === 'status --porcelain') return answer(repo.dirty.join('\n'))
    if (command.startsWith('rev-list --count')) return answer(String(repo.ahead))
    // --first-parent が付いていることも確かめる。偽の履歴は一直線なので結果は変わらない
    if (args[0] === 'log' && args.includes('--first-parent')) {
      const [from, to] = (args.at(-1) ?? '').split('..')
      const start = repo.history.findIndex(c => c.sha === from)
      const end = repo.history.findIndex(c => c.sha === to)
      const picked = repo.history.slice(start + 1, end + 1)
      return answer(picked.map(c => `${c.sha}\t${c.subject}`).join('\n'))
    }
    if (args[0] === 'branch' && args[2] === '--contains') {
      const holders = repo.holders[args[3] ?? '']
      return holders ? answer(holders.join('\n')) : answer('', 129)
    }
    return answer('', 1)
  })
  // 次の Bash が返す出力。git commit の1行目や gh pr create の URL を答えさせる
  const output = { stdout: '' }
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: output.stdout, stderr: '', interrupted: false },
  }))

  const commit = (subject: string, holders = ['claude/1-work']) => {
    const added = sha(repo.history.length + 1)
    repo.history.push({ sha: added, subject })
    repo.holders[added] = holders
    return added
  }
  return { repo, commit, output }
}

const runGit = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

// 帯の札は1枚ずつ別の Text になる。タイトル(Haiku が答えないので指示の1行目)より前を、3行目の履歴・GitGraph の記号を除いて切り出す
const placeRow = async ($: Engine, title = '見せて') => {
  const texts = (await bandText($)).split('\n').map(text => text.trim())
  return texts.slice(0, texts.indexOf(title)).filter(text => text !== '◷' && text !== '⑂')
}

describe('作業のコミットとマージ状況', () => {
  test('指示の最中に増えたコミットを、その指示のカードに未マージで出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, 'コミットして')
    await $.turn.start({ text: 'コミットして', turnId: 't1' })
    git.commit('画面を直す')
    await runGit($, 'git commit -m 画面を直す')

    const shown = await paneText($)
    expect(shown).toMatch(/コミット1/)
    expect(shown).toMatch(/未マージ/)
    expect(shown).toMatch(/2222222 画面を直す/)
  })

  test('基点ブランチに入るとマージ済み、origin まで届くと push 済み、どこにも無くなると書き換え済みになる', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '締めて')
    await $.turn.start({ text: '締めて', turnId: 't1' })
    const added = git.commit('締めのコミット')
    await runGit($, 'git commit -m 締め')

    git.repo.holders[added] = ['develop']
    await runGit($, 'git -C /repo merge claude/1-work')
    expect(await paneText($)).toMatch(/developにマージ済み/)

    git.repo.holders[added] = ['develop', 'origin/develop']
    await complete($, 't1', 'answer')
    expect(await paneText($)).toMatch(/developにマージ・push済み/)
  })

  test('squash で消えたコミットは書き換え済みにする', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '途中まで')
    await $.turn.start({ text: '途中まで', turnId: 't1' })
    const added = git.commit('途中のコミット')
    await runGit($, 'git commit -m 途中')
    delete git.repo.holders[added]
    await complete($, 't1', 'answer')

    expect(await paneText($)).toMatch(/書き換え済み/)
  })

  test('git を呼ばずにターンが終わっても、コミットは次の待ちではなく終わった指示に付く', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await submit($, clock, '二つ目', 't1')
    git.commit('一つ目のコミット')
    await complete($, 't1', 'answer')

    const shown = await paneText($)
    expect(shown).toMatch(/完了 #1 ・ [^\n]*コミット1/)
    expect(shown).not.toMatch(/待ち 1番目 #2 ・ [^\n]*コミット/)
  })

  test('指示の外で増えたコミットは拾わない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await complete($, 't1', 'answer')
    git.commit('人が手元で積んだコミット')
    await submit($, clock, '二つ目')
    await $.turn.start({ text: '二つ目', turnId: 't2' })
    await complete($, 't2', 'answer')

    expect(await paneText($)).not.toMatch(/人が手元で積んだコミット/)
  })

  test('帯の一番上に、場所・Issue 番号・切った元・ワークツリー・ブランチ名・未コミット・未マージをアイコン付きで出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.branch = 'claude/116-manifest-print'
    git.repo.mainBranch = 'feature'
    git.repo.distance = { feature: 1, develop: 1 }
    git.repo.dirty = [' M a.ts', '?? b.ts']

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await placeRow($)).toEqual([
      '💻 ローカル',
      '🎫 #116',
      '🌱 feature から',
      '🌳 ワークツリー',
      '🌿 manifest-print',
      '✏️ 未コミット 2',
      '⬆️ 未マージ 1',
    ])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: 帯の履歴 ◷ と GitGraph ⑂ の記号は、3行目のタイトルの手前に色付きで並べる`, async ($, on) => {
      const clock = setup(on)
      const git = fakeGit(on)
      git.repo.branch = 'claude/116-manifest-print'

      await submit($, clock, '見せて')
      await $.turn.start({ text: '見せて', turnId: 't1' })
      await complete($, 't1', 'answer')

      const ui = await $.ui.mount({
        plugin: 'session-log',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100 },
      } as never)
      const all = await ui.findAll({})
      await ui.unmount()

      const at = (match: (element: (typeof all)[number]) => boolean) => all.findIndex(match)
      const historyIcon = at(element => element.type === 'Button' && element.key === 'band-history')
      const gitIcon = at(element => element.type === 'Button' && element.key === 'band-git')
      const branch = at(element => element.type === 'Text' && element.text.includes('manifest-print'))
      const title = at(element => element.type === 'Text' && element.text === '見せて')

      expect(all[historyIcon]?.text.trim()).toBe('◷')
      expect(all[gitIcon]?.text.trim()).toBe('⑂')
      expect(branch).toBeLessThan(historyIcon)
      expect(historyIcon).toBeLessThan(gitIcon)
      expect(gitIcon).toBeLessThan(title)
      const glyphs = all.filter(element => element.type === 'Text' && ['◷', '⑂'].includes(element.text.trim()))
      expect(glyphs.every(element => element.props.color !== undefined)).toBe(true)
      // 淡い背景はデスクトップだけ。ターミナルは 8 桁の色を塗れない
      expect(glyphs.every(element => (element.props.backgroundColor !== undefined) === (surface === 'desktop'))).toBe(true)
    })
  }

  test('デスクトップの帯は、絵文字の代わりに種類ごとの線画アイコンを出し、文字もアイコンと同じ色にする。1行目の札に背景色は付けない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.branch = 'claude/116-manifest-print'
    git.repo.distance = { develop: 1 }
    git.repo.dirty = [' M a.ts']

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    const ui = await $.ui.mount({
      plugin: 'session-log',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
    } as never)
    const alts = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
    const texts = await ui.findAll({ type: 'Text' })
    await ui.unmount()

    expect(alts).toEqual(expect.arrayContaining(['ローカル', 'Issue', '切った元', 'ワークツリー', 'ブランチ', '未コミット', '未マージ']))
    expect(texts.find(text => text.text === '#116')?.props.color).toBeDefined()
    expect(texts.some(text => text.text.includes('💻'))).toBe(false)
    // 背景色は3行目の履歴・GitGraph の記号にだけ敷く
    const glyphs = ['◷', '⑂']
    expect(texts.filter(text => !glyphs.includes(text.text.trim())).every(text => text.props.backgroundColor === undefined)).toBe(true)
  })

  test('帯の最後に、セッションのコミット数とマージ済みの数を1つの札で出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    git.commit('一つ目', ['claude/1-work'])
    await runGit($, 'git commit -m 一つ目')
    git.commit('二つ目', ['develop'])
    await runGit($, 'git commit -m 二つ目')
    await complete($, 't1', 'answer')
    await submit($, clock, '続けて')
    await $.turn.start({ text: '続けて', turnId: 't2' })
    git.commit('三つ目', ['develop', 'origin/develop'])
    await runGit($, 'git commit -m 三つ目')

    expect((await placeRow($, '続けて')).at(-1)).toBe('📦 コミット 3(マージ済み 2)')
  })

  test('マージ済みが 0 件なら「(マージ済み 0)」を付けない。コミットが無ければ札を出さない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    expect(await bandText($)).not.toMatch(/📦/)

    git.commit('一つ目', ['claude/1-work'])
    await runGit($, 'git commit -m 一つ目')
    const shown = await bandText($)
    expect(shown).toMatch(/📦 コミット 1$/m)
    expect(shown).not.toMatch(/マージ済み/)
  })

  test('デスクトップの帯には、コミットの札も線画アイコンで出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    git.commit('一つ目', ['develop'])
    await runGit($, 'git commit -m 一つ目')

    const ui = await $.ui.mount({
      plugin: 'session-log',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100 },
    } as never)
    const alts = (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt)
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    await ui.unmount()

    expect(alts).toContain('コミット')
    expect(texts).toContain('コミット 1(マージ済み 1)')
  })

  const issueLinks = async ($: Engine, surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({
      plugin: 'session-log',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
    } as never)
    // 見つけた要素の text には href も混ざるので、描く文字は子要素から読む
    const links = (await ui.findAll({ type: 'Link' })).map(link => ({ href: link.props.href, label: link.children.join('') }))
    await ui.unmount()
    return links
  }

  for (const remote of [
    'git@github.com:lobby-inc/Miya-Con.git',
    'https://github.com/lobby-inc/Miya-Con.git',
    'ssh://git@github.com/lobby-inc/Miya-Con',
  ]) {
    test(`origin が GitHub(${remote})なら、Issue 番号を押すと GitHub の Issue を開く`, async ($, on) => {
      const clock = setup(on)
      const git = fakeGit(on)
      git.repo.branch = 'claude/116-manifest-print'
      git.repo.remote = remote

      await submit($, clock, '見せて')
      await $.turn.start({ text: '見せて', turnId: 't1' })
      await complete($, 't1', 'answer')

      const link = { href: 'https://github.com/lobby-inc/Miya-Con/issues/116', label: '#116' }
      expect(await issueLinks($, 'terminal')).toEqual([link])
      expect(await issueLinks($, 'desktop')).toEqual([link])
    })
  }

  for (const remote of [null, 'git@gitlab.com:lobby-inc/Miya-Con.git']) {
    test(`origin が無いか GitHub でない(${remote})ときは、Issue 番号をリンクにせず文字だけ出す`, async ($, on) => {
      const clock = setup(on)
      const git = fakeGit(on)
      git.repo.branch = 'claude/116-manifest-print'
      git.repo.remote = remote

      await submit($, clock, '見せて')
      await $.turn.start({ text: '見せて', turnId: 't1' })
      await complete($, 't1', 'answer')

      expect(await issueLinks($, 'desktop')).toEqual([])
      expect(await placeRow($)).toContain('🎫 #116')
    })
  }

  test('切った元は、分岐点がいちばん近いブランチにする', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.distance = { develop: 5, feature: 2 }

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await placeRow($)).toContain('🌱 feature から')
  })

  test('分岐点が同じなら、ワークツリーを切る元のメインの作業ツリーのブランチを選ぶ', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.mainBranch = 'feature'
    git.repo.distance = { develop: 0, feature: 0 }

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await placeRow($)).toContain('🌱 feature から')
  })

  test('一度決めた切った元は、あとでメインの作業ツリーがブランチを替えても変えない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.mainBranch = 'feature'
    git.repo.distance = { develop: 0, feature: 0 }

    await submit($, clock, '一つ目')
    await $.turn.start({ text: '一つ目', turnId: 't1' })
    await complete($, 't1', 'answer')
    git.repo.mainBranch = 'develop'
    await submit($, clock, '二つ目')
    await $.turn.start({ text: '二つ目', turnId: 't2' })
    await complete($, 't2', 'answer')

    expect(await placeRow($)).toContain('🌱 feature から')
  })

  test('ほかのワークツリーで開いているブランチは切った元にしない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.distance = { 'claude/2-other': 0, develop: 3 }
    git.repo.otherWorktrees = ['claude/2-other']

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await placeRow($)).toContain('🌱 develop から')
  })

  test('メインの作業ツリーでは、切った元とワークツリーを出さない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.top = '/repo'
    git.repo.branch = 'feature'
    git.repo.distance = { develop: 0 }

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await placeRow($)).toEqual(['💻 ローカル', '🌿 feature'])
  })

  test('番号の無いブランチは、claude/ を省いた名前を出し Issue 番号を出さない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.branch = 'claude/dispatch-flags-separation-a15081'

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    const row = await placeRow($)
    expect(row).toContain('🌿 dispatch-flags-separation-a15081')
    expect(row.some(text => text.includes('🎫'))).toBe(false)
  })

  test('場所はステータス行にもパネルにも出さない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.branch = 'claude/116-manifest-print'
    git.repo.dirty = [' M a.ts']
    const statuses: (string | undefined)[] = []
    on('ui.status', (_$, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(statuses).toEqual([])
    const pane = await paneText($)
    expect(pane).not.toMatch(/ローカル|ワークツリー|未コミット/)
  })

  test('マージ・push・PR作成の操作を、その指示のカードに出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, '締めて')
    await $.turn.start({ text: '締めて', turnId: 't1' })
    await runGit($, 'cd /repo && git merge --no-ff -m "作業を取り込む" claude/1-work && git push origin develop')
    git.output.stdout = 'https://github.com/owner/repo/pull/12'
    await runGit($, 'gh pr create --base main --title "リリース" --body "本文"')

    const shown = await paneText($)
    expect(shown).toMatch(/マージ claude\/1-work/)
    expect(shown).not.toMatch(/作業を取り込む/)
    expect(shown).toMatch(/push origin develop/)
    expect(shown).toMatch(/PR作成 #12/)
  })

  test('コミットの一覧に出たコミットは、操作の一覧に重ねて出さない', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)

    await submit($, clock, 'コミットして')
    await $.turn.start({ text: 'コミットして', turnId: 't1' })
    git.commit('画面を直す')
    git.output.stdout = '[claude/1-work 2222222] 画面を直す\n 1 file changed'
    await runGit($, 'git add -A && git commit -m 画面を直す')

    const shown = await paneText($)
    expect(shown).toMatch(/2222222 画面を直す/)
    expect(shown).not.toMatch(/◆ コミット/)
  })

  test('状態を見るだけの git は操作として出さない', async ($, on) => {
    const clock = setup(on)
    fakeGit(on)

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await runGit($, 'git status && git log --oneline -5 && git branch --show-current && git merge --abort')

    expect(await paneText($)).not.toMatch(/◆/)
  })
})
