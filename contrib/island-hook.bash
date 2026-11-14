# Go Island bash hook: pops the island when a long command finishes.
# Add to ~/.bashrc:   source /path/to/go-island/contrib/island-hook.bash
# Tune with ISLAND_MIN_SECS (default 15). Ignored commands: ISLAND_IGNORE regex.

ISLAND_MIN_SECS=${ISLAND_MIN_SECS:-15}
ISLAND_IGNORE=${ISLAND_IGNORE:-'^(vim?|nvim|nano|less|more|man|ssh|top|htop|btop|tmux|screen|watch|fg|claude|git (log|diff)) ?'}
__island_ready=1

__island_preexec() {
  [[ $__island_ready == 1 ]] || return
  __island_ready=0
  __island_start=$SECONDS
  __island_cmd=$BASH_COMMAND
}

__island_precmd() {
  local status=$__island_status
  if [[ -n $__island_start ]]; then
    local took=$((SECONDS - __island_start))
    if (( took >= ISLAND_MIN_SECS )) && ! [[ $__island_cmd =~ $ISLAND_IGNORE ]]; then
      local dur="${took}s"; (( took >= 60 )) && dur="$((took / 60))m$((took % 60))s"
      if (( status == 0 )); then
        island notify -a ok -i emblem-ok-symbolic "$__island_cmd" "Done in $dur" &>/dev/null &
      else
        island notify -a error -i dialog-error-symbolic -t 10000 "$__island_cmd" "Failed (exit $status) after $dur" &>/dev/null &
      fi
      disown 2>/dev/null
    fi
  fi
  unset __island_start
  __island_ready=1
}

trap '__island_preexec' DEBUG
PROMPT_COMMAND="__island_status=\$?${PROMPT_COMMAND:+;$PROMPT_COMMAND};__island_precmd"
