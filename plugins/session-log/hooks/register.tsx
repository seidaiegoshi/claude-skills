import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Background, Commit, CommitState, Entry, EntryStatus, GitOp, GitOpKind, Place, Task, TaskStatus } from '../types'

const PANE = 'session-log'
const TITLE = '指示の履歴'
const MAX_ENTRIES = 200
const PROGRESS_TOOL = 'mcp__session-log__progress'
const BAR_CELLS = 12

const PROGRESS_RULE =
  `作業を3段階以上に分けて進めるときは ${PROGRESS_TOOL} で進み具合を申告する。` +
  '着手時に plan(段階名の配列)を送り、段階を終えるたびに done(終えた段階の数)を送る。1〜2手で終わる作業では呼ばない。'

const entries = atom({ plugin: 'session-log', key: 'entries' } as const, [])
const now = atom({ plugin: 'session-log', key: 'now' } as const, 0)
const place = atom({ plugin: 'session-log', key: 'place' } as const, null)
const tasks = atom({ plugin: 'session-log', key: 'tasks' } as const, [])
const lastHead = atom({ plugin: 'session-log', key: 'lastHead' } as const, null)
const sessionTitle = atom({ plugin: 'session-log', key: 'title' } as const, null)
const background = atom({ plugin: 'session-log', key: 'background' } as const, [])

const TITLE_MODEL = 'haiku'
const TITLE_HISTORY = 8
const BACKFILL = 5
const TITLE_RULE =
  'Claude Code のセッションに、いま何に取り組んでいてどこまで進んだかが一目で分かるタイトルを付ける。' +
  '50字以内の日本語1行で「内容 — 状態」の形にし、タイトルだけを返す。' +
  '内容は直近の指示の流れから読み取り、どの画面・機能の何をどうするのかを具体的な名詞で書く(「修正」「対応」だけで終わらせない)。' +
  'Issue 番号は別の場所に出すので付けない。状態は渡された段階をもとに短く書く。'

const ICON: Record<EntryStatus, string> = {
  queued: '…',
  running: '▶',
  done: '✓',
  aborted: '■',
  error: '✗',
}
const STATUS_WORD: Record<EntryStatus, string> = {
  queued: '待ち',
  running: '作業中',
  done: '完了',
  aborted: '中断',
  error: 'エラー',
}
// 人が打った指示だけを残す(デスクトップアプリからの送信は sdk になる)
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'channel', 'slack-ping'])

const HHMM = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
})

const MAX_TEXT = 4000
const PANE_LIMIT = 50
const PANE_COLUMNS = 30
const TRACK_H = 20
const AMBER = '#D97706'
const FONT = '-apple-system, system-ui, sans-serif'

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// 全文を見せるので改行は残し、行末の空白と3行以上の空行だけ詰める
const tidy = (text: string) =>
  text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT)

// 過去の指示には system-reminder などの付帯ブロックが混ざるので落とす
const stripTags = (text: string) =>
  text.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/g, '').trim()

const matchKey = (text: string) => oneLine(text).slice(0, 80)

const clock = (ms: number) => (ms === 0 ? '--:--' : HHMM.format(ms))

