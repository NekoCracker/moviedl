#!/usr/bin/env bash
# 失敗したときにログの末尾を注釈（annotation）として残す。API からも読めるので原因を追いやすくする
LOG="$1"
LINES="${2:-200}"
[ -f "$LOG" ] || exit 0
tail -n "$LINES" "$LOG" | sed 's/\x1b\[[0-9;]*m//g' | split -l 25 - "/tmp/annot-$(basename "$LOG")-"
for f in "/tmp/annot-$(basename "$LOG")-"*; do
  body=$(sed -e 's/%/%25/g' "$f" | awk '{printf "%s%%0A", $0}')
  echo "::error title=log $(basename "$f")::$body"
done
