# Use eza as a prettier ls replacement when available.
# Managed by chezmoi.

if type -q eza
    alias ls "eza --group-directories-first --icons=auto"
    alias la "eza -la --group-directories-first --icons=auto"
    alias ll "eza -lah --git --group-directories-first --icons=auto"
    alias lt "eza --tree --level=2 --group-directories-first --icons=auto"
end
