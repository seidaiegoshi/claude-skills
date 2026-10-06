export type EntryStatus = 'running' | 'done' | 'aborted' | 'error'

export type Entry = {
  id: number
  text: string
  // 0 は送信時刻が分からない(途中から読み込んだ過去の指示)
  at: number
  status: EntryStatus
  turnId: string | null
  seconds: number | null
  files: string[]
  // モデルが progress ツールで申告した段階の一覧と、終えた段階の数
  steps: string[]
  done: number
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
    'session-log': { entries: Entry[]; now: number; place: Place | null }
  }
}
