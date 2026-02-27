# Ensure mise is available in fish shells.
# Managed by chezmoi.

if not contains "$HOME/.local/bin" $PATH
    set -gx PATH "$HOME/.local/bin" $PATH
end

if test -x "$HOME/.local/bin/mise"
    "$HOME/.local/bin/mise" activate fish | source
end
