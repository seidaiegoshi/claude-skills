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
  // この指示のあいだに増えたコミット
  commits: Commit[]
  // この指示のあいだに打った git / gh の操作(コミット・マージ・push・PR など)
  gitOps: GitOp[]
  // 終わったあとに Haiku が付けた指示の要点と、やった作業の要約。まだ無ければ null
  ask: string | null
  summary: string | null
}

export type GitOpKind =
  | 'commit'
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'reset'
  | 'push'
  | 'pull'
  | 'branch'
  | 'branch-delete'
  | 'worktree'
  | 'worktree-remove'
  | 'tag'
  | 'pr-create'
  | 'pr-merge'
  | 'pr-close'

export type GitOp = {
  kind: GitOpKind
  // 操作の相手(ブランチ名・PR番号・コミットの件名など)。無ければ空
  label: string
  // コミットだけ。コミットの一覧と重ねて出さないために持つ
  sha: string | null
}

// branch: 作業ブランチにだけある / merged: 基点ブランチへマージ済み(未push) /
// pushed: origin の基点ブランチまで届いた / gone: 書き換えや削除でどのブランチにも残っていない
export type CommitState = 'branch' | 'merged' | 'pushed' | 'gone'

export type Commit = {
  sha: string
  subject: string
  state: CommitState
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
  // ワークツリーを切った元のブランチ。メインの作業ツリーや推定できないときは null
  from: string | null
  // マージ先とみなすブランチ(origin/HEAD が指す先)。分からなければ null
  base: string | null
  // origin が GitHub のときのリポジトリの URL(例: https://github.com/owner/repo)。それ以外は null
  githubUrl: string | null
  // 未コミットのファイル数と、基点ブランチに無いコミットの数
  dirty: number
  ahead: number
  // 未マージが無い作業ブランチで、基点ブランチまで(merged)か origin の基点ブランチまで(pushed)届いたか。
  // 基点ブランチそのものや未マージがあるとき、前の版で覚えた場所では null か無い
  landed?: 'merged' | 'pushed' | null
}

// 指示が終わっても裏で走り続ける作業。サブエージェントは agentId、Bash は通知と照らす ID(取れなければ null)
export type Background = {
  kind: 'agent' | 'shell'
  id: string | null
  at: number
}

// ペインの Git タブに描くコミット。git log --all の新しい順
export type GraphCommit = {
  sha: string
  parents: string[]
  // git log の %D を分けたもの(例: HEAD -> develop / origin/develop / tag: v1)
  refs: string[]
  subject: string
  author: string
  // コミット日時(UNIX 秒)
  at: number
}

export type Graph = {
  commits: GraphCommit[]
  // ワークツリーで開いているブランチ。グラフで印を付ける
  worktreeBranches: string[]
  // 読み込んだ時刻(ミリ秒)。更新ボタンが効いたことを見せる
  loadedAt: number
  // 最後の読み直しで git を読めなかった。commits は前に読めた分
  isFailed?: boolean
}

export type PaneTab = 'history' | 'git'

declare module 'claude-code' {
  interface PluginState {
    'session-log': {
      entries: Entry[]
      now: number
      place: Place | null
      tasks: Task[]
      // 最後に見た HEAD。ここから先に増えたコミットを指示に付ける
      lastHead: string | null
      // Haiku が付けたセッションの内容と状態のタイトル。まだ無ければ null
      title: string | null
      // Haiku が付けたセッション全体の作業の概要。最初の指示が終わるまでは null
      overview: string | null
      background: Background[]
      tab: PaneTab
      // まだ読んでいなければ null
      graph: Graph | null
    }
  }
}
