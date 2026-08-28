# claude-skills

Claude Code 用のスキル 2 本。**報告と判断の出し方**を揃えるためのもので、
どちらも「文章の書き方・HTML の作り方の手順」を Claude に渡す Markdown ファイルです。

| スキル | 何をするか |
|---|---|
| [`visual-explanation`](skills/visual-explanation/SKILL.md) | 設計提案・調査結果・変更サマリを説明するとき、図にする / しないの判断、図の型の選び方、出し方（HTML アーティファクト / インライン図解）を決める |
| [`siji-decision-sheet`](skills/siji-decision-sheet/SKILL.md) | 判断が要る論点を「1 論点 = 1 カード」の HTML に並べ、下部の回答バーをコピーして返すだけで決定が確定する判断書を作る |

2 本は独立しています。片方だけ入れても動きます。

## 導入

スキルは `~/.claude/skills/` 配下に置くと、全プロジェクトで使えるようになります。
Claude Code の再起動が要ります。

### ZIP を受け取った場合

```bash
unzip claude-skills.zip -d ~/.claude/skills/
```

`~/.claude/skills/visual-explanation/` と `~/.claude/skills/siji-decision-sheet/` が
できていれば成功です。

### このリポジトリから直接入れる場合

```bash
git clone https://github.com/<owner>/claude-skills.git
cp -R claude-skills/skills/* ~/.claude/skills/
```

### 特定のプロジェクトだけで使いたい場合

`~/.claude/skills/` の代わりに、そのリポジトリの `.claude/skills/` に置きます。
この場合はコミットされるので、チーム全員のセッションに載ります。

## 入ったかどうかの確認

Claude Code を再起動して、次のように聞きます。

```
判断が必要な論点があるので判断書にして
```

`siji-decision-sheet` を使う旨が出れば読み込まれています。
`/visual-explanation` のようにスラッシュで直接呼ぶこともできます。

## 更新

このリポジトリが更新されたら、ZIP を受け取り直して同じ手順で上書きするか、
`git pull` してコピーし直してください。自動では降りてきません。

## 前提

- `siji-decision-sheet` は HTML を Artifact として公開できる環境（Claude Code / claude.ai）を前提にします。
- `visual-explanation` のセクション 4 はインライン図解ツール（`show_widget`）がある場合の作法です。
  無い環境では同スキルのセクション 3・6 に落ちるので、入れて壊れることはありません。

## ZIP を作り直す

```bash
./build-zip.sh
```

`dist/claude-skills.zip` ができます。中身は `skills/` 配下そのままなので、
受け取った側は `~/.claude/skills/` に展開するだけです。
