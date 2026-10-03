# Clean shell for the README casts (plan R27). Sourced, hidden, at the start
# of every tape in assets/demo/. No history, no notifications, a fixed prompt.
unset HISTFILE PROMPT_COMMAND OPENROUTER_API_KEY
set +o history
export NO_UPDATE_NOTIFIER=1 NPM_CONFIG_UPDATE_NOTIFIER=false
PS1='\[\e[34m\]$\[\e[0m\] '
