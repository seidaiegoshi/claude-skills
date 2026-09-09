# claude-skills

Claude Code 用のプラグイン `mitate`。**報告・判断・レビューの出し方を揃える**ためのスキル 4 本と、
コメント規約の機械検査フック 1 本が入っている。中身は Claude に渡す Markdown の手順書と、
それが使う雛形・スクリプト。

| スキル | 何をするか |
|---|---|
| [`siji-decision-sheet`](plugins/mitate/skills/siji-decision-sheet/SKILL.md) | 判断が要る論点を「1 論点 = 1 カード」の HTML に並べ、下部の回答バーをコピーして返すだけで決定が確定する判断書を作る |
| [`visual-explanation`](plugins/mitate/skills/visual-explanation/SKILL.md) | 設計提案・調査結果・変更サマリを説明するとき、図にする / しないの判断、図の型の選び方、完了報告の組み立て方を決める。画面キャプチャの撮影・埋め込みスクリプトを同梱 |
| [`concise-comments`](plugins/mitate/skills/concise-comments/SKILL.md) | コードコメントと docstring を簡潔に保つ判断基準。「なに」を消して「なぜ」を残す |
| [`design-kaizen-teian`](plugins/mitate/skills/design-kaizen-teian/SKILL.md) | 動いている画面をブラウザで開き、コントラスト比や余白を実測したうえで「修正前 ↔ 提案」の HTML を出す |

スキルは互いに独立している。使わないスキルは呼ばれないので、何も起きない。

## 導入

```bash
claude plugin marketplace add seidaiegoshi/claude-skills
claude plugin install mitate@claude-skills
```

Claude Code の対話セッションからは `/plugin marketplace add seidaiegoshi/claude-skills` →
`/plugin install mitate@claude-skills` でも同じ。反映には再起動が要る。

入ったかどうかは、スキル一覧に `mitate:siji-decision-sheet` のように `mitate:` 付きで並ぶかで分かる。

## 更新

```bash
claude plugin update mitate
```

このリポジトリを更新したら、各 PC でこれを実行すれば降りてくる。

## 同梱フック（コメント規約の機械検査）

インストールすると、`Edit` / `Write` のたびに `hooks/comment-policy-check.sh` が走る。

- 区切り線・装飾コメント（`# ---- 設定 ----` など）の追加は**その場で差し戻す**
- それ以外のコメント追加と、本文 4 行以上の docstring には**判断テストを注入する**（ブロックはしない）

意味判断は機械化できないので、書いた直後に見直させる方式を採っている。判断基準の一次情報は
`concise-comments` スキル。

**注意**: 以前このスクリプトを `~/.claude/settings.json` の hooks に直接登録していた場合は、
その登録を消すこと。消さないと 1 回の編集で 2 回走る。

## 前提

- `siji-decision-sheet` は HTML を Artifact として公開できる環境（Claude Code / claude.ai）を前提にする
- `visual-explanation` のキャプチャ機能は Node + Playwright が要る。図解の判断基準そのものは無くても効く
- `design-kaizen-teian` はブラウザ操作ツール（Claude Code のブラウザペイン等）が要る

## ~/.claude/skills/ に直接置く場合

プラグインを使わず、スキル 1 本だけ手元に置くこともできる。

```bash
cp -R plugins/mitate/skills/siji-decision-sheet ~/.claude/skills/
```

`visual-explanation` のキャプチャ用コマンドは `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}` を基準にしているので、
この置き方でもパスは通る。フックを使う場合は `~/.claude/settings.json` に自分で登録する。
