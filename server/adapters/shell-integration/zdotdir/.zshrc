# agent-remote shell integration (zsh).
#
# ZDOTDIR was hijacked to this directory so this file runs. Hand ZDOTDIR back to
# the user's real config dir (so nested shells and the rest of startup behave),
# load the user's own .zshrc, then layer our command/cwd reporting hooks on top.
ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"

# Install once. Emits VS Code OSC 633 markers the server parses into session
# events (command-start/end + cwd). add-zsh-hook keeps us from clobbering any
# preexec/precmd the user already defined.
if [[ -z "$AGENT_REMOTE_SHELL_INTEGRATION" ]]; then
  autoload -Uz add-zsh-hook
  export AGENT_REMOTE_SHELL_INTEGRATION=1

  __agent_remote_osc() { printf '\033]633;%s\007' "$1"; }
  # Escape backslash, then `;` and newlines, so the command line stays a single
  # OSC 633;E field. The server reverses this exact scheme.
  __agent_remote_escape() {
    local s=${1//\\/\\\\}
    s=${s//;/\\x3b}
    s=${s//$'\n'/\\x0a}
    printf '%s' "$s"
  }
  __agent_remote_preexec() {
    __agent_remote_osc "E;$(__agent_remote_escape "$1")"
    __agent_remote_osc "C"
  }
  __agent_remote_precmd() {
    local code=$?
    __agent_remote_osc "D;$code"
    __agent_remote_osc "P;Cwd=$PWD"
  }
  # Trailing OSC 633;S marks a *local* sudo password prompt (env doesn't cross
  # ssh); kept last so no visible prompt text follows it. User's prompt kept.
  export SUDO_PROMPT="${SUDO_PROMPT:-[sudo] password for %p: }"$'\033]633;S\007'
  add-zsh-hook preexec __agent_remote_preexec
  add-zsh-hook precmd __agent_remote_precmd
  # Report the starting directory immediately so the server doesn't wait for the
  # first command to learn where we are.
  __agent_remote_osc "P;Cwd=$PWD"
fi
