#!/usr/bin/env bash
# PostToolUse hook: コメント規約（skill concise-comments）の機械検査。
# - 区切り線・装飾コメントの追加は exit 2 でブロックし自己修正させる
# - それ以外のコメント追加・長い docstring は additionalContext でリマインドする（ブロックしない）
#
# 「なに」コメントかどうかの意味判断は機械化できないため、追加のたびに判断テストを
# 注入して書いた直後に見直させる方式を採る。プロジェクト側に同名フックがあればそちらに譲る。
set -u

# 自分自身をプロジェクト側フックと誤認しないよう、絶対パスを渡す。
COMMENT_POLICY_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
export COMMENT_POLICY_SELF

INPUT="$(cat)"

python3 -c '
import json, os, re, sys

try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)

tool_input = data.get("tool_input", {})
path = tool_input.get("file_path") or tool_input.get("path") or ""
if not path:
    sys.exit(0)

# プロジェクトが自前の同名フックを持つなら二重発火させない（自分自身は除く）。
self_path = os.path.realpath(os.environ.get("COMMENT_POLICY_SELF", ""))
probe = os.path.dirname(os.path.abspath(path))
while True:
    candidate = os.path.join(probe, ".claude/hooks/comment-policy-check.sh")
    if os.path.exists(candidate) and os.path.realpath(candidate) != self_path:
        sys.exit(0)
    parent = os.path.dirname(probe)
    if parent == probe:
        break
    probe = parent

MARKERS = {
    "#": {"py", "sh", "bash", "zsh", "rb"},
    "//": {"ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "java", "kt",
           "swift", "c", "h", "cpp", "hpp", "cc", "cs", "scala", "php", "dart"},
    "--": {"sql", "lua"},
}
EXCLUDE = re.compile(
    r"(/node_modules/|/dist/|/build/|/\.venv/|/venv/|/site-packages/|/vendor/"
    r"|/migrations/|/staticfiles/|/\.claude/|\.min\.(js|css)$|\.d\.ts$)"
)

ext = os.path.splitext(path)[1].lstrip(".").lower()
marker = next((m for m, exts in MARKERS.items() if ext in exts), None)
if marker is None or EXCLUDE.search(path):
    sys.exit(0)

def edit_pairs(ti):
    if "edits" in ti:
        return [(e.get("old_string", ""), e.get("new_string", "")) for e in ti["edits"]]
    if "new_string" in ti:
        return [(ti.get("old_string", ""), ti.get("new_string", ""))]
    if "content" in ti:
        return [("", ti.get("content", ""))]
    return []

comment_re = re.compile(r"^\s*" + re.escape(marker) + r"(?P<body>.*)$")
divider_re = re.compile(r"[-=*~#─━＝]{4,}")
# ツール向けディレクティブ・shebang はコメント規約の対象外
directive_re = re.compile(
    r"^\s*(!|type:|noqa|pragma|pylint|mypy|pyright|ruff:|fmt:|isort:|@ts-|eslint"
    r"|prettier|biome-|go:|nolint|codegen|region|/)"
)
DOC_OPEN = {"#": re.compile(r"^\s*(?:[rbfu]{0,2})(\"\"\"|\x27\x27\x27)")}
JSDOC_OPEN = re.compile(r"^\s*/\*\*")

def docstring_blocks(lines):
    """新規追加テキストから docstring / JSDoc ブロックを (開始行, 行数, 実質行数) で拾う。"""
    blocks, i = [], 0
    while i < len(lines):
        line = lines[i]
        m = DOC_OPEN["#"].match(line) if marker == "#" else None
        if m:
            quote, j, body = m.group(1), i, []
            rest = line[m.end():]
            if quote in rest:
                i += 1
                continue
            j = i + 1
            while j < len(lines) and quote not in lines[j]:
                body.append(lines[j])
                j += 1
            head = rest.strip()
            content = ([head] if head else []) + [b for b in body if b.strip()]
            blocks.append((lines[i], j - i + 1, len(content)))
            i = j + 1
            continue
        if marker == "//" and JSDOC_OPEN.match(line):
            if "*/" in line[2:]:  # 単一行 JSDoc は本文が上限内なので検査不要
                i += 1
                continue
            j, body = i + 1, []
            while j < len(lines) and "*/" not in lines[j]:
                body.append(lines[j])
                j += 1
            content = [b for b in body if b.strip().lstrip("*").strip()]
            blocks.append((lines[i], j - i + 1, len(content)))
            i = j + 1
            continue
        i += 1
    return blocks

MAX_DOC_CONTENT_LINES = 3  # 概要1行 + 理由1〜2行

added, dividers, long_docs = [], [], []
for old, new in edit_pairs(tool_input):
    old_lines = set(old.splitlines())
    new_lines = new.splitlines()
    for line in new_lines:
        if line in old_lines:
            continue
        m = comment_re.match(line)
        if not m:
            continue
        body = m.group("body").strip()
        if not body or directive_re.match(body):
            continue
        (dividers if divider_re.search(body) else added).append(line.strip())
    for opener, total, content in docstring_blocks(new_lines):
        if opener in old_lines or content <= MAX_DOC_CONTENT_LINES:
            continue
        long_docs.append((opener.strip()[:60], total, content))

if dividers:
    print(
        f"コメント規約違反 ({path}):\n"
        + "".join(f"- 区切り線・装飾コメントは禁止: {l}\n" for l in dividers[:5])
        + "見出しが欲しいなら関数分割・命名で構造を示す。基準: skill concise-comments",
        file=sys.stderr,
    )
    sys.exit(2)

parts = []
if added:
    samples = "\n".join(f"  {l}" for l in added[:5])
    more = f"\n  …ほか {len(added) - 5} 行" if len(added) > 5 else ""
    parts.append(
        f"コメント行が追加されました ({len(added)} 行):\n{samples}{more}\n"
        "判断テスト:「このコメントを消したら、コードだけから読み取れない情報が失われるか?」\n"
        "- 失われない（処理の言い換え・自明な説明・思考過程の実況）→ 削除する\n"
        "- 失われる（なぜ・制約・回避策）→ 残してよいが 1 行に圧縮する\n"
        "コメントより先に命名・関数分割で表現できないかも検討。"
    )
if long_docs:
    samples = "\n".join(f"  {o}… ({c} 行の本文)" for o, t, c in long_docs[:3])
    parts.append(
        f"長い docstring が追加されました ({len(long_docs)} 件):\n{samples}\n"
        "上限は「概要 1 行 + 理由 1〜2 行」。型シグネチャの言い換え (Args/Returns)・"
        "実装手順の逐次解説・使用例は削る。処理ステップの理由はその行の行コメントへ。\n"
        "ただし docstring は行コメントと違い「何を」も残す。役割説明まで削らないこと。\n"
        "公開 API・サービス関数の仕様列挙だけは例外だが、1 項目 1 行に収める。"
    )

if parts:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "\n\n".join(parts)
            + "\n基準: skill concise-comments",
        }
    }))

sys.exit(0)
' <<<"$INPUT"
