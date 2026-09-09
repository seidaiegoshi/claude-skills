# claude-skills

Claude Code 用のプラグイン `mitate`。**理解と判断を速くする**ためのスキル 2 本。

作業を前に進めるには判断が要る。判断するには、まずその論点を理解している必要がある。
この 2 本は、Claude が返してくるものをその 2 段階に合わせて整える。中身は Claude に渡す
Markdown の手順書と、それが使う雛形・スクリプト。

| スキル | 何をするか |
|---|---|
| [`visual-explanation`](plugins/mitate/skills/visual-explanation/SKILL.md) | **理解を速くする。** 設計提案・調査結果・変更サマリを説明するとき、図にする / しないの判断、図の型の選び方、完了報告の組み立て方を決める。画面キャプチャの撮影・埋め込みスクリプトを同梱 |
| [`siji-decision-sheet`](plugins/mitate/skills/siji-decision-sheet/SKILL.md) | **判断を速くする。** 判断が要る論点を「1 論点 = 1 カード」の HTML に並べ、下部の回答バーをコピーして返すだけで決定が確定する判断書を作る |

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

## 前提

- `siji-decision-sheet` は HTML を Artifact として公開できる環境（Claude Code / claude.ai）を前提にする
- `visual-explanation` のキャプチャ機能は Node + Playwright が要る。図解の判断基準そのものは無くても効く

## ~/.claude/skills/ に直接置く場合

プラグインを使わず、スキル 1 本だけ手元に置くこともできる。

```bash
cp -R plugins/mitate/skills/siji-decision-sheet ~/.claude/skills/
```

`visual-explanation` のキャプチャ用コマンドは `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}` を基準にしているので、
この置き方でもパスは通る。
