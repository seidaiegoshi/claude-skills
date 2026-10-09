import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { complete, paneText, setup, submit, type Engine } from './helpers'

type FakeRepo = {
  // 古い順のコミット。HEAD は末尾
  history: { sha: string; subject: string }[]
  // コミットごとに、それを含むブランチ(git branch -a --contains の答え)
  holders: Record<string, string[]>
  dirty: string[]
  ahead: number
}

const sha = (n: number) => `${String(n).repeat(7)}${'0'.repeat(33)}`

// git の呼び出しを手元の偽リポジトリで答える。メインの作業ツリーは /repo、ワークツリーは /repo-wt
const fakeGit = (on: On) => {
  const repo: FakeRepo = { history: [{ sha: sha(1), subject: '始まり' }], holders: {}, dirty: [], ahead: 0 }
  const head = () => repo.history.at(-1)?.sha ?? ''
  const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  mock.env(on, {})
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('process.run', (_$, e) => {
    const [, ...args] = e.argv
    const command = args.join(' ')
    if (command === 'rev-parse HEAD') return answer(head())
    if (command === 'rev-parse --show-toplevel') return answer('/repo-wt')
    if (command === 'branch --show-current') return answer('claude/1-work')
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
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))

  const commit = (subject: string, holders = ['claude/1-work']) => {
    const added = sha(repo.history.length + 1)
    repo.history.push({ sha: added, subject })
    repo.holders[added] = holders
    return added
  }
  return { repo, commit }
}

const runGit = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

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

  test('見出しに未コミットのファイル数と基点ブランチへ未マージのコミット数を出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.dirty = [' M a.ts', '?? b.ts']
    git.repo.ahead = 1

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await paneText($)).toMatch(/未コミット 2 ・ develop へ未マージ 1/)
  })
})
