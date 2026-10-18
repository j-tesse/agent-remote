#!/usr/bin/env bash
#
# config-gen.sh — interactive setup dialog that generates config.json.
# agent-remote keeps all configuration in config.json (gitignored); no env vars.

set -euo pipefail

CONFIG_FILE="config.json"

# --- helpers ---------------------------------------------------------------

# ask_yn "Question?" default(y|n) -> echoes "true" or "false"
ask_yn() {
  local prompt="$1" default="$2" reply
  local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
  read -r -p "$prompt $hint " reply || true
  reply="${reply:-$default}"
  case "$reply" in
    [Yy]*) echo "true" ;;
    *)     echo "false" ;;
  esac
}

# ask "Question?" default -> echoes answer (or default if empty)
ask() {
  local prompt="$1" default="$2" reply
  read -r -p "$prompt [$default] " reply || true
  echo "${reply:-$default}"
}

# json_escape <string> -> escapes for embedding in a JSON string
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# --- guard against clobbering ----------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
  overwrite="$(ask_yn "$CONFIG_FILE already exists. Overwrite?" "n")"
  [ "$overwrite" = "true" ] || { echo "Aborted; existing $CONFIG_FILE kept."; exit 0; }
fi

echo "agent-remote setup — writing $CONFIG_FILE"
echo

# --- harnesses -------------------------------------------------------------

CLAUDE_ENABLED="$(ask_yn "Expose Claude Code?" "y")"
CLAUDE_COMMAND="claude"
if [ "$CLAUDE_ENABLED" = "true" ]; then
  CLAUDE_COMMAND="$(ask "  Command to launch Claude Code" "claude")"
fi

PI_ENABLED="$(ask_yn "Expose pi?" "y")"
PI_COMMAND="pi"
if [ "$PI_ENABLED" = "true" ]; then
  PI_COMMAND="$(ask "  Command to launch pi" "pi")"
fi

AIDER_ENABLED="$(ask_yn "Expose Aider?" "n")"
AIDER_COMMAND="aider"
if [ "$AIDER_ENABLED" = "true" ]; then
  AIDER_COMMAND="$(ask "  Command to launch aider" "aider")"
fi

TERMINAL_ENABLED="$(ask_yn "Expose a plain terminal (shell)?" "y")"
TERMINAL_COMMAND="${SHELL:-bash}"
if [ "$TERMINAL_ENABLED" = "true" ]; then
  TERMINAL_COMMAND="$(ask "  Shell to launch for terminal sessions" "${SHELL:-bash}")"
fi

# --- LLM provider ----------------------------------------------------------

echo
echo "Select LLM provider for convenience features:"
echo "  1) llama.cpp"
echo "  2) vLLM"
provider=""
while [ -z "$provider" ]; do
  choice="$(ask "Provider" "1")"
  case "$choice" in
    1|llama.cpp) provider="llama.cpp"; default_url="http://localhost:8080/v1" ;;
    2|vLLM|vllm) provider="vLLM";      default_url="http://localhost:8000/v1" ;;
    *) echo "  Please enter 1 or 2." ;;
  esac
done

LLM_BASE_URL="$(ask "  $provider base URL (OpenAI-compatible)" "$default_url")"
LLM_MODEL="$(ask "  Model name" "")"

# --- auto PR ---------------------------------------------------------------
# The harness session auto-PR starts to draft/open the PR, and what it's told.

echo
AUTOPR_HARNESS="$(ask "Auto-PR: harness that opens the PR (claude|pi|…)" "pi")"
AUTOPR_INSTRUCTIONS="$(ask "  Instructions sent to it (slash command or text)" "/pr")"

# --- users -----------------------------------------------------------------
# Enabled usernames. Accounts are normally created with `npm run add-user`,
# which also adds the name here. Web registration is closed unless opened below
# (and even then an account stays unusable until its name appears here).

echo
USERS_RAW="$(ask "Enabled usernames (comma-separated; npm run add-user also adds them)" "")"
if [ "$(ask_yn "Allow open web registration? (not recommended)" "n")" = "true" ]; then
  REGISTRATION="open"
else
  REGISTRATION="closed"
fi
USERS_JSON=""
IFS=',' read -ra _users <<< "$USERS_RAW"
for u in "${_users[@]}"; do
  u="$(printf '%s' "$u" | sed 's/^ *//;s/ *$//')"  # trim
  [ -z "$u" ] && continue
  [ -n "$USERS_JSON" ] && USERS_JSON="$USERS_JSON, "
  USERS_JSON="$USERS_JSON\"$(json_escape "$u")\""
done

# --- write config.json -----------------------------------------------------

cat > "$CONFIG_FILE" <<EOF
{
  "harnesses": {
    "claude": {
      "enabled": $CLAUDE_ENABLED,
      "command": "$(json_escape "$CLAUDE_COMMAND")"
    },
    "pi": {
      "enabled": $PI_ENABLED,
      "command": "$(json_escape "$PI_COMMAND")"
    },
    "aider": {
      "enabled": $AIDER_ENABLED,
      "command": "$(json_escape "$AIDER_COMMAND")"
    },
    "terminal": {
      "enabled": $TERMINAL_ENABLED,
      "command": "$(json_escape "$TERMINAL_COMMAND")"
    }
  },
  "llm": {
    "provider": "$(json_escape "$provider")",
    "baseUrl": "$(json_escape "$LLM_BASE_URL")",
    "model": "$(json_escape "$LLM_MODEL")"
  },
  "autoPr": {
    "harness": "$(json_escape "$AUTOPR_HARNESS")",
    "instructions": "$(json_escape "$AUTOPR_INSTRUCTIONS")"
  },
  "users": [$USERS_JSON],
  "registration": "$REGISTRATION"
}
EOF

echo
echo "Wrote $CONFIG_FILE."
echo "Create a login with: npm run add-user"
