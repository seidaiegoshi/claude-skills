import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, EntryStatus, Place } from '../types'

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

const ICON: Record<EntryStatus, string> = {
  running: '▶',
  done: '✓',
  aborted: '■',
  error: '✗',
}
const STATUS_WORD: Record<EntryStatus, string> = {
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

// 色は作業中だけに付け、終わった指示は状態を問わずグレーにする
const toneOf = (entry: Entry) => (isRunning(entry) ? 'yellow' : 'gray')

const latestRunning = (list: Entry[]) => list.findLast(isRunning)

const newEntry = (fields: Pick<Entry, 'id' | 'text' | 'at' | 'status' | 'turnId'>): Entry => ({
  ...fields,
  seconds: null,
  files: [],
  steps: [],
  done: 0,
})

const bar = (done: number, total: number, cells = BAR_CELLS) => {
  const filled = Math.round((done / total) * cells)
  return { filled: '█'.repeat(filled), rest: '░'.repeat(cells - filled) }
}

const percent = (entry: Entry) => Math.round((entry.done / entry.steps.length) * 100)

// 終えた段階の次を「いまの段階」とみなす
const currentStep = (entry: Entry) => entry.steps[entry.done] ?? '仕上げ'

const stepLabel = (entry: Entry) =>
  `${Math.min(entry.done + 1, entry.steps.length)}/${entry.steps.length} ${currentStep(entry)}`

const firstLine = (text: string) => text.split('\n')[0] ?? ''

const elapsedOf = (entry: Entry, current: number) =>
  isRunning(entry) ? Math.max(0, Math.round((current - entry.at) / 1000)) : entry.seconds

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
const trackSvg = (entry: Entry, width: number, text = stepLabel(entry)) => {
  const total = entry.steps.length
  const fx = (entry.done / total) * width
  const r = TRACK_H / 2
  const marks = entry.steps
    .slice(1)
    .map((_, i) => {
      const x = ((i + 1) / total) * width
      const passed = x < fx - 1
      return `<circle cx="${x.toFixed(1)}" cy="${r}" r="1.6" fill="${passed ? '#FFFFFF' : '#A8A69E'}" opacity="${passed ? 0.85 : 0.6}"/>`
    })
    .join('')
  const label = fitText(text, 11, width - 20)
  const pillW = Math.min(width, textWidth(label, 11) + 20)
  const pillX = Math.max(0, Math.min(width - pillW, fx - pillW / 2))
  const fill = fx > 0 ? `<rect width="${Math.max(fx, TRACK_H).toFixed(1)}" height="${TRACK_H}" rx="${r}" fill="${AMBER}" opacity="0.45"/>` : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TRACK_H}" viewBox="0 0 ${width} ${TRACK_H}">` +
    `<rect width="${width}" height="${TRACK_H}" rx="${r}" fill="#808080" opacity="0.18"/>` +
    fill +
    marks +
    `<rect x="${pillX.toFixed(1)}" width="${pillW.toFixed(1)}" height="${TRACK_H}" rx="${r}" fill="${AMBER}"/>` +
    `<text x="${(pillX + pillW / 2).toFixed(1)}" y="${r + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#FFFFFF">${escapeXml(label)}</text>` +
    '</svg>'
  )
}

const updateRunning = (list: Entry[], change: (entry: Entry) => Entry) => {
  const target = latestRunning(list)
  return target ? list.map(entry => (entry.id === target.id ? change(entry) : entry)) : list
}

const asSteps = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((step): step is string => typeof step === 'string' && step.trim() !== '')
    : null

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

