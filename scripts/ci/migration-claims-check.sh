#!/usr/bin/env bash
# Migration-claims check — every migration file must be listed in CLAUDE.md's claims table, and
# "next free" must be higher than every existing migration number.
#
# WHY: numbers are claimed in CLAUDE.md BEFORE generating so two sessions never produce the same
# 00NN. That only works if the table is actually kept current — this makes forgetting it a red check.
set -euo pipefail
DIR=src/db/migrations
CLAIMS_LINE=$(grep -m1 '^\*\*Migration number claims:\*\*' CLAUDE.md || true)
[ -z "$CLAIMS_LINE" ] && { echo "::error::CLAUDE.md has no 'Migration number claims' line"; exit 1; }

FAIL=0; MAX=-1
for f in "$DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
  n=$(basename "$f" | cut -c1-4); n10=$((10#$n))
  [ "$n10" -gt "$MAX" ] && MAX=$n10
  # A migration is "claimed" if its number appears in the claims line, alone or inside a range.
  claimed=0
  if grep -qE "(^|[^0-9])$n([^0-9]|$)" <<<"$CLAIMS_LINE"; then claimed=1; fi
  if [ $claimed = 0 ]; then
    while read -r a b; do
      if [ "$n10" -ge $((10#$a)) ] && [ "$n10" -le $((10#$b)) ]; then claimed=1; fi
    done < <(grep -oE '[0-9]{4}–[0-9]{4}' <<<"$CLAIMS_LINE" | tr '–' ' ')
  fi
  if [ $claimed = 0 ]; then
    echo "::error file=$f::migration $n is not in CLAUDE.md's migration claims table"; FAIL=1
  fi
done

NEXT=$(grep -oE 'next free: [0-9]{4}' <<<"$CLAIMS_LINE" | grep -oE '[0-9]{4}' || echo "")
if [ -z "$NEXT" ]; then
  echo "::error::CLAUDE.md claims line has no 'next free: 00NN'"; FAIL=1
elif [ $((10#$NEXT)) -le "$MAX" ]; then
  echo "::error::CLAUDE.md says 'next free: $NEXT' but migration $(printf %04d $MAX) already exists"; FAIL=1
fi
[ $FAIL = 0 ] && echo "Migration claims OK (highest = $(printf %04d $MAX), next free = $NEXT)"
exit $FAIL
