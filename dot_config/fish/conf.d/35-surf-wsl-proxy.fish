# Route surf commands from WSL fish -> Windows pwsh/surf.exe.
# Managed by chezmoi.

if set -q WSL_DISTRO_NAME
    function surf --description "Run Windows surf.exe via pwsh from WSL"
        set -l proxy_script "$HOME/.config/fish/scripts/surf-proxy.ps1"

        if not test -f "$proxy_script"
            echo "surf proxy script not found: $proxy_script" >&2
            return 1
        end

        pwsh.exe -NoProfile -ExecutionPolicy Bypass -File (wslpath -w "$proxy_script") $argv
    end
end
