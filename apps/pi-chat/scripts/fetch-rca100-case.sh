#!/usr/bin/env bash
set -euo pipefail

CASE_ID="${1:-t039}"
DEST_ROOT="${2:-.rca-data/cases}"
SOURCE_REPO="${RCA100_SOURCE_REPO:-https://www.aiops.cn/gitlab/aiops-live-benchmark/agenticopseval.git}"
WORKDIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if ! git lfs version >/dev/null 2>&1; then
  echo "git-lfs is required" >&2
  exit 1
fi

echo "Downloading RCA100/${CASE_ID} agent-facing telemetry..."
GIT_LFS_SKIP_SMUDGE=1 git clone --depth=1 --filter=blob:none "$SOURCE_REPO" "$WORKDIR/agenticopseval"

cd "$WORKDIR/agenticopseval"
git sparse-checkout init --cone
git sparse-checkout set "RCA100/cases/$CASE_ID" RCA100/LICENSE
git checkout
git lfs install --local
git lfs pull --include="RCA100/cases/$CASE_ID/*"

SOURCE_CASE="$WORKDIR/agenticopseval/RCA100/cases/$CASE_ID"
if [[ ! -f "$SOURCE_CASE/task.json" ]]; then
  echo "RCA100 case $CASE_ID was not found" >&2
  exit 1
fi

cd - >/dev/null
mkdir -p "$DEST_ROOT"
rm -rf "$DEST_ROOT/$CASE_ID"
cp -a "$SOURCE_CASE" "$DEST_ROOT/$CASE_ID"
cp "$WORKDIR/agenticopseval/RCA100/LICENSE" "$(dirname "$DEST_ROOT")/RCA100-LICENSE"

echo
echo "Downloaded files:"
find "$DEST_ROOT/$CASE_ID" -maxdepth 1 -type f -printf '%f %s bytes\n' | sort
echo
du -sh "$DEST_ROOT/$CASE_ID"
echo
echo "Ground truth was intentionally NOT downloaded into the agent-facing data directory."
