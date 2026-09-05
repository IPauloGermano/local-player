#!/usr/bin/env bash
# ==============================================================================
# Local Player Launcher (Segundo plano e gerenciamento opcional de atalhos)
# ==============================================================================

# Se node não estiver no PATH da sessão gráfica, resolve via NVM ou caminhos conhecidos
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" --no-use 2>/dev/null || true
  NODE_CANDIDATE=$(find "$HOME/.nvm/versions/node" -maxdepth 2 -name node -type f 2>/dev/null | sort -V | tail -n 1)
  if [ -n "$NODE_CANDIDATE" ] && [ -x "$NODE_CANDIDATE" ]; then
    export PATH="$(dirname "$NODE_CANDIDATE"):$PATH"
  elif [ -x "/usr/bin/node" ]; then
    export PATH="/usr/bin:$PATH"
  fi
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# ------------------------------------------------------------------------------
# Funções de Atalho (executadas SOMENTE quando explicitamente solicitadas)
# ------------------------------------------------------------------------------
get_desktop_dir() {
  local dir=""
  if command -v xdg-user-dir >/dev/null 2>&1; then
    dir="$(xdg-user-dir DESKTOP 2>/dev/null)"
  fi
  [ -z "$dir" ] && dir="$HOME/Desktop"
  [ ! -d "$dir" ] && [ -d "$HOME/Área de trabalho" ] && dir="$HOME/Área de trabalho"
  echo "$dir"
}

install_shortcuts() {
  local desktop_dir="$(get_desktop_dir)"
  local apps_dir="$HOME/.local/share/applications"
  local hicolor_dir="$HOME/.local/share/icons/hicolor"
  mkdir -p "$apps_dir" 2>/dev/null || true

  # Instala ícones nas pastas do tema hicolor
  for size in 16 24 32 48 64 128 256 512; do
    mkdir -p "$hicolor_dir/${size}x${size}/apps" 2>/dev/null || true
    if [ -f "$APP_DIR/assets/local-player.png" ]; then
      cp -f "$APP_DIR/assets/local-player.png" "$hicolor_dir/${size}x${size}/apps/localplayer.png" 2>/dev/null || true
    fi
  done
  mkdir -p "$hicolor_dir/scalable/apps" 2>/dev/null || true
  if [ -f "$APP_DIR/assets/icon.svg" ]; then
    cp -f "$APP_DIR/assets/icon.svg" "$hicolor_dir/scalable/apps/localplayer.svg" 2>/dev/null || true
  fi
  gtk-update-icon-cache -f -t "$hicolor_dir" 2>/dev/null || true

  local launcher_path="$APP_DIR/local-player.sh"
  local desktop_content="[Desktop Entry]
Version=1.0
Type=Application
Name=Local Player
GenericName=Player de Mídia e Cursos
Comment=Player local/offline de cursos e mídia com suporte a legendas IA
Exec=\"$launcher_path\"
Icon=localplayer
Terminal=false
StartupNotify=true
Categories=AudioVideo;Player;Video;Education;
Keywords=video;player;curso;aula;offline;local;"

  # Menu de aplicativos
  rm -f "$apps_dir/local-player.desktop" 2>/dev/null || true
  echo "$desktop_content" > "$apps_dir/localplayer.desktop"
  chmod +x "$apps_dir/localplayer.desktop" 2>/dev/null || true
  update-desktop-database "$apps_dir" 2>/dev/null || true

  # Área de Trabalho
  if [ -d "$desktop_dir" ]; then
    echo "$desktop_content" > "$desktop_dir/Local Player.desktop"
    chmod +x "$desktop_dir/Local Player.desktop" 2>/dev/null || true
    if command -v gio >/dev/null 2>&1; then
      gio set "$desktop_dir/Local Player.desktop" metadata::trusted true 2>/dev/null || true
    fi
    echo "✔ Atalho criado na Área de Trabalho ($desktop_dir) e no Menu de Aplicativos!"
  else
    echo "✔ Atalho criado no Menu de Aplicativos!"
  fi
}

uninstall_shortcuts() {
  local desktop_dir="$(get_desktop_dir)"
  local apps_dir="$HOME/.local/share/applications"
  local hicolor_dir="$HOME/.local/share/icons/hicolor"

  rm -f "$apps_dir/localplayer.desktop" "$apps_dir/local-player.desktop" 2>/dev/null || true
  if [ -d "$desktop_dir" ]; then
    rm -f "$desktop_dir/Local Player.desktop" 2>/dev/null || true
  fi

  for size in 16 24 32 48 64 128 256 512; do
    rm -f "$hicolor_dir/${size}x${size}/apps/localplayer.png" "$hicolor_dir/${size}x${size}/apps/local-player.png" 2>/dev/null || true
  done
  rm -f "$hicolor_dir/scalable/apps/localplayer.svg" "$hicolor_dir/scalable/apps/local-player.svg" 2>/dev/null || true

  gtk-update-icon-cache -f -t "$hicolor_dir" 2>/dev/null || true
  update-desktop-database "$apps_dir" 2>/dev/null || true
  rm -rf ~/.cache/thumbnails/* 2>/dev/null || true
  echo "✔ Atalhos e ícones do sistema removidos com sucesso."
}

# Tratamento de flags manuais de atalho
case "$1" in
  --install-shortcut|-i)
    install_shortcuts
    exit 0
    ;;
  --uninstall-shortcut|-u)
    uninstall_shortcuts
    exit 0
    ;;
esac

# ------------------------------------------------------------------------------
# Execução normal do Player (NÃO cria atalhos automaticamente)
# ------------------------------------------------------------------------------
PORT="${PORT:-4173}"
HOST="${HOST:-127.0.0.1}"
TARGET_URL="http://${HOST}:${PORT}/"

# Se o servidor já estiver rodando, apenas abre o navegador e sai
if curl -s --max-time 1 "$TARGET_URL" >/dev/null 2>&1; then
  xdg-open "$TARGET_URL" >/dev/null 2>&1 &
  exit 0
fi

# Garante a pasta de dados e inicia em segundo plano com nova sessão
mkdir -p "$APP_DIR/data"
if command -v setsid >/dev/null 2>&1; then
  setsid -f node server.js >> "$APP_DIR/data/local-player.log" 2>&1
else
  nohup node server.js >> "$APP_DIR/data/local-player.log" 2>&1 &
  disown
fi
sleep 0.5