const duration = (seconds: number) =>
  seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`

const isRunning = (entry: Entry) => entry.status === 'running'
const isQueued = (entry: Entry) => entry.status === 'queued'

// 色は作業中と待ちだけに付け、終わった指示は状態を問わずグレーにする
const toneOf = (entry: Entry) => (isRunning(entry) ? 'blue' : isQueued(entry) ? 'yellow' : 'gray')

const latestRunning = (list: Entry[]) => list.findLast(isRunning)

// 走っているターンに待ちの指示が取り込まれると作業中が複数になる。
// 進捗を申告した指示があればそれを主とし、バーがそちらから外れないようにする
const focusRunning = (list: Entry[]) =>
  list.findLast(entry => isRunning(entry) && entry.steps.length > 0) ?? latestRunning(list)

const newEntry = (
  fields: Pick<Entry, 'id' | 'text' | 'at' | 'startedAt' | 'status' | 'turnId'>,
): Entry => ({
  ...fields,
  seconds: null,
  files: [],
  steps: [],
  done: 0,
  commits: [],
  gitOps: [],
  ask: null,
  summary: null,
})

const bar = (done: number, total: number, cells = BAR_CELLS) => {
  const filled = Math.round((done / total) * cells)
  return { filled: '█'.repeat(filled), rest: '░'.repeat(cells - filled) }
}

// 終えた段階の次を「いまの段階」とみなす
const currentStep = (entry: Entry) => entry.steps[entry.done] ?? '仕上げ'

const stepLabel = (entry: Entry) =>
  `${Math.min(entry.done + 1, entry.steps.length)}/${entry.steps.length} ${currentStep(entry)}`

const firstLine = (text: string) => text.split('\n')[0] ?? ''

type Meter = { done: number; total: number; label: string; tone: 'running' | 'done' | 'stopped' }

// 段階の申告が無い作業も1段のバーにして、帯にいつもバーを出す
const meterOf = (entry: Entry): Meter => {
  const total = entry.steps.length
  if (isRunning(entry) || isQueued(entry)) {
    return total > 0
      ? { done: entry.done, total, label: stepLabel(entry), tone: 'running' }
      : { done: 0, total: 1, label: '準備中', tone: 'running' }
  }
  // 最後の done を送らずに終えることがあるので、完了した作業は満たす
  if (entry.status === 'done') {
    return total > 0
      ? { done: total, total, label: `${total}/${total} 完了`, tone: 'done' }
      : { done: 1, total: 1, label: '完了', tone: 'done' }
  }
  return { done: entry.done, total: Math.max(total, 1), label: STATUS_WORD[entry.status], tone: 'stopped' }
}

const METER_FILL: Record<Meter['tone'], string> = { running: AMBER, done: '#16A34A', stopped: '#8A8780' }
const METER_COLOR: Record<Meter['tone'], string> = { running: 'yellow', done: 'green', stopped: 'gray' }

// 通知を取りこぼすと残り続けるので、長く経った記録は終わったものとみなす
const BACKGROUND_TTL_MS = 3 * 60 * 60 * 1000
const liveBackground = (list: Background[], at: number) => list.filter(item => at - item.at < BACKGROUND_TTL_MS)

// 通知の本文に ID がある作業を消す。ID の分からない Bash は古い順に1件ずつ消す
const settleBackground = (list: Background[], notice: string) => {
  const rest = list.filter(item => !(item.id && notice.includes(item.id)))
  if (rest.length < list.length) return rest
  const blind = rest.findIndex(item => item.kind === 'shell' && item.id === null)
  return blind === -1 ? rest : rest.filter((_, i) => i !== blind)
}

// 帯に出すのは作業中の指示、無ければ最後に終わった指示
const bandTarget = (list: Entry[]) => focusRunning(list) ?? list.findLast(entry => !isQueued(entry))

const elapsedOf = (entry: Entry, current: number) =>
  isRunning(entry) ? Math.max(0, Math.round((current - entry.startedAt) / 1000)) : entry.seconds

const startRunning = (entry: Entry, turnId: string | null, at: number): Entry => ({
  ...entry,
  status: 'running',
  turnId,
  startedAt: isRunning(entry) ? entry.startedAt : at,
  seconds: null,
})

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// SVG の文字幅の見積もり。全角は字の大きさぶん、半角はその6割
const textWidth = (text: string, size: number) =>
  [...text].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.6), 0)

const fitText = (text: string, size: number, room: number) => {
  if (textWidth(text, size) <= room) return text
  let cut = [...text]
  while (cut.length > 1 && textWidth(`${cut.join('')}…`, size) > room) cut = cut.slice(0, -1)
  return `${cut.join('')}…`
}

// plan-progress に倣い、溝の上を塗りが進み、先頭のカプセルにいまの段階を書く
const trackSvg = (meter: Meter, width: number) => {
  const { total } = meter
  const color = METER_FILL[meter.tone]
  const fx = (meter.done / total) * width
  const r = TRACK_H / 2
  const marks = Array.from({ length: total - 1 }, (_, i) => i)
    .map(i => {
      const x = ((i + 1) / total) * width
      const passed = x < fx - 1
      return `<circle cx="${x.toFixed(1)}" cy="${r}" r="1.6" fill="${passed ? '#FFFFFF' : '#A8A69E'}" opacity="${passed ? 0.85 : 0.6}"/>`
    })
    .join('')
  const label = fitText(meter.label, 11, width - 20)
  const pillW = Math.min(width, textWidth(label, 11) + 20)
  const pillX = Math.max(0, Math.min(width - pillW, fx - pillW / 2))
  const fill = fx > 0 ? `<rect width="${Math.max(fx, TRACK_H).toFixed(1)}" height="${TRACK_H}" rx="${r}" fill="${color}" opacity="0.45"/>` : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TRACK_H}" viewBox="0 0 ${width} ${TRACK_H}">` +
    `<rect width="${width}" height="${TRACK_H}" rx="${r}" fill="#808080" opacity="0.18"/>` +
    fill +
    marks +
    `<rect x="${pillX.toFixed(1)}" width="${pillW.toFixed(1)}" height="${TRACK_H}" rx="${r}" fill="${color}"/>` +
    `<text x="${(pillX + pillW / 2).toFixed(1)}" y="${r + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#FFFFFF">${escapeXml(label)}</text>` +
    '</svg>'
  )
}

const updateEntry = (list: Entry[], target: Entry | undefined, change: (entry: Entry) => Entry) =>
  target ? list.map(entry => (entry.id === target.id ? change(entry) : entry)) : list

const updateRunning = (list: Entry[], change: (entry: Entry) => Entry) =>
  updateEntry(list, latestRunning(list), change)

const TASK_ORDER: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 }

// 残っているタスクを、手を付けているもの → 未着手の順に並べる
const openTasks = (list: Task[]) =>
  list
    .filter(task => task.status !== 'completed')
    .sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status])

const isTaskStatus = (value: unknown): value is TaskStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed'

const asSteps = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((step): step is string => typeof step === 'string' && step.trim() !== '')
    : null

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

const COMMIT_COLOR: Record<CommitState, string> = {
  branch: 'yellow',
  merged: 'cyan',
  pushed: 'green',
  gone: 'gray',
}

const commitWord = (state: CommitState, base: string) =>
  ({
    branch: '未マージ',
    merged: `${base}にマージ済み`,
    pushed: `${base}にマージ・push済み`,
    gone: '書き換え済み',
  })[state]

// /start-issue が切る <接頭辞>/<番号>-<スラッグ> の形だけを Issue に紐づくブランチとみなす
const ISSUE_BRANCH = /^(?:[^/]+\/)?(\d+)-(.+)$/

