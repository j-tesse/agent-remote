# agent-remote shell integration (bash).
#
# Loaded via `bash --rcfile`. Source the user's real .bashrc first, then install
# a DEBUG trap (command-start) and a PROMPT_COMMAND hook (command-end + cwd) that
# emit VS Code OSC 633 markers the server parses into session events.
if [ -f ~/.bashrc ]; then
  source ~/.bashrc
fi

if [ -z "$AGENT_REMOTE_SHELL_INTEGRATION" ]; then
  export AGENT_REMOTE_SHELL_INTEGRATION=1

  __agent_remote_osc() { printf '\033]633;%s\007' "$1"; }
  __agent_remote_escape() {
    local s=${1//\\/\\\\}
    s=${s//;/\\x3b}
    s=${s//$'\n'/\\x0a}
    printf '%s' "$s"
  }

  # bash has no native preexec: the DEBUG trap fires before every simple command,
  # including those inside PROMPT_COMMAND and once with a *stale* `history 1` at
  # startup (the top of the just-loaded history file). Two guards handle this:
  #  - `ready` is set on the first prompt hook (by which point history is loaded),
  #    so the startup traps that fire before any prompt are ignored;
  #  - the history index, seeded at that same point, then changes once per command
  #    line the user actually enters, so each is reported exactly once.
  __agent_remote_histnum() {
    local h="${1#"${1%%[![:space:]]*}"}"   # strip leading whitespace
    printf '%s' "${h%% *}"                  # first field is the history index
  }
  __agent_remote_ready=""
  __agent_remote_last_hist=""
  __agent_remote_preexec() {
    [ -z "$__agent_remote_ready" ] && return   # still in startup, before any prompt
    [ -n "$COMP_LINE" ] && return              # tab-completion, not a real command
    local hist num
    hist=$(HISTTIMEFORMAT= history 1)
    num="$(__agent_remote_histnum "$hist")"
    [ "$num" = "$__agent_remote_last_hist" ] && return   # same line / no new command
    __agent_remote_last_hist="$num"
    __agent_remote_osc "E;$(__agent_remote_escape "${hist#*[0-9]  }")"
    __agent_remote_osc "C"
  }
  __agent_remote_precmd() {
    local code=$?
    __agent_remote_osc "D;$code"
    __agent_remote_osc "P;Cwd=$PWD"
    if [ -z "$__agent_remote_ready" ]; then
      __agent_remote_ready="1"
      __agent_remote_last_hist="$(__agent_remote_histnum "$(HISTTIMEFORMAT= history 1)")"
    fi
  }

  # Trailing OSC 633;S marks a *local* sudo password prompt (env doesn't cross
  # ssh); kept last so no visible prompt text follows it. User's prompt kept.
  export SUDO_PROMPT="${SUDO_PROMPT:-[sudo] password for %p: }"$'\033]633;S\007'
  trap '__agent_remote_preexec' DEBUG
  PROMPT_COMMAND="__agent_remote_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  __agent_remote_osc "P;Cwd=$PWD"
fi
