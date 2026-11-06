#!/usr/bin/env bash
# 1 モデルぶんの比較測定を順に流す。起動済みで他の作業が使っていないこと。
# 使い方: battery.sh <出力フォルダ> <提供名> <Spark Lens の llm id> [BASE（既定 http://pgx-head:8888/v1）]
# 所要は速いモデルで約 20 分、思考の長いモデルで 1 時間を超える。途中で止まっても、同じ出力フォルダで再実行すれば済んだ段階は飛ばす。
set -u
OUT=$1; MODEL=$2; LLM=$3; BASE=${4:-http://pgx-head:8888/v1}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel)
mkdir -p "$OUT"
py() { python3 -I "$HERE/$@"; }
step() { local name=$1; shift; [ -e "$OUT/$name.done" ] || { "$@"; touch "$OUT/$name.done"; }; }
s_bench() { (cd "$REPO" && pnpm bench "$LLM") > "$OUT/bench.json" 2>/dev/null; }
s_conc()  { py conc.py "$BASE" "$MODEL" 1,2,4 > "$OUT/conc.json" 2>/dev/null; }
s_long()  { py long.py "$BASE" "$MODEL" 32000,128000 > "$OUT/long.json" 2>/dev/null; }
s_resp()  { py resp_check.py "$BASE" "$MODEL" low > "$OUT/resp.txt" 2>&1; }
s_ja()    { py ja_eval.py "$BASE" "$MODEL" "$OUT/ja.json" > "$OUT/ja.summary" 2>/dev/null; }
s_jar()   { OUT="$OUT/ja-repeat-answers.json" py ja_repeat.py "$BASE" "$MODEL" 8 > "$OUT/ja-repeat.json" 2>/dev/null; }
s_q()     { EFFORT=$1 py qset.py "$BASE" "$MODEL" 4 > "$OUT/qset-$1.json" 2> "$OUT/qset-$1.err"; }
s_c()     { EFFORT=$2 py code_eval.py "$BASE" "$MODEL" 4 "$1" > "$OUT/code-$1-$2.json" 2> "$OUT/code-$1-$2.err"; }
step bench s_bench; step conc s_conc; step long s_long; step resp s_resp; step ja s_ja; step jar s_jar
for e in low high; do step "qset-$e" s_q "$e"; done
for w in basic hard; do for e in low high; do step "code-$w-$e" s_c "$w" "$e"; done; done
echo done > "$OUT/ALL.done"