// 例: 「#45 pane-width」「develop」。作業ブランチに付く claude/ は省く
const branchLabel = (branch: string) => {
  const issue = ISSUE_BRANCH.exec(branch)
  return issue ? `#${issue[1]} ${issue[2]}` : branch.replace(/^claude\//, '')
}

type ChipKind = 'local' | 'cloud' | 'issue' | 'from' | 'worktree' | 'branch' | 'dirty' | 'ahead'
type Chip = { kind: ChipKind; text: string }

// 色は明るい配色でも暗い配色でも読める中間の濃さ。ブランチ名は太字にするのでアイコンだけ薄くする
// icon は Lucide(ISC)の線画、emoji は SVG を描けないターミナルでの代わり
const CHIP_STYLE: Record<ChipKind, { color: string; name: string; emoji: string; icon: string }> = {
  local: { color: '#8A877F', name: 'ローカル', emoji: '💻', icon: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>' },
  cloud: { color: '#22A6B8', name: 'クラウド', emoji: '☁️', icon: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>' },
  issue: { color: '#A855F7', name: 'Issue', emoji: '🎫', icon: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>' },
  from: { color: '#3B82F6', name: '切った元', emoji: '🌱', icon: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>' },
  worktree: { color: '#22A055', name: 'ワークツリー', emoji: '🌳', icon: '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>' },
  branch: { color: '#8A877F', name: 'ブランチ', emoji: '🌿', icon: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>' },
  dirty: { color: '#D08A10', name: '未コミット', emoji: '✏️', icon: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>' },
  ahead: { color: '#E0682C', name: '未マージ', emoji: '⬆️', icon: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>' },
}

const ICON_SIZE = 14

const iconSvg = (kind: ChipKind) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 24 24" fill="none" ` +
  `stroke="${CHIP_STYLE[kind].color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CHIP_STYLE[kind].icon}</svg>`

// 例: ローカル #160 feature から ワークツリー dispatch-by-slot 未コミット 3 未マージ 2(それぞれにアイコン)
const placeChips = (where: Place): Chip[] => {
  const issue = where.branch ? ISSUE_BRANCH.exec(where.branch) : null
  const chips: (Chip | null)[] = [
    where.isCloud ? { kind: 'cloud', text: 'クラウド' } : { kind: 'local', text: 'ローカル' },
    issue ? { kind: 'issue', text: `#${issue[1]}` } : null,
    where.worktree && where.from ? { kind: 'from', text: `${where.from} から` } : null,
    where.worktree ? { kind: 'worktree', text: 'ワークツリー' } : null,
    where.branch ? { kind: 'branch', text: issue?.[2] ?? branchLabel(where.branch) } : null,
    where.dirty > 0 ? { kind: 'dirty', text: `未コミット ${where.dirty}` } : null,
    where.base && where.ahead > 0 ? { kind: 'ahead', text: `未マージ ${where.ahead}` } : null,
  ]
  return chips.filter((chip): chip is Chip => chip !== null)
}

async function gitLine($: EngineInterface, args: string[], cwd?: string) {
  const ran = await $.process.run(['git', ...args], { timeoutMs: 5000, ...(cwd ? { cwd } : {}) })
  return ran.exitCode === 0 ? ran.stdout.trim() || null : null
}

const lines = (text: string | null) => (text ? text.split('\n').filter(line => line !== '') : [])

// マージ先は origin/HEAD が指すブランチ。設定の無いリポジトリでは よくある名前を探す
async function baseBranch($: EngineInterface, root: string) {
  const remoteHead = await gitLine($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
  if (remoteHead) return remoteHead.replace(/^origin\//, '')
  for (const name of ['develop', 'main', 'master']) {
    if (await gitLine($, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], root)) return name
  }
  return null
}

// ワークツリーは作業の締めで消えるので、判定はメインの作業ツリーで行う
async function commitState($: EngineInterface, root: string, base: string, sha: string) {
  const holders = lines(
    await gitLine($, ['branch', '-a', '--contains', sha, '--format=%(refname:short)'], root),
  )
  if (holders.includes(`origin/${base}`)) return 'pushed'
  if (holders.includes(base)) return 'merged'
  return holders.length > 0 ? 'branch' : 'gone'
}

// push まで届いたコミットはそれ以上動かないので見直さない
async function refreshCommits($: EngineInterface) {
  const repo = await $.session.repo()
  const base = repo ? await baseBranch($, repo.root) : null
  if (!repo || !base) return

  const list = await read($, entries)
  const states = new Map<string, CommitState>()
  for (const commit of list.flatMap(entry => entry.commits)) {
    if (commit.state !== 'pushed' && !states.has(commit.sha)) {
      states.set(commit.sha, await commitState($, repo.root, base, commit.sha))
    }
  }
  if (states.size === 0) return

  await update($, entries, current =>
    current.map(entry =>
      entry.commits.some(commit => states.has(commit.sha))
        ? {
            ...entry,
            commits: entry.commits.map(commit => ({
              ...commit,
              state: states.get(commit.sha) ?? commit.state,
            })),
          }
        : entry,
    ),
  )
}

const GIT_OP_WORD: Record<GitOpKind, string> = {
  commit: 'コミット',
  merge: 'マージ',
  rebase: 'リベース',
  'cherry-pick': 'cherry-pick',
  reset: 'リセット',
  push: 'push',
  pull: 'pull',
  branch: 'ブランチ作成',
  'branch-delete': 'ブランチ削除',
  worktree: 'ワークツリー作成',
  'worktree-remove': 'ワークツリー削除',
  tag: 'タグ',
  'pr-create': 'PR作成',
  'pr-merge': 'PRマージ',
  'pr-close': 'PRクローズ',
}

// 引用符の中の空白では切らない。$(...) や heredoc までは解かない
const tokenize = (segment: string) =>
  [...segment.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')

// 値を取るオプション。これらの次の語は相手(ブランチ名など)として数えない
const VALUE_FLAGS = new Set(['-m', '-F', '-s', '-X', '--strategy', '--onto', '-b', '-B', '-c', '-C', '--title', '--body', '-t', '-T'])

const positionals = (args: string[]) =>
  args.filter((arg, i) => !arg.startsWith('-') && !VALUE_FLAGS.has(args[i - 1] ?? ''))

const has = (args: string[], ...flags: string[]) => args.some(arg => flags.includes(arg))

const op = (kind: GitOpKind, label: string, sha: string | null = null): GitOp => ({ kind, label, sha })

// git commit の出力の1行目「[ブランチ 短いsha] 件名」
const COMMIT_LINE = /^\[[^\]]*?\s([0-9a-f]{7,40})\] (.+)$/m
const PR_URL = /\/pull\/(\d+)/

const gitOpOf = (args: string[], stdout: string): GitOp | null => {
    let i = 0
  while (i < args.length && args[i]?.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const [sub, ...rest] = args.slice(i)
  const names = positionals(rest)
  const target = names.join(' ')
  const force = has(rest, '-f', '--force', '--force-with-lease') ? ' (force)' : ''

  if (has(rest, '--abort', '--quit', '--dry-run')) return null
  switch (sub) {
    case 'commit': {
      const made = COMMIT_LINE.exec(stdout)
      return made ? op('commit', made[2] ?? '', made[1] ?? null) : null
    }
    case 'merge':
      return op('merge', target)
    case 'rebase':
      return op('rebase', has(rest, '--continue') ? '続行' : target)
    case 'cherry-pick':
      return op('cherry-pick', target)
    case 'reset':
      return has(rest, '--hard') ? op('reset', target || 'HEAD') : null
    case 'push':
      return has(rest, '-d', '--delete') ? op('branch-delete', target) : op('push', `${target}${force}`.trim())
    case 'pull':
      return op('pull', target)
    case 'checkout':
    case 'switch': {
      const at = rest.findIndex(arg => ['-b', '-B', '-c', '-C'].includes(arg))
      return at >= 0 ? op('branch', rest[at + 1] ?? '') : null
    }
    case 'branch':
      if (has(rest, '-d', '-D', '--delete')) return op('branch-delete', target)
      return names.length > 0 && !has(rest, '--list', '-l', '-a', '-r', '-v', '-vv', '--contains', '--merged', '--no-merged', '--show-current') ? op('branch', names[0] ?? '') : null
    case 'worktree':
      if (names[0] === 'add') return op('worktree', basename(names[1] ?? ''))
      if (names[0] === 'remove') return op('worktree-remove', basename(names[1] ?? ''))
      return null
    case 'tag':
      return names.length > 0 && !has(rest, '-l', '--list', '-d') ? op('tag', names[0] ?? '') : null
    default:
      return null
  }
}

const ghOpOf = (args: string[], stdout: string): GitOp | null => {
  const [area, action, ...rest] = args
  if (area !== 'pr') return null
  const number = positionals(rest)[0]?.match(PR_URL)?.[1] ?? positionals(rest)[0]
  const label = number ? `#${number.replace(/^#/, '')}` : ''
  if (action === 'create') {
    const made = PR_URL.exec(stdout)
    return op('pr-create', made ? `#${made[1]}` : '')
  }
  if (action === 'merge') return op('pr-merge', label)
  if (action === 'close') return op('pr-close', label)
  return null
}

// cd や && で繋いだ1行から git / gh の操作を拾う。git の出力は最後の操作のものとみなす
const gitOpsOf = (command: string, stdout: string): GitOp[] =>
  command
    .split(/&&|\|\||;|\||\n/)
    .map(segment => tokenize(segment.trim()))
    .map(tokens => tokens.slice(tokens.findIndex(token => !/^[A-Z_][A-Z0-9_]*=/.test(token))))
    .map(([tool, ...args]) => (tool === 'git' ? gitOpOf(args, stdout) : tool === 'gh' ? ghOpOf(args, stdout) : null))
    .filter((found): found is GitOp => found !== null)

const readHead = ($: EngineInterface) => gitLine($, ['rev-parse', 'HEAD'])

// 前に見た HEAD から増えたコミットを、いま作業中の指示に付ける。
// 基点ブランチを取り込んだときに相手側のコミットまで付けないよう、第1親だけたどる
async function collectCommits($: EngineInterface) {
  const head = await readHead($)
  const last = await read($, lastHead)
  if (!head || head === last) return

  await update($, lastHead, () => head)
  if (!last) return

  const found: Commit[] = lines(await gitLine($, ['log', '--reverse', '--first-parent', '--format=%H%x09%s', `${last}..${head}`])).map(
    line => {
      const [sha = '', ...subject] = line.split('\t')
      return { sha, subject: subject.join('\t'), state: 'branch' }
    },
  )
  if (found.length === 0) return

  await update($, entries, list =>
    updateEntry(list, focusRunning(list) ?? list.at(-1), entry => ({
      ...entry,
      commits: [...entry.commits, ...found.filter(c => !entry.commits.some(known => known.sha === c.sha))],
    })),
  )
}

// どちらも取れなくても履歴と進捗の表示は続ける
async function refreshGit($: EngineInterface) {
  await collectCommits($).catch(() => {})
  await refreshCommits($).catch(() => {})
  await refreshPlace($)
}

// ブランチは指示のたびに切り替わりうるので毎回取り直す
async function refreshPlace($: EngineInterface) {
  try {
    await readPlace($)
  } catch {
    // 取れなくても履歴と進捗の表示は続ける
  }
}

// Git は切った元のブランチ名を残さないので、分岐点がいちばん近いブランチを切った元とみなす。
// 並んだら、ワークツリーを切るときの元になるメインの作業ツリーのブランチ、次にマージ先を選ぶ
async function cutFromBranch($: EngineInterface, root: string, current: string, base: string | null) {
  const mainBranch = await gitLine($, ['branch', '--show-current'], root)
  // 先頭の塊がメインの作業ツリー。ほかのワークツリーの作業ブランチは元にならない
  const others = new Set(
    lines(await gitLine($, ['worktree', 'list', '--porcelain'], root))
      .filter(line => line.startsWith('branch refs/heads/'))
      .map(line => line.slice('branch refs/heads/'.length))
      .filter(name => name !== mainBranch),
  )
  const candidates = lines(await gitLine($, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], root)).filter(
    name => name !== current && !others.has(name),
  )
  const rank = (name: string) => (name === mainBranch ? 0 : name === base ? 1 : 2)
  let best: { name: string; distance: number } | null = null
  for (const name of candidates) {
    const counted = await gitLine($, ['rev-list', '--count', `${name}..HEAD`])
    if (counted === null) continue
    const distance = Number(counted)
    if (!best || distance < best.distance || (distance === best.distance && rank(name) < rank(best.name))) {
      best = { name, distance }
    }
  }
  return best?.name ?? null
}

async function readPlace($: EngineInterface) {
  const repo = await $.session.repo()
  const top = await gitLine($, ['rev-parse', '--show-toplevel'])
  const branch = await gitLine($, ['branch', '--show-current'])
  const base = repo ? await baseBranch($, repo.root) : null
  const ahead =
    base && branch && branch !== base ? Number(await gitLine($, ['rev-list', '--count', `${base}..HEAD`])) || 0 : 0
  const worktree = repo && top && top !== repo.root ? basename(top) : null
  // 切った元はあとでメインの作業ツリーが切り替わると推定が変わるので、初めて見たときの値を使い続ける
  const previous = await read($, place)
  const from =
    !repo || !worktree || !branch
      ? null
      : previous?.worktree === worktree && previous.from
        ? previous.from
        : await cutFromBranch($, repo.root, branch, base)
  const where: Place = {
    // クラウドでは CLAUDE_CODE_REMOTE が立つ
    isCloud: (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true',
    repo: repo ? basename(repo.root) : null,
    branch,
    worktree,
    from,
    base,
    dirty: lines(await gitLine($, ['status', '--porcelain'])).length,
    ahead,
  }
  await update($, place, () => where)
}

const titlePrompt = (list: Entry[], target: Entry, where: Place | null, pending: number) =>
  [
    where?.branch ? `ブランチ: ${branchLabel(where.branch)}` : null,
    '直近の指示(古い順、最後が作業中):',
    ...list.slice(-TITLE_HISTORY).map(entry => `- ${oneLine(entry.text).slice(0, 150)}`),
    !isRunning(target) && pending > 0
      ? `状態: 指示の作業はひと区切りし、バックグラウンドの作業 ${pending} 件の終わりを待っている`
      : !isRunning(target)
      ? `状態: 指示の作業を${STATUS_WORD[target.status]}で終え、次の指示を待っている`
      : target.steps.length > 0
        ? `段階: ${target.steps.map((step, i) => `${i < target.done ? '✓' : i === target.done ? '▶' : '○'}${step}`).join(' ')}`
        : '段階: 着手したところ',
  ]
    .filter(Boolean)
    .join('\n')

// 前置きや括弧、帯の一番上に出している Issue 番号を付けて返すことがあるので、1行目の中身だけを残す
const cleanTitle = (text: string) =>
  firstLine(text.trim())
    .replace(/^(タイトル|title)\s*[:：]\s*/i, '')
    .replace(/^[「『"']+|[」』"']+$/g, '')
    .replace(/^#\d+\s*/, '')
    .trim()
    .slice(0, 60)

// 返事を待つ間に次の付け直しが始まったら、遅れた返事は捨てる
let titleRequest = 0

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

// ペインは開きっぱなしにせず、帯を押したときだけ出し、もう一度押すと閉じる
async function togglePane($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  await (isOpen ? $.ui.close({ id: PANE }) : openPane($))
}

async function refreshTitle($: EngineInterface) {
  const request = ++titleRequest
  const list = await read($, entries)
  const target = bandTarget(list)
  if (!target) return

  const reply = await $.model
    .complete({
      model: TITLE_MODEL,
      system: TITLE_RULE,
      prompt: titlePrompt(
        list,
        target,
        await read($, place),
        liveBackground(await read($, background), await $.clock.now()).length,
      ),
      maxTokens: 160,
      effort: 'low',
      timeoutMs: 15000,
    })
    .catch(() => null)
  const title = reply?.isAnswered ? cleanTitle(reply.text) : ''
  if (request !== titleRequest) return

  // 付けられなかったときは、前の指示のタイトルを残さず指示の1行目に戻す
  await update($, sessionTitle, () => title || null)
}

const SUMMARY_RULE =
  'Claude Code で人が出した指示と、それに対してやった作業を、あとで履歴を見返す人のために要約する。' +
  '次の2行だけを返す。\n指示: 指示の要点(40字以内)\n作業: 実際にやったことと結果(80字以内。終わっていない点があれば含める)'

const gitOpText = (found: GitOp) => `${GIT_OP_WORD[found.kind]} ${found.label}`.trim()

const summaryPrompt = (entry: Entry, answer: string) =>
  [
    `指示:\n${entry.text.slice(0, 1500)}`,
    `作業の終わりの返答:\n${answer.slice(0, 3000) || '(なし)'}`,
    entry.files.length > 0 ? `変えたファイル: ${entry.files.map(basename).join(', ')}` : null,
    entry.commits.length > 0 ? `コミット: ${entry.commits.map(commit => commit.subject).join(' / ')}` : null,
    entry.gitOps.length > 0 ? `git の操作: ${entry.gitOps.map(gitOpText).join(' / ')}` : null,
    `状態: ${STATUS_WORD[entry.status]}`,
  ]
    .filter(Boolean)
    .join('\n\n')

const pickLine = (text: string, head: string) =>
  new RegExp(`^\\s*${head}\\s*[:：]\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() || null

// answers は指示の id から、その作業の終わりの返答へ
async function summarize($: EngineInterface, answers: Map<number, string>) {
  for (const entry of (await read($, entries)).filter(item => answers.has(item.id))) {
    const answer = answers.get(entry.id) ?? ''
    if (!answer && entry.files.length === 0 && entry.gitOps.length === 0) continue

    const reply = await $.model
      .complete({
        model: TITLE_MODEL,
        system: SUMMARY_RULE,
        prompt: summaryPrompt(entry, answer),
        maxTokens: 300,
        effort: 'low',
        timeoutMs: 20000,
      })
      .catch(() => null)
    const ask = reply?.isAnswered ? pickLine(reply.text, '指示') : null
    const summary = reply?.isAnswered ? pickLine(reply.text, '作業') : null
    if (!ask && !summary) continue

    await update($, entries, list =>
      updateEntry(list, entry, item => ({ ...item, ask: ask ?? item.ask, summary: summary ?? item.summary })),
    )
  }
}

// 裏の作業が終わった通知。待機中に届いたら、通知を受けて動くターンを最後の指示の続きとして作業中に戻す
async function settleNotice($: EngineInterface, text: string) {
  await update($, background, list => settleBackground(list, text))
  const list = await read($, entries)
  const last = list.findLast(entry => !isQueued(entry))
  if (last?.status === 'done' && !list.some(isRunning)) {
    await update($, entries, items =>
      updateEntry(items, last, entry => ({ ...entry, status: 'running' as const, turnId: null, seconds: null })),
    )
  }
}

// 裏で走らせた Bash を数える。ID は通知の本文と照らすために使い、結果の形が変わって取れなくても数には入れる
async function trackShell($: EngineInterface, result: unknown) {
  const id = /"backgroundTaskId":"([^"]+)"/.exec(JSON.stringify(result))?.[1] ?? null
  const at = await $.clock.now()
  await update($, background, list => [...list, { kind: 'shell' as const, id, at }])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-log',
      description: 'このセッションの指示の履歴と進捗をペインで開く',
    })
    await $.tool.register({
      name: 'progress',
      description:
        '指示の作業の進み具合を、人が見ている進捗バーに出す。' +
        '着手時に plan で段階名の一覧を送り(送り直すと置き換わり、done は 0 に戻る)、' +
        '段階を終えるたびに done で終えた段階の数を送る。' +
        '3段階以上に分かれる作業でだけ使い、1〜2手で終わる作業では呼ばない。',
      inputSchema: {
        type: 'object',
        properties: {
          plan: {
            type: 'array',
            items: { type: 'string' },
            description: '段階名の一覧。各20字以内の日本語で、作業の順に並べる',
          },
          done: { type: 'integer', minimum: 0, description: '終えた段階の数' },
        },
      },
    })

    const known = await read($, entries)
    if (known.length === 0) {
      // 再開したセッションや途中から読み込んだときは、過去の指示を完了扱いで埋める
      // 指示ごとに、次の指示までの最後の返答を作業の結果として持っておく
      const past: { text: string; answer: string }[] = []
      for (const m of await $.session.messages()) {
        const last = past.at(-1)
        if (m.role === 'user' && !m.toolResults?.length) {
          const text = tidy(stripTags(m.text))
          if (text.length > 0) past.push({ text, answer: '' })
        } else if (m.role === 'assistant' && m.text.trim() && last) {
          last.answer = m.text
        }
      }
      const filled = past.slice(-MAX_ENTRIES).map((item, i, list) => ({
        ...item,
        entry: newEntry({
          id: -(list.length - i),
          text: item.text,
          at: 0,
          startedAt: 0,
          status: 'done',
          turnId: null,
        }),
      }))
      await update($, entries, () => filled.map(item => item.entry))
      // Haiku を呼びすぎないよう、要約は直近の数件だけ付ける
      void summarize($, new Map(filled.slice(-BACKFILL).map(item => [item.entry.id, item.answer])))
    } else {
      // 前の版が残した記録に、増えた項目の既定値を足す
      await update($, entries, list =>
        list.map(entry => ({
          ...entry,
          steps: entry.steps ?? [],
          done: entry.done ?? 0,
          startedAt: entry.startedAt ?? entry.at,
          commits: entry.commits ?? [],
          gitOps: entry.gitOps ?? [],
          ask: entry.ask ?? null,
          summary: entry.summary ?? null,
        })),
      )
    }

    // セッションを開き直すと裏の作業は残っていないので、前の記録を捨てる
    await update($, background, () => [])
    await refreshPlace($)

    // 作業中だけ経過時間を進める
    $.clock.every(5000, async () => {
      const list = await read($, entries)
      if (list.some(isRunning)) {
        const at = await $.clock.now()
        await update($, now, () => at)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'session-log' }, async $ => {
    await openPane($)

    return { text: '指示の履歴を開きました。' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      await settleNotice($, e.text)
      return next(e)
    }
    const isPerson = PERSON_ORIGINS.has(e.origin.kind)
    const text = tidy(e.text)

    if (!isPerson || text.length === 0) {
      return next(e)
    }

    const at = await $.clock.now()
    // 走っているターンの最中に打った指示は、自分の番が来るまで待ちにする
    const queued = e.turnId !== undefined
    const entry = newEntry({
      id: at,
      text,
      at,
      startedAt: queued ? 0 : at,
      status: queued ? 'queued' : 'running',
      turnId: null,
    })
    await update($, entries, list => [...list, entry].slice(-MAX_ENTRIES))
    await update($, now, () => at)

    return next({ ...e, context: [...(e.context ?? []), PROGRESS_RULE] })
  })

  // 待ちの指示が自分のターンで始まったら、本文を照らして作業中に移す
  on('turn.start', async ($, e, next) => {
    // 指示の外(人の手元)で増えたコミットは拾わないよう、ターンの頭で HEAD を取り直す
    const head = await readHead($).catch(() => null)
    if (head) await update($, lastHead, () => head)
    const started = matchKey(e.text)
    const at = await $.clock.now()
    await update($, entries, list => {
      // 同じ文面の指示が前にもあるので、照らすのは最新の1件だけ
      const matched =
        started.length > 0
          ? list.findLast(
              entry => entry.at > 0 && entry.turnId === null && started.startsWith(matchKey(entry.text)),
            )
          : undefined
      // 他のフックが本文を書き換えると照らせないので、何も走っていなければ最も古い待ちを始める
      const own =
        matched ?? (list.some(isRunning) ? undefined : list.find(isQueued))
      return list.map(entry => {
        if (entry.id === own?.id) {
          return startRunning(entry, e.turnId, at)
        }
        // 待ちは送った順に進むので、追い越された待ちは取り込まれ済みとみなす
        if (own && isQueued(entry) && entry.id < own.id) {
          return { ...entry, status: 'done' as const }
        }
        if (isRunning(entry) && entry.turnId === null) {
          return { ...entry, turnId: e.turnId }
        }
        return entry
      })
    })
    // サブエージェントのターンでは付け直さない。ターンを待たせないよう返事は待たない
    if (focusRunning(await read($, entries))?.turnId === e.turnId) {
      void refreshTitle($)
    }

    return next(e)
  })

  // 待ちの指示は、走っているターンに途中から取り込まれることもある
  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    const body = oneLine(e.text)
    const at = await $.clock.now()
    await update($, entries, list => {
      const absorbed = list.find(entry => isQueued(entry) && body.includes(matchKey(entry.text)))
      const turnId = latestRunning(list)?.turnId ?? null
      return updateEntry(list, absorbed, entry => startRunning(entry, turnId, at))
    })

    return next(e)
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const plan = asSteps(e.plan)
    const done = typeof e.done === 'number' ? Math.floor(e.done) : null
    const list = await read($, entries)
    // 段階の送り直しは今の指示に、done だけの申告は段階を持つ指示に付ける
    const target = plan ? latestRunning(list) : focusRunning(list)

    if (!target) {
      return { result: '作業中の指示がないので、進捗は表示していません。' }
    }

    const steps = plan ?? target.steps
    if (steps.length === 0) {
      return { deny: '先に plan で段階名の一覧を送ってください。' }
    }
    if (done !== null && (done < 0 || done > steps.length)) {
      return { deny: `done は 0〜${steps.length} で送ってください。段階: ${steps.join(' / ')}` }
    }

    const nextDone = done ?? (plan ? 0 : target.done)
    await update($, entries, list =>
      updateEntry(list, target, entry => ({ ...entry, steps, done: nextDone })),
    )
    void refreshTitle($)

    return { result: `進捗 ${nextDone}/${steps.length} を表示しました。` }
  })

  on('tool.call', async ($, e, next) => {
    const file =
      e.tool === 'Edit' || e.tool === 'Write'
        ? e.file_path
        : e.tool === 'NotebookEdit'
          ? e.notebook_path
          : null

    if (file) {
      await update($, entries, list =>
        updateRunning(list, entry =>
          entry.files.includes(file) ? entry : { ...entry, files: [...entry.files, file] },
        ),
      )
    }

    return next(e)
  })

  // 作業の締めはコミットのあとワークツリーごと消すので、ターンの終わりを待たず git のたびに拾う
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const answer = await next(e)
    if ((e as { run_in_background?: boolean }).run_in_background && answer.result && !answer.isError) {
      await trackShell($, answer.result)
    }
    if (!/\b(git|gh)\b/.test(e.command)) return answer

    const found = answer.result && !answer.isError ? gitOpsOf(e.command, answer.result.stdout) : []
    if (found.length > 0) {
      await update($, entries, list =>
        updateEntry(list, focusRunning(list) ?? list.at(-1), entry => ({
          ...entry,
          gitOps: [...entry.gitOps, ...found],
        })),
      )
    }
    await refreshGit($)
    return answer
  })

  on('agent.spawn', async ($, e, next) => {
    const answer = await next(e)
    if (e.background && 'agentId' in answer) {
      const at = await $.clock.now()
      await update($, background, list => [...list, { kind: 'agent' as const, id: answer.agentId, at }])
    }
    return answer
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId || !answer.result || answer.isError) return answer

    const todos = answer.result.newTodos
    await update($, tasks, () =>
      todos.map((todo, i) => ({
        id: `todo-${i}`,
        subject: todo.content,
        status: todo.status,
      })),
    )
    return answer
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId || !answer.result || answer.isError) return answer

    const { id, subject } = answer.result.task
    await update($, tasks, list => [
      ...list.filter(task => task.id !== id),
      { id, subject, status: 'pending' as const },
    ])
    return answer
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId || !answer.result || answer.isError || !answer.result.success) return answer

    await update($, tasks, list =>
      e.status === 'deleted'
        ? list.filter(task => task.id !== e.taskId)
        : list.map(task =>
            task.id === e.taskId
              ? {
                  ...task,
                  subject: e.subject ?? task.subject,
                  status: isTaskStatus(e.status) ? e.status : task.status,
                }
              : task,
          ),
    )
    return answer
  })

  on('turn.complete', async ($, e, next) => {
    // サブエージェントのターンは指示の区切りではない。裏のサブエージェントなら待ちから外す
    if (e.agentId) {
      const before = await read($, background)
      await update($, background, list => list.filter(item => item.id !== e.agentId))
      const isIdle = !(await read($, entries)).some(entry => isRunning(entry) || isQueued(entry))
      if (isIdle && before.length > 0 && (await read($, background)).length === 0) void refreshTitle($)
      return next(e)
    }

    // 作業中のうちに拾わないと、増えたコミットが次の待ちの指示に付いてしまう
    await refreshGit($)
    const at = await $.clock.now()
    const status: EntryStatus =
      e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'

    const finished = new Set(
      (await read($, entries))
        .filter(entry => isRunning(entry) && (entry.turnId === e.turnId || entry.turnId === null))
        .map(entry => entry.id),
    )
    await update($, entries, list =>
      list.map(entry => {
        if (finished.has(entry.id)) {
          return { ...entry, status, seconds: Math.round((at - entry.startedAt) / 1000) }
        }
        // 中断すると待ちの指示は入力欄へ戻り、走らない
        if (isQueued(entry) && status === 'aborted') {
          return { ...entry, status }
        }
        return entry
      }),
    )
    await update($, now, () => at)
    // 待ちが続くなら次のターンの頭で付け直すので、待機に入るときだけ終わった状態を反映する
    if (!(await read($, entries)).some(entry => isRunning(entry) || isQueued(entry))) {
      void refreshTitle($)
    }
    void summarize($, new Map([...finished].map(id => [id, e.answer])))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, entries)
    const current = await read($, now)
    const where = await read($, place)
    const remaining = openTasks(await read($, tasks))
    const finished = list.filter(entry => entry.status === 'done').length
    // 番号は全件の通し番号。新しい順に並べても、どの指示か言い合える
    const numbered = list.map((entry, i) => ({ entry, number: i + 1 })).slice(-PANE_LIMIT).reverse()
    const active = numbered.filter(({ entry }) => isRunning(entry))
    // 待ちは番が来る順(送った順)に並べる
    const waiting = numbered.filter(({ entry }) => isQueued(entry)).reverse()
    const past = numbered.filter(({ entry }) => !isRunning(entry) && !isQueued(entry))

    const meta = (entry: Entry, number: number) => {
      const seconds = elapsedOf(entry, current)
      const order = isQueued(entry) ? waiting.findIndex(item => item.entry.id === entry.id) + 1 : 0
      return (
        <Text wrap="wrap">
          <Text color={toneOf(entry)} bold={isRunning(entry)}>
            {ICON[entry.status]} {STATUS_WORD[entry.status]}
            {order > 0 ? ` ${order}番目` : ''}
          </Text>
          <Text dimColor>
            {` #${number} ・ ${clock(entry.at)}`}
            {seconds === null ? '' : ` ・ ${duration(seconds)}`}
            {entry.files.length > 0 ? ` ・ ファイル${entry.files.length}` : ''}
            {entry.commits.length > 0 ? ` ・ コミット${entry.commits.length}` : ''}
          </Text>
        </Text>
      )
    }

    const stepRow = (key: string, state: 'past' | 'now' | 'later', label: string) => (
      <Text wrap="wrap" key={key}>
        <Text color={state === 'past' ? 'green' : state === 'now' ? 'blue' : 'gray'}>
          {state === 'past' ? '✓' : state === 'now' ? '▶' : '○'}
        </Text>{' '}
        <Text bold={state === 'now'} dimColor={state === 'later'} strikethrough={state === 'past'}>
          {label}
        </Text>
      </Text>
    )

    // 作業中と待ちは指示の全文と段階を、終わった指示は指示と作業の要約を見せる
    const card = (entry: Entry, number: number) => {
      const isPast = !isRunning(entry) && !isQueued(entry)
      // コミットの一覧に出ているコミットは、操作の一覧に重ねて出さない
      const ops = entry.gitOps.filter(
        found => !found.sha || !entry.commits.some(commit => commit.sha.startsWith(found.sha ?? '')),
      )
      return (
        <Box
          key={`card-${entry.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={toneOf(entry)}
          paddingX={1}
        >
          {meta(entry, number)}
          {isPast ? (
            <Box flexDirection="column">
              <Text wrap="wrap">
                <Text dimColor>指示 </Text>
                {entry.ask ?? firstLine(entry.text)}
              </Text>
              {entry.summary && (
                <Text wrap="wrap">
                  <Text dimColor>作業 </Text>
                  {entry.summary}
                </Text>
              )}
            </Box>
          ) : (
            <Text wrap="wrap">{entry.text}</Text>
          )}
          {entry.commits.length + ops.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {entry.commits.map(commit => (
                <Text wrap="wrap" key={`${entry.id}-commit-${commit.sha}`}>
                  <Text color={COMMIT_COLOR[commit.state]}>● {commitWord(commit.state, where?.base ?? '基点')}</Text>
                  <Text dimColor={commit.state === 'gone'} strikethrough={commit.state === 'gone'}>
                    {` ${commit.sha.slice(0, 7)} ${commit.subject}`}
                  </Text>
                </Text>
              ))}
              {ops.map((found, i) => (
                <Text wrap="wrap" key={`${entry.id}-op-${i}`}>
                  <Text color="cyan">◆ {GIT_OP_WORD[found.kind]}</Text>
                  {found.label ? ` ${found.label}` : ''}
                </Text>
              ))}
            </Box>
          )}
          {isRunning(entry) && entry.steps.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {entry.steps.map((step, i) =>
                stepRow(`${entry.id}-step-${i}`, i < entry.done ? 'past' : i === entry.done ? 'now' : 'later', step),
              )}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>
          指示 {list.length}件
          <Text dimColor>
            {`  完了 ${finished}`}
            {active.length > 0 ? ` ・ 作業中 ${active.length}` : ''}
            {waiting.length > 0 ? ` ・ 待ち ${waiting.length}` : ''}
          </Text>
        </Text>
        {list.length === 0 && <Text dimColor>まだ指示はありません。</Text>}
        {active.map(({ entry, number }) => card(entry, number))}
        {remaining.length > 0 && (
          <Box flexDirection="column">
            <Text bold>タスク 残り{remaining.length}</Text>
            {remaining.map(task =>
              stepRow(`task-${task.id}`, task.status === 'in_progress' ? 'now' : 'later', task.subject),
            )}
          </Box>
        )}
        {waiting.length > 0 && <Text dimColor>待ち</Text>}
        {waiting.map(({ entry, number }) => card(entry, number))}
        {past.length > 0 && active.length + waiting.length > 0 && <Text dimColor>これまで</Text>}
        {past.map(({ entry, number }) => card(entry, number))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, entries)
    const target = bandTarget(list)
    const waitCount = list.filter(isQueued).length
    const where = await read($, place)

    if (e.props.hasSurvey || (!target && !where)) {
      return next(e)
    }

    const parts = $.ui.resolve(e)
    const { Box, Text, Button } = parts
    // ターミナルの部品表にも Svg はあるが何も描かれないので、デスクトップだけで使う
    const Svg = e.surface === 'desktop' && 'Svg' in parts ? parts.Svg : null

    // デスクトップは線画のアイコン、ターミナルは絵文字を添える。狭いときは項目の切れ目で折り返す
    const placeRow = where && (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {placeChips(where).map(chip => {
          const style = CHIP_STYLE[chip.kind]
          const isBranch = chip.kind === 'branch'
          return Svg ? (
            <Box key={chip.kind} flexDirection="row" alignItems="center" gap={1}>
              <Svg source={iconSvg(chip.kind)} alt={style.name} width={ICON_SIZE} height={ICON_SIZE} />
              <Text bold={isBranch} color={isBranch ? undefined : style.color}>
                {chip.text}
              </Text>
            </Box>
          ) : (
            <Text key={chip.kind} bold={isBranch} color={isBranch ? undefined : style.color}>
              {`${style.emoji} ${chip.text}`}
            </Text>
          )
        })}
      </Box>
    )

    if (!target) {
      return <Box flexDirection="column">{placeRow}</Box>
    }

    const seconds = elapsedOf(target, await read($, now))
    const title = (await read($, sessionTitle)) ?? firstLine(target.text)
    // 指示を終えても裏の作業が残っていれば、完了と出さずに待っている件数を出す
    const pending = liveBackground(await read($, background), await $.clock.now()).length
    const isWaitingBackground = target.status === 'done' && pending > 0
    const statusWord = isWaitingBackground ? `バックグラウンド ${pending}件` : STATUS_WORD[target.status]
    const meter: Meter = isWaitingBackground
      ? { ...meterOf(target), label: statusWord, tone: 'running' }
      : meterOf(target)

    // 1行目はタイトルと経過時間だけにして、タイトルが進捗バーに押し出されないようにする
    const titleRow = (
      <Box flexDirection="row" gap={1}>
        <Button key={PANE} plain onPress={() => void togglePane($)}>
          <Text wrap="wrap">{title}</Text>
        </Button>
        <Box flexGrow={1} />
        <Text dimColor>
          {statusWord}
          {seconds === null ? '' : ` ${duration(seconds)}`}
          {waitCount > 0 ? ` ・ 待ち ${waitCount}` : ''}
        </Text>
      </Box>
    )

    // デスクトップは1桁がおよそ8px。幅を全部バーに充てる
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    const trackWidth = Math.max(160, Math.min(1600, total - 16))
    const cells = bar(meter.done, meter.total, Math.max(10, Math.min(40, (e.props.bodyColumns || 100) - 40)))

    return (
      <Box flexDirection="column">
        {placeRow}
        {titleRow}
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg
              source={trackSvg(meter, trackWidth)}
              alt={`進捗 ${meter.label}`}
              width={trackWidth}
              height={TRACK_H}
            />
          ) : (
            <Text wrap="truncate-end">
              <Text color={METER_COLOR[meter.tone]}>{cells.filled}</Text>
              <Text dimColor>{cells.rest}</Text>
              <Text color={METER_COLOR[meter.tone]}> {meter.label}</Text>
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
