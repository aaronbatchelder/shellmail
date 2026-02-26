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

# URL-encode a string for safe use in query parameters (no shell interpolation)
urlencode() {
  printf '%s' "$1" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=''))" 2>/dev/null || \
  printf '%s' "$1" | od -An -tx1 | tr ' ' '\n' | grep . | while read hex; do printf "%%%s" "$hex"; done | sed 's/%0a$//; s/%2d/-/g; s/%2e/./g; s/%5f/_/g; s/%7e/~/g; s/%30/0/g; s/%31/1/g; s/%32/2/g; s/%33/3/g; s/%34/4/g; s/%35/5/g; s/%36/6/g; s/%37/7/g; s/%38/8/g; s/%39/9/g; s/%41/A/g; s/%42/B/g; s/%43/C/g; s/%44/D/g; s/%45/E/g; s/%46/F/g; s/%47/G/g; s/%48/H/g; s/%49/I/g; s/%4a/J/g; s/%4b/K/g; s/%4c/L/g; s/%4d/M/g; s/%4e/N/g; s/%4f/O/g; s/%50/P/g; s/%51/Q/g; s/%52/R/g; s/%53/S/g; s/%54/T/g; s/%55/U/g; s/%56/V/g; s/%57/W/g; s/%58/X/g; s/%59/Y/g; s/%5a/Z/g; s/%61/a/g; s/%62/b/g; s/%63/c/g; s/%64/d/g; s/%65/e/g; s/%66/f/g; s/%67/g/g; s/%68/h/g; s/%69/i/g; s/%6a/j/g; s/%6b/k/g; s/%6c/l/g; s/%6d/m/g; s/%6e/n/g; s/%6f/o/g; s/%70/p/g; s/%71/q/g; s/%72/r/g; s/%73/s/g; s/%74/t/g; s/%75/u/g; s/%76/v/g; s/%77/w/g; s/%78/x/g; s/%79/y/g; s/%7a/z/g'
}

# Escape a string for safe JSON embedding (via stdin to avoid interpolation)
json_escape() {
  printf '%s' "$1" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read())[1:-1], end='')" 2>/dev/null || \
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g; s/\r/\\r/g' | tr -d '\n'
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
    curl -sf "$API_URL/api/mail/$(urlencode "$1")" -H "$(auth_header)"
    ;;

  otp)
    PARAMS=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --wait) PARAMS="${PARAMS}&timeout=$((${2}*1000))"; shift 2 ;;
        --from) PARAMS="${PARAMS}&from=$(urlencode "$2")"; shift 2 ;;
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
        --query|-q) PARAMS="${PARAMS}&q=$(urlencode "$2")"; shift 2 ;;
        --from|-f) PARAMS="${PARAMS}&from=$(urlencode "$2")"; shift 2 ;;
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
    curl -sf -X PATCH "$API_URL/api/mail/$(urlencode "$1")" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_read": true}'
    ;;

  mark-unread)
    [ -z "${1:-}" ] && { echo "Usage: shellmail mark-unread <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$(urlencode "$1")" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_read": false}'
    ;;

  archive)
    [ -z "${1:-}" ] && { echo "Usage: shellmail archive <id>" >&2; exit 1; }
    curl -sf -X PATCH "$API_URL/api/mail/$(urlencode "$1")" \
      -H "$(auth_header)" \
      -H "Content-Type: application/json" \
      -d '{"is_archived": true}'
    ;;

  delete)
    [ -z "${1:-}" ] && { echo "Usage: shellmail delete <id>" >&2; exit 1; }
    curl -sf -X DELETE "$API_URL/api/mail/$(urlencode "$1")" -H "$(auth_header)"
    ;;

  addresses)
    # Show the address associated with the current token by checking inbox
    curl -sf "$API_URL/api/mail?limit=0" -H "$(auth_header)"
    ;;

  create)
    [ -z "${1:-}" ] || [ -z "${2:-}" ] && { echo "Usage: shellmail create <local> <recovery_email>" >&2; exit 1; }
    # Build JSON safely using jq if available, otherwise python
    if command -v jq >/dev/null 2>&1; then
      json=$(jq -n --arg local "$1" --arg email "$2" '{local: $local, recovery_email: $email}')
    else
      json=$(python3 -c "import sys, json; print(json.dumps({'local': sys.argv[1], 'recovery_email': sys.argv[2]}))" "$1" "$2")
    fi
    printf '%s' "$json" | curl -sf -X POST "$API_URL/api/addresses" \
      -H "Content-Type: application/json" \
      -d @-
    ;;

  recover)
    [ -z "${1:-}" ] || [ -z "${2:-}" ] && { echo "Usage: shellmail recover <address> <recovery_email>" >&2; exit 1; }
    # Build JSON safely using jq if available, otherwise python
    if command -v jq >/dev/null 2>&1; then
      json=$(jq -n --arg addr "$1" --arg email "$2" '{address: $addr, recovery_email: $email}')
    else
      json=$(python3 -c "import sys, json; print(json.dumps({'address': sys.argv[1], 'recovery_email': sys.argv[2]}))" "$1" "$2")
    fi
    printf '%s' "$json" | curl -sf -X POST "$API_URL/api/recover" \
      -H "Content-Type: application/json" \
      -d @-
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
