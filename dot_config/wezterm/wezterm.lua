local wezterm = require 'wezterm'

-- Use config_builder when available (better validation/errors, especially on nightly)
local config = {}
if wezterm.config_builder then
  config = wezterm.config_builder()
  config:set_strict_mode(true)
end

-- Match Windows Terminal behavior: start in modern PowerShell
config.default_prog = { 'pwsh.exe', '-NoLogo' }

-- Keep all detected WSL distros available as domains (nightly-safe API)
config.wsl_domains = wezterm.default_wsl_domains()

-- Friendly launcher entries: PowerShell + each WSL distro
local launch_menu = {
  {
    label = 'PowerShell (pwsh)',
    args = { 'pwsh.exe', '-NoLogo' },
  },
  {
    label = 'Command Prompt (cmd)',
    args = { 'cmd.exe' },
  },
}

for _, dom in ipairs(config.wsl_domains) do
  table.insert(launch_menu, {
    label = 'WSL: ' .. dom.distribution,
    args = { 'wsl.exe', '-d', dom.distribution },
  })
end

config.launch_menu = launch_menu

-- User-friendly defaults
config.color_scheme = 'Catppuccin Macchiato'
local base_font = wezterm.font_with_fallback({
  { family = 'JetBrainsMono Nerd Font', weight = 'Regular', style = 'Normal' },
  { family = 'Segoe UI Emoji', weight = 'Regular', style = 'Normal' },
  { family = 'Segoe UI Symbol', weight = 'Regular', style = 'Normal' },
})
local italic_font = wezterm.font_with_fallback({
  { family = 'JetBrainsMono Nerd Font', weight = 'Regular', style = 'Italic' },
  { family = 'Segoe UI Emoji', weight = 'Regular', style = 'Normal' },
  { family = 'Segoe UI Symbol', weight = 'Regular', style = 'Normal' },
})
local bold_font = wezterm.font_with_fallback({
  { family = 'JetBrainsMono Nerd Font', weight = 'DemiBold', style = 'Normal' },
  { family = 'Segoe UI Emoji', weight = 'Regular', style = 'Normal' },
  { family = 'Segoe UI Symbol', weight = 'Regular', style = 'Normal' },
})
local bold_italic_font = wezterm.font_with_fallback({
  { family = 'JetBrainsMono Nerd Font', weight = 'DemiBold', style = 'Italic' },
  { family = 'Segoe UI Emoji', weight = 'Regular', style = 'Normal' },
  { family = 'Segoe UI Symbol', weight = 'Regular', style = 'Normal' },
})
config.font = base_font
config.font_size = 10
-- Explicit style mapping: regular, italic, bold, and bold-italic.
config.font_rules = {
  { intensity = 'Half', italic = false, font = base_font },
  { intensity = 'Half', italic = true, font = italic_font },
  { intensity = 'Normal', italic = false, font = base_font },
  { intensity = 'Normal', italic = true, font = italic_font },
  { intensity = 'Bold', italic = false, font = bold_font },
  { intensity = 'Bold', italic = true, font = bold_italic_font },
}
config.front_end = 'WebGpu'
config.default_cwd = wezterm.home_dir
config.scrollback_lines = 50000
config.enable_scroll_bar = true
config.tab_bar_at_bottom = false
config.use_fancy_tab_bar = false
config.hide_tab_bar_if_only_one_tab = false
config.adjust_window_size_when_changing_font_size = true
config.custom_block_glyphs = false
config.window_padding = {
  left = 8,
  right = 8,
  top = 6,
  bottom = 6,
}

-- Softer tab bar colors tuned for Catppuccin Mocha
config.colors = {
  tab_bar = {
    background = '#181825',
    active_tab = {
      bg_color = '#313244',
      fg_color = '#cdd6f4',
      intensity = 'Bold',
    },
    inactive_tab = {
      bg_color = '#1e1e2e',
      fg_color = '#9399b2',
    },
    inactive_tab_hover = {
      bg_color = '#313244',
      fg_color = '#cdd6f4',
      italic = true,
    },
    new_tab = {
      bg_color = '#181825',
      fg_color = '#9399b2',
    },
    new_tab_hover = {
      bg_color = '#313244',
      fg_color = '#cdd6f4',
      italic = true,
    },
  },
}

-- Quick launcher shortcut for tabs/domains/menu items
config.keys = {
  {
    key = 'P',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ShowLauncherArgs {
      flags = 'FUZZY|TABS|DOMAINS|LAUNCH_MENU_ITEMS|COMMANDS',
      title = 'WezTerm Launcher',
    },
  },
  {
    key = 'D',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SplitPane {
      direction = 'Right',
      size = { Percent = 50 },
    },
  },
  {
    key = 'E',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.SplitPane {
      direction = 'Down',
      size = { Percent = 50 },
    },
  },
  {
    key = 'LeftArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Left',
  },
  {
    key = 'RightArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Right',
  },
  {
    key = 'UpArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Up',
  },
  {
    key = 'DownArrow',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.ActivatePaneDirection 'Down',
  },
  {
    key = 'Q',
    mods = 'CTRL|SHIFT',
    action = wezterm.action.CloseCurrentPane { confirm = true },
  },
}

return config