// 例: 「local / develop」「local / 45-pane-width / worktree」。作業ブランチに付く claude/ は省く
const placeLine = (where: Place) =>
  [
    where.isCloud ? 'cloud' : 'local',
    where.branch?.replace(/^claude\//, ''),
    where.worktree ? 'worktree' : null,
  ]
    .filter(Boolean)
    .join(' / ')

async function gitLine($: EngineInterface, args: string[]) {
  const ran = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return ran.exitCode === 0 ? ran.stdout.trim() || null : null
}

// ブランチは指示のたびに切り替わりうるので毎回取り直す
async function refreshPlace($: EngineInterface) {
  try {
    await readPlace($)
  } catch {
    // 取れなくても履歴と進捗の表示は続ける
  }
}

async function readPlace($: EngineInterface) {
  const repo = await $.session.repo()
  const top = await gitLine($, ['rev-parse', '--show-toplevel'])
  const where: Place = {
    // クラウドでは CLAUDE_CODE_REMOTE が立つ
    isCloud: (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true',
    repo: repo ? basename(repo.root) : null,
    branch: await gitLine($, ['branch', '--show-current']),
    worktree: repo && top && top !== repo.root ? basename(top) : null,
  }
  await update($, place, () => where)
  $.ui.status(placeLine(where))
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
      const past = (await $.session.messages())
        .filter(m => m.role === 'user' && !m.toolResults?.length)
        .map(m => tidy(stripTags(m.text)))
        .filter(text => text.length > 0)
      await update($, entries, () =>
        past.slice(-MAX_ENTRIES).map((text, i) =>
          newEntry({
            id: -(past.length - i),
            text,
            at: 0,
            status: 'done',
            turnId: null,
          }),
        ),
      )
    } else {
      // 前の版が残した記録に、増えた項目の既定値を足す
      await update($, entries, list =>
        list.map(entry => ({ ...entry, steps: entry.steps ?? [], done: entry.done ?? 0 })),
      )
    }

    await refreshPlace($)

    // 作業中だけ経過時間を進める
    $.clock.every(5000, async () => {
      const list = await read($, entries)
      if (list.some(isRunning)) {
        const at = await $.clock.now()
        await update($, now, () => at)
      }
    })

    void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

    return next(e)
  })

  on('command.run', { command: 'session-log' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

    return { text: '指示の履歴を開きました。' }
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson = PERSON_ORIGINS.has(e.origin.kind)
    const text = tidy(e.text)

    if (!isPerson || text.length === 0) {
      return next(e)
    }

    const at = await $.clock.now()
    const entry = newEntry({
      id: at,
      text,
      at,
      status: 'running',
      turnId: e.turnId ?? null,
    })
    await update($, entries, list => [...list, entry].slice(-MAX_ENTRIES))
    await update($, now, () => at)

    return next({ ...e, context: [...(e.context ?? []), PROGRESS_RULE] })
  })

  // 作業中に打った指示は送信時点で走っていたターンの id を持つ。
  // 割り込みでなく自分のターンで始まったものは、ここで本文を照らして付け替える
  on('turn.start', async ($, e, next) => {
    const started = matchKey(e.text)
    await update($, entries, list => {
      // 同じ文面の指示が前にもあるので、照らすのは最新の1件だけ
      const own =
        started.length > 0
          ? list.findLast(entry => entry.at > 0 && started.startsWith(matchKey(entry.text)))
          : undefined
      return list.map(entry => {
        if (entry.id === own?.id) {
          return { ...entry, status: 'running', turnId: e.turnId, seconds: null }
        }
        if (isRunning(entry) && entry.turnId === null) {
          return { ...entry, turnId: e.turnId }
        }
        return entry
      })
    })

    return next(e)
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const plan = asSteps(e.plan)
    const done = typeof e.done === 'number' ? Math.floor(e.done) : null
    const target = latestRunning(await read($, entries))

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
      updateRunning(list, entry => ({ ...entry, steps, done: nextDone })),
    )

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

  on('turn.complete', async ($, e, next) => {
    // サブエージェントのターンは指示の区切りではない
    if (e.agentId) return next(e)

    const at = await $.clock.now()
    const status: EntryStatus =
      e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'

    await update($, entries, list =>
      list.map(entry =>
        isRunning(entry) && (entry.turnId === e.turnId || entry.turnId === null)
          ? { ...entry, status, seconds: Math.round((at - entry.at) / 1000) }
          : entry,
      ),
    )
    await update($, now, () => at)
    await refreshPlace($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const parts = $.ui.resolve(e)
    const { Box, Text } = parts
    const Svg = e.surface === 'desktop' && 'Svg' in parts ? parts.Svg : null
    const list = await read($, entries)
    const current = await read($, now)
    const where = await read($, place)
    const columns = e.viewport?.columns ?? PANE_COLUMNS
    const finished = list.filter(entry => entry.status === 'done').length
    // 番号は全件の通し番号。新しい順に並べても、どの指示か言い合える
    const numbered = list.map((entry, i) => ({ entry, number: i + 1 })).slice(-PANE_LIMIT).reverse()
    const active = numbered.filter(({ entry }) => isRunning(entry))
    const past = numbered.filter(({ entry }) => !isRunning(entry))

    const meta = (entry: Entry, number: number) => {
      const seconds = elapsedOf(entry, current)
      return (
        <Text wrap="wrap">
          <Text color={toneOf(entry)} bold={isRunning(entry)}>
            {ICON[entry.status]} {STATUS_WORD[entry.status]}
          </Text>
          <Text dimColor>
            {` #${number} ・ ${clock(entry.at)}`}
            {seconds === null ? '' : ` ・ ${duration(seconds)}`}
            {entry.files.length > 0 ? ` ・ ファイル${entry.files.length}` : ''}
          </Text>
        </Text>
      )
    }

    // 指示1件を1枚のカードにする。作業中は色付きの枠で、全文と段階の一覧まで見せる
    const card = (entry: Entry, number: number) => {
      const running = isRunning(entry)
      // 枠線2桁と内側の余白2桁を引いた幅
      const inner = Math.max(8, columns - 4)
      const meter = bar(entry.done, entry.steps.length || 1, Math.max(6, Math.min(BAR_CELLS * 2, inner - 6)))
      return (
        <Box
          key={`card-${entry.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={toneOf(entry)}
          paddingX={1}
        >
          {meta(entry, number)}
          <Text wrap="wrap" dimColor={!running}>
            {entry.text}
          </Text>
          {running && entry.steps.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {Svg ? (
                <Svg
                  source={trackSvg(entry, inner * 8, `${percent(entry)}%`)}
                  alt={`進捗 ${percent(entry)}%`}
                  width={inner * 8}
                  height={TRACK_H}
                />
              ) : (
                <Text>
                  <Text color="yellow">{meter.filled}</Text>
                  <Text dimColor>{meter.rest}</Text>
                  {` ${percent(entry)}%`}
                </Text>
              )}
              {entry.steps.map((step, i) => {
                const state = i < entry.done ? 'past' : i === entry.done ? 'now' : 'later'
                return (
                  <Text wrap="wrap" key={`${entry.id}-step-${i}`}>
                    <Text color={state === 'past' ? 'green' : state === 'now' ? 'yellow' : 'gray'}>
                      {state === 'past' ? '✓' : state === 'now' ? '▶' : '○'}
                    </Text>{' '}
                    <Text bold={state === 'now'} dimColor={state === 'later'} strikethrough={state === 'past'}>
                      {step}
                    </Text>
                  </Text>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {where && (
          <Text wrap="wrap" color={where.isCloud ? 'cyan' : undefined} dimColor={!where.isCloud}>
            {placeLine(where)}
          </Text>
        )}
        <Text bold>
          指示 {list.length}件
          <Text dimColor>
            {`  完了 ${finished}`}
            {active.length > 0 ? ` ・ 作業中 ${active.length}` : ''}
          </Text>
        </Text>
        {list.length === 0 && <Text dimColor>まだ指示はありません。</Text>}
        {active.map(({ entry, number }) => card(entry, number))}
        {past.length > 0 && active.length > 0 && <Text dimColor>これまで</Text>}
        {past.map(({ entry, number }) => card(entry, number))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, entries)
    const target = latestRunning(list)

    if (e.props.hasSurvey || !target) {
      return next(e)
    }

    const parts = $.ui.resolve(e)
    const { Box, Text } = parts
    // ターミナルの部品表にも Svg はあるが何も描かれないので、デスクトップだけで使う
    const Svg = e.surface === 'desktop' && 'Svg' in parts ? parts.Svg : null
    const seconds = elapsedOf(target, await read($, now)) ?? 0
    const hasProgress = target.steps.length > 0
    const title = firstLine(target.text)

    // 1行目は指示と経過時間だけにして、指示が進捗バーに押し出されないようにする
    const titleRow = (
      <Box flexDirection="row" gap={1}>
        <Text color="yellow">▶</Text>
        <Text wrap="truncate-end">{title}</Text>
        <Box flexGrow={1} />
        <Text dimColor>作業中 {duration(seconds)}</Text>
      </Box>
    )

    if (!hasProgress) {
      return titleRow
    }

    // デスクトップは1桁がおよそ8px。割合のぶんを引いた残りを全部バーに充てる
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    const trackWidth = Math.max(160, Math.min(1600, total - 60))
    const meter = bar(target.done, target.steps.length, Math.max(10, Math.min(40, (e.props.bodyColumns || 100) - 40)))

    return (
      <Box flexDirection="column">
        {titleRow}
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg
              source={trackSvg(target, trackWidth)}
              alt={`進捗 ${stepLabel(target)}`}
              width={trackWidth}
              height={TRACK_H}
            />
          ) : (
            <Text wrap="truncate-end">
              <Text color="yellow">{meter.filled}</Text>
              <Text dimColor>{meter.rest}</Text>
              <Text color="yellow"> {stepLabel(target)}</Text>
            </Text>
          )}
          <Box flexGrow={1} />
          <Text dimColor>{String(percent(target)).padStart(3, ' ')}%</Text>
        </Box>
      </Box>
    )
  })
}
