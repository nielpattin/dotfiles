# Ensure pnpm global binaries are available in fish.
# Managed by chezmoi.

set -gx PNPM_HOME "$HOME/.local/share/pnpm"

if not contains "$PNPM_HOME" $PATH
    set -gx PATH "$PNPM_HOME" $PATH
end
