// queued は作業中に打たれ、まだ自分の番が来ていない指示
export type EntryStatus = 'queued' | 'running' | 'done' | 'aborted' | 'error'

export type Entry = {
  id: number
  text: string
  // 0 は送信時刻が分からない(途中から読み込んだ過去の指示)
  at: number
  status: EntryStatus
  // 自分の番が来て作業を始めた時刻。経過時間はここから数える(待ちの時間を含めない)
  startedAt: number
  turnId: string | null
  seconds: number | null
  files: string[]
  // モデルが progress ツールで申告した段階の一覧と、終えた段階の数
  steps: string[]
  done: number
}

// モデルが TaskCreate / TodoWrite で立てたタスク。セッションを通して持ち越す
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  status: TaskStatus
}

// セッションがどこで動いているか。ペインの見出しとステータスラインに出す
export type Place = {
  isCloud: boolean
  repo: string | null
  branch: string | null
  // メインの作業ツリーでないときだけ、そのフォルダ名
  worktree: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-log': { entries: Entry[]; now: number; place: Place | null; tasks: Task[] }
  }
}
