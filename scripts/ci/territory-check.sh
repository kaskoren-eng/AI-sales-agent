#!/usr/bin/env bash
# Territory check — enforces the TERRITORY RULES in CLAUDE.md mechanically.
#
# WHY: four Claude Code sessions work this repo at once. The rules in CLAUDE.md are advisory and
# get lost after context compaction. This script maps the PR branch prefix to a lane and reports
# every changed file that lives in ANOTHER lane's exclusive territory.
#
# Usage: scripts/ci/territory-check.sh <branch-name> <base-ref>
# Exit 0 = clean or branch unmapped; exit 1 = cross-lane edits found (workflow decides if fatal).
set -euo pipefail
BRANCH="${1:?branch}"; BASE="${2:-origin/main}"

lane_of_branch() {
  case "$1" in
    feature/voice-*|feature/meeting-reminders*) echo VOICE ;;
    feature/dashboard-*)                        echo DASHBOARD ;;
    feature/website-*)                          echo WEBSITE ;;
    feature/airtable-*|feature/crm-*)           echo INTEGRATIONS ;;
    *)                                          echo UNMAPPED ;;
  esac
}
# Exclusive territories only. Split-ownership modules (calls/, leads/), shared files and docs are
# NOT listed — they are governed by the "announce first" rule, which a script can't check.
lane_of_path() {
  case "$1" in
    src/modules/channels/voice-livekit/*|src/modules/channels/whatsapp/*|src/queues/workers/meeting-reminders*|src/modules/scheduling/*|docs/phase-4-*|docs/go-live-plan.md) echo VOICE ;;
    dashboard/*|src/modules/admin/*|src/modules/metrics/*|docs/phase-5-dashboard-*|brand_assets/*) echo DASHBOARD ;;
    website/*) echo WEBSITE ;;
    src/modules/integrations/*) echo INTEGRATIONS ;;
    *) echo SHARED ;;
  esac
}

MY_LANE=$(lane_of_branch "$BRANCH")
if [ "$MY_LANE" = UNMAPPED ]; then
  echo "::notice::Branch '$BRANCH' has no lane prefix (feature/voice-*, feature/dashboard-*, feature/website-*, feature/airtable-*|crm-*). Territory check skipped."
  exit 0
fi

MERGE_BASE=$(git merge-base "$BASE" HEAD)
VIOLATIONS=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  L=$(lane_of_path "$f")
  if [ "$L" != SHARED ] && [ "$L" != "$MY_LANE" ]; then
    echo "::error file=$f::$MY_LANE branch edits $L territory: $f (see CLAUDE.md TERRITORY RULES rule 1)"
    VIOLATIONS=$((VIOLATIONS+1))
  fi
done < <(git diff --name-only "$MERGE_BASE"...HEAD)

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "::error::$VIOLATIONS cross-lane file(s) on $MY_LANE branch '$BRANCH'. If intentional, say why in the PR and get Koren's OK."
  exit 1
fi
echo "Territory check OK: $MY_LANE branch touched only its own lane + shared files."
