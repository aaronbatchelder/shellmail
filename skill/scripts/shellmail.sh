#!/usr/bin/env bash
# ShellMail CLI — lightweight wrapper around the ShellMail REST API
set -euo pipefail

# Config: set via env or openclaw skill config
API_URL="${SHELLMAIL_API_URL:-https://shellmail.ai}"
TOKEN="${SHELLMAIL_TOKEN:-}"

usage() {
  cat <<EOF
Usage: shellmail <command> [options]

Commands:
  inbox                     List emails (--unread for unread only)
  read <id>                 Read a specific email
  otp                       Get latest OTP code (--wait 30 to wait, --from domain)
  search                    Search emails (--query text, --from domain, --otp)
  mark-read <id>            Mark email as read
  mark-unread <id>          Mark email as unread
  archive <id>              Archive an email
  delete <id>               Delete an email
  addresses                 Show current address info
  create <local> <email>    Create a new address (local@shellmail.ai)
  recover <address> <email> Recover token for an address
  delete-address            Delete address and all mail
  health                    Check API health

Environment:
  SHELLMAIL_TOKEN           Bearer token (required for most commands)
  SHELLMAIL_API_URL         API base URL (default: https://shellmail.ai)
EOF
  exit 1
}

auth_header() {
  if [ -z "$TOKEN" ]; then
    echo "Error: SHELLMAIL_TOKEN not set" >&2
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
    [ -z "${1:-}" ] && { echo "Usage: shellmail read <id>" >&2; exit 1; }
    curl -sf "$API_URL/api/mail/$1" -H "$(auth_header)"
    ;;

  otp)
    PARAMS=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --wait) PARAMS="${PARAMS}&timeout=$((${2}*1000))"; shift 2 ;;
        --from) PARAMS="${PARAMS}&from=$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    PARAMS="${PARAMS#&}"
    curl -sf "$API_URL/api/mail/otp${PARAMS:+?$PARAMS}" -H "$(auth_header)"
    ;;

  search)
    PARAMS=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --query|-q) PARAMS="${PARAMS}&q=$2"; shift 2 ;;
        --from|-f) PARAMS="${PARAMS}&from=$2"; shift 2 ;;
        --otp) PARAMS="${PARAMS}&has_otp=true"; shift ;;
        --limit|-n) PARAMS="${PARAMS}&limit=$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    PARAMS="${PARAMS#&}"
    curl -sf "$API_URL/api/mail/search${PARAMS:+?$PARAMS}" -H "$(auth_header)"
    ;;

  mark-read)
    [ -z "${1:-}" ] && { echo "Usage: shellmail mark-read <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$1" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_read": true}'
    ;;

  mark-unread)
    [ -z "${1:-}" ] && { echo "Usage: shellmail mark-unread <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$1" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_read": false}'
    ;;

  archive)
    [ -z "${1:-}" ] && { echo "Usage: shellmail archive <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$1" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_archived": true}'
    ;;

  delete)
    [ -z "${1:-}" ] && { echo "Usage: shellmail delete <id>" >&2; exit 1; }
    curl -sf -X DELETE "$API_URL/api/mail/$1" -H "$(auth_header)"
    ;;

  addresses)
    # Show the address associated with the current token by checking inbox
    curl -sf "$API_URL/api/mail?limit=0" -H "$(auth_header)"
    ;;

  create)
    [ -z "${1:-}" ] || [ -z "${2:-}" ] && { echo "Usage: shellmail create <local> <recovery_email>" >&2; exit 1; }
    curl -sf -X POST "$API_URL/api/addresses" \
      -H "Content-Type: application/json" \
      -d "{\"local\": \"$1\", \"recovery_email\": \"$2\"}"
    ;;

  recover)
    [ -z "${1:-}" ] || [ -z "${2:-}" ] && { echo "Usage: shellmail recover <address> <recovery_email>" >&2; exit 1; }
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
