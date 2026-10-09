# claude-skills

Claude Code 用のプラグイン `mitate`。**理解と判断を速くする**ためのスキル 2 本。

作業を前に進めるには判断が要る。判断するには、まずその論点を理解している必要がある。
この 2 本は、Claude が返してくるものをその 2 段階に合わせて整える。中身は Claude に渡す
Markdown の手順書と、それが使う雛形・スクリプト。

| スキル | 何をするか |
|---|---|
| [`visual-explanation`](plugins/mitate/skills/visual-explanation/SKILL.md) | **理解を速くする。** 設計提案・調査結果・変更サマリを説明するとき、図にする / しないの判断、図の型の選び方、完了報告の組み立て方を決める。画面キャプチャの撮影・埋め込みスクリプトを同梱 |
| [`handansho`](plugins/mitate/skills/handansho/SKILL.md) | **判断を速くする。** 判断が要る論点を「1 論点 = 1 カード」の HTML に並べ、下部の回答バーをコピーして返すだけで決定が確定する判断書を作る。動作に関わる論点はバグ報告と同じく「現状の動作」と各案の「この案での動作」を同じ操作で並べ、見た目が変わる論点は現状と各案の画面を並べる。前提の各行に「違う」を付けて、食い違いも同じ回答で返せる。回答は「Claude に送る」でチャットに貼らずに返せる。画面が絡む論点では、決定済みの方針を先に集め、実物を開いて実測してから書く。WCAG コントラスト計測スクリプトを同梱 |

スキルは互いに独立している。使わないスキルは呼ばれないので、何も起きない。

## 導入

```bash
claude plugin marketplace add seidaiegoshi/claude-skills
claude plugin install mitate@claude-skills
```

Claude Code の対話セッションからは `/plugin marketplace add seidaiegoshi/claude-skills` →
`/plugin install mitate@claude-skills` でも同じ。反映には再起動が要る。

入ったかどうかは、スキル一覧に `mitate:handansho` のように `mitate:` 付きで並ぶかで分かる。

## 更新

```bash
claude plugin update mitate
```

このリポジトリを更新したら、各 PC でこれを実行すれば降りてくる。
ただし `plugin.json` の**バージョン番号を据え置いたまま中身だけ直した場合は、`update` が
「already at the latest version」で何もせず終わる**ことがある。そのときは入れ直す。

```bash
claude plugin uninstall mitate@claude-skills && claude plugin install mitate@claude-skills
```

## 前提

- `handansho` は HTML を Artifact として公開できる環境（Claude Code / claude.ai）を前提にする。画面が絡む論点を扱うときだけブラウザを開く手段が要る（無い環境では前提の行末に「未実測」と書いて進む）
- `visual-explanation` のキャプチャ機能は Node + Playwright が要る。図解の判断基準そのものは無くても効く
- `handansho` の「見た目」欄は、キャプチャと拡大表示に `visual-explanation` の `capture.cjs`・`embed.sh`・`lightbox.html` を使う。1本だけ手元に置く場合は、見た目欄を SVG の見本だけで書く

## ~/.claude/skills/ に直接置く場合

プラグインを使わず、スキル 1 本だけ手元に置くこともできる。

```bash
cp -R plugins/mitate/skills/handansho ~/.claude/skills/
```

`visual-explanation` のキャプチャ用コマンドは `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}` を基準にしているので、
この置き方でもパスは通る。
