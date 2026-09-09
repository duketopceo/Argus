#!/usr/bin/env bash
# register-runner.sh — register a repo-scoped GitHub Actions self-hosted runner
# on a cluster node as a user-level systemd service (no root required).
#
# Usage:
#   register-runner.sh <owner/repo> <name> [--dry-run]
#
# Requires: gh (authenticated, `repo` scope), curl, tar, systemd user session.
# Idempotent-ish: an existing runner dir is reused with --replace on config.
set -euo pipefail

REPO="${1:-}"
NAME="${2:-}"
DRY_RUN=0
[[ "${3:-}" == "--dry-run" ]] && DRY_RUN=1

LABELS="self-hosted,linux,x64,vision-e2e"
RUNNER_VERSION="2.337.0"
RUNNER_DIR="$HOME/actions-runner-$NAME"
SERVICE="actions-runner-$NAME.service"

if [[ -z "$REPO" || -z "$NAME" ]]; then
  echo "usage: register-runner.sh <owner/repo> <name> [--dry-run]" >&2
  exit 2
fi

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

# 1. Registration token via gh (repo scope required).
TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)"

# 2. Download + extract the runner.
run mkdir -p "$RUNNER_DIR"
TARBALL="actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
URL="https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$TARBALL"
run curl -sL -o "$RUNNER_DIR/$TARBALL" "$URL"
run tar -C "$RUNNER_DIR" -xzf "$RUNNER_DIR/$TARBALL"

# 3. Configure (repo-scoped, labels, replace existing).
run "$RUNNER_DIR/config.sh" \
  --url "https://github.com/$REPO" \
  --token "$TOKEN" \
  --name "$NAME" \
  --labels "$LABELS" \
  --work _work \
  --unattended \
  --replace

# 4. User-level systemd unit (svc.sh needs root; this does not).
UNIT_DIR="$HOME/.config/systemd/user"
run mkdir -p "$UNIT_DIR"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "+ write $UNIT_DIR/$SERVICE"
else
  cat > "$UNIT_DIR/$SERVICE" <<EOF
[Unit]
Description=GitHub Actions Runner ($REPO / $NAME)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$RUNNER_DIR/run.sh
WorkingDirectory=$RUNNER_DIR
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
fi

run systemctl --user daemon-reload
run systemctl --user enable --now "$SERVICE"

# 5. Lingering keeps the service alive across logout/reboot.
if [[ $DRY_RUN -eq 0 ]]; then
  if [[ "$(loginctl show-user "$USER" -p Linger 2>/dev/null | cut -d= -f2)" != "yes" ]]; then
    echo "NOTE: lingering is off — run 'sudo loginctl enable-linger $USER' so the runner survives logout." >&2
  fi
fi

echo "Runner '$NAME' registered to $REPO with labels: $LABELS"
