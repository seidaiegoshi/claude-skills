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
  branch: string
}

const sha = (n: number) => `${String(n).repeat(7)}${'0'.repeat(33)}`

// git の呼び出しを手元の偽リポジトリで答える。メインの作業ツリーは /repo、ワークツリーは /repo-wt
const fakeGit = (on: On) => {
  const repo: FakeRepo = { history: [{ sha: sha(1), subject: '始まり' }], holders: {}, dirty: [], ahead: 0, branch: 'claude/1-work' }
  const head = () => repo.history.at(-1)?.sha ?? ''
  const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  mock.env(on, {})
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false, name: null } }))
  on('process.run', (_$, e) => {
    const [, ...args] = e.argv
    const command = args.join(' ')
    if (command === 'rev-parse HEAD') return answer(head())
    if (command === 'rev-parse --show-toplevel') return answer('/repo-wt')
    if (command === 'branch --show-current') return answer(repo.branch)
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

  test('Issue 番号入りのブランチは、見出しとステータスラインに番号を #付きで出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.branch = 'claude/116-manifest-print'
    const statuses: (string | undefined)[] = []
    on('ui.status', (_$, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect(await paneText($)).toMatch(/#116 manifest-print/)
    expect(statuses.at(-1)).toMatch(/^local \/ #116 manifest-print \/ worktree/)
  })

  test('番号の無いブランチは、これまでどおり名前だけ出す', async ($, on) => {
    const clock = setup(on)
    const git = fakeGit(on)
    git.repo.branch = 'claude/dispatch-flags-separation-a15081'

    await submit($, clock, '見せて')
    await $.turn.start({ text: '見せて', turnId: 't1' })
    await complete($, 't1', 'answer')

    expect((await paneText($)).split('\n')[0]).toBe('local / dispatch-flags-separation-a15081 / worktree')
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
