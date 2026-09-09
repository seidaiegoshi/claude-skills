#!/usr/bin/env bash
# comment-policy-check.sh の回帰テスト。フックを編集したら必ず実行する。
set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/comment-policy-check.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 委譲テスト用に、自前フックを持つ架空プロジェクトを作る。
mkdir -p "$TMP/fakeproj/.claude/hooks" "$TMP/fakeproj/src"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/fakeproj/.claude/hooks/comment-policy-check.sh"

python3 - "$TMP" <<'PYEOF'
import json, os, sys
out = sys.argv[1]
home = os.path.expanduser("~")
cases = {
    "01_divider": ("Edit", {
        "file_path": f"{home}/tmp/proj/app/service.py",
        "old_string": "def f():\n    pass\n",
        "new_string": "# ===== 集計処理 =====\ndef f():\n    pass\n"}),
    "02_plain_comment": ("Edit", {
        "file_path": f"{home}/tmp/proj/src/util.ts",
        "old_string": "const total = a + b;\n",
        "new_string": "// 合計に税額を足す\nconst total = a + b;\n"}),
    "03_long_docstring": ("Write", {
        "file_path": f"{home}/tmp/proj/app/orders.py",
        "content": 'def consume(o, q):\n    """在庫を引く。\n\n    Args:\n        o: 注文\n        q: 数量\n    Returns:\n        None\n    """\n    pass\n'}),
    "04_directives": ("Edit", {
        "file_path": f"{home}/tmp/proj/src/api.ts",
        "old_string": "const x = y;\n", "new_string": "// @ts-ignore\nconst x = y;\n"}),
    "05_non_target_ext": ("Write", {
        "file_path": f"{home}/tmp/proj/README.md", "content": "# ===== 見出し =====\n本文\n"}),
    "06_project_hook_wins": ("Edit", {
        "file_path": os.path.join(out, "fakeproj/src/x.py"),
        "old_string": "pass\n", "new_string": "# ===== 区切り =====\npass\n"}),
    "07_short_docstring_ok": ("Write", {
        "file_path": f"{home}/tmp/proj/app/ok.py",
        "content": 'def consume(o, q):\n    """注文の工程投入で在庫を引く。\n\n    在庫不足でも完了はブロックせず、不足分を adjustment で補填してから引く。\n    """\n    pass\n'}),
    "08_multiedit": ("MultiEdit", {
        "file_path": f"{home}/tmp/proj/app/svc.go",
        "edits": [{"old_string": "x := 1\n", "new_string": "// x を 1 にする\nx := 1\n"}]}),
    "09_shebang_only": ("Write", {
        "file_path": f"{home}/tmp/proj/scripts/run.sh",
        "content": "#!/usr/bin/env bash\nset -eu\necho ok\n"}),
    "10_single_line_jsdoc": ("Write", {
        "file_path": f"{home}/tmp/proj/src/user.ts",
        "content": "/** 取引先スナップショットを組み立てる。 */\nexport function build(p: P): S {\n  const a = p.a;\n  const b = p.b;\n  const c = p.c;\n  return { a, b, c };\n}\n"}),
    "11_multiline_jsdoc_long": ("Write", {
        "file_path": f"{home}/tmp/proj/src/calc.ts",
        "content": "/**\n * 合計を計算する。\n * @param items 明細\n * @param rate 税率\n * @returns 合計金額\n */\nexport function total(i: I[], r: number) {\n  return 0;\n}\n"}),
}
for name, (tool, ti) in cases.items():
    with open(os.path.join(out, f"{name}.json"), "w") as fh:
        json.dump({"tool_name": tool, "tool_input": ti}, fh, ensure_ascii=False)
PYEOF

pass=0; fail=0
run() {
  out=$(bash "$HOOK" < "$TMP/$1.json" 2>&1); code=$?
  case "$3" in
    none)  got=$([ -z "$out" ] && echo none || echo context) ;;
    block) got=$([ "$code" = "2" ] && echo block || echo other) ;;
    *)     got=$(printf '%s' "$out" | grep -q additionalContext && echo context || echo none) ;;
  esac
  if [ "$code" = "$2" ] && [ "$got" = "$3" ]; then
    printf 'PASS  %-26s exit=%s %s\n' "$1" "$code" "$got"; pass=$((pass+1))
  else
    printf 'FAIL  %-26s exit=%s (期待%s) %s (期待%s)\n' "$1" "$code" "$2" "$got" "$3"; fail=$((fail+1))
  fi
}
run 01_divider               2 block
run 02_plain_comment         0 context
run 03_long_docstring        0 context
run 04_directives            0 none
run 05_non_target_ext        0 none
run 06_project_hook_wins     0 none
run 07_short_docstring_ok    0 none
run 08_multiedit             0 context
run 09_shebang_only          0 none
run 10_single_line_jsdoc     0 none
run 11_multiline_jsdoc_long  0 context
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
