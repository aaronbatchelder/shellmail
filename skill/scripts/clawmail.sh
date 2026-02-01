#!/usr/bin/env bash
# ClawMail CLI — lightweight wrapper around the ClawMail REST API
set -euo pipefail

# Config: set via env or openclaw skill config
API_URL="${CLAWMAIL_API_URL:-https://clawmail.ngmaloney.workers.dev}"
TOKEN="${CLAWMAIL_TOKEN:-}"

usage() {
  cat <<EOF
Usage: clawmail <command> [options]

Commands:
  inbox                     List emails (add --unread for unread only)
  read <id>                 Read a specific email
  mark-read <id>            Mark email as read
  mark-unread <id>          Mark email as unread
  archive <id>              Archive an email
  delete <id>               Delete an email
  addresses                 Show current address info
  create <local> <email>    Create a new address (local@clawmail.dev)
  recover <address> <email> Recover token for an address
  delete-address            Delete address and all mail
  health                    Check API health

Environment:
  CLAWMAIL_TOKEN            Bearer token (required for most commands)
  CLAWMAIL_API_URL          API base URL (default: https://clawmail.ngmaloney.workers.dev)
EOF
  exit 1
}

auth_header() {
  if [ -z "$TOKEN" ]; then
    echo "Error: CLAWMAIL_TOKEN not set" >&2
    exit 1
  fi
  echo "Authorization: Bearer $TOKEN"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  inbox)
    UNREAD=""
    LIMIT="50"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --unread) UNREAD="?unread=true"; shift ;;
        --limit) LIMIT="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    curl -sf "$API_URL/api/mail${UNREAD}&limit=${LIMIT}" \
      -H "$(auth_header)" 2>/dev/null || \
    curl -sf "$API_URL/api/mail${UNREAD}${UNREAD:+&}${UNREAD:-?}limit=${LIMIT}" \
      -H "$(auth_header)"
    ;;

  read)
    [ -z "${1:-}" ] && { echo "Usage: clawmail read <id>" >&2; exit 1; }
    curl -sf "$API_URL/api/mail/$1" -H "$(auth_header)"
    ;;

  mark-read)
    [ -z "${1:-}" ] && { echo "Usage: clawmail mark-read <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$1" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_read": true}'
    ;;

  mark-unread)
    [ -z "${1:-}" ] && { echo "Usage: clawmail mark-unread <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$1" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_read": false}'
    ;;

  archive)
    [ -z "${1:-}" ] && { echo "Usage: clawmail archive <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$1" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_archived": true}'
    ;;

  delete)
    [ -z "${1:-}" ] && { echo "Usage: clawmail delete <id>" >&2; exit 1; }
    curl -sf -X DELETE "$API_URL/api/mail/$1" -H "$(auth_header)"
    ;;

  addresses)
    # Show the address associated with the current token by checking inbox
    curl -sf "$API_URL/api/mail?limit=0" -H "$(auth_header)"
    ;;

  create)
    [ -z "${1:-}" ] || [ -z "${2:-}" ] && { echo "Usage: clawmail create <local> <recovery_email>" >&2; exit 1; }
    curl -sf -X POST "$API_URL/api/addresses" \
      -H "Content-Type: application/json" \
      -d "{\"local\": \"$1\", \"recovery_email\": \"$2\"}"
    ;;

  recover)
    [ -z "${1:-}" ] || [ -z "${2:-}" ] && { echo "Usage: clawmail recover <address> <recovery_email>" >&2; exit 1; }
    curl -sf -X POST "$API_URL/api/recover" \
      -H "Content-Type: application/json" \
      -d "{\"address\": \"$1\", \"recovery_email\": \"$2\"}"
    ;;

  delete-address)
    curl -sf -X DELETE "$API_URL/api/addresses/me" -H "$(auth_header)"
    ;;

  health)
    curl -sf "$API_URL/health"
    ;;

  *)
    usage
    ;;
esac
