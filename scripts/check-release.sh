#!/bin/sh
# Claude Code PreToolUse hook (Bash): blocks `git push` while commits exist after the latest release tag,
# so a version bump (npm run release) is never forgotten. Exit 2 = block, message goes to Claude.
cmd=$(jq -r '.tool_input.command // ""')
case "$cmd" in
  *"git push"*) ;;
  *) exit 0 ;;
esac
last=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null) || exit 0
if [ -n "$(git rev-list "$last"..HEAD)" ]; then
  echo "Seit $last gibt es Commits ohne neue Version. Zuerst 'npm run release' ausführen (erhöht die CalVer-Version, committet und taggt), dann pushen: git push && git push origin <neuer Tag>." >&2
  exit 2
fi
