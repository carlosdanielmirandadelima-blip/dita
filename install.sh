#!/usr/bin/env bash
#
# Dita — instalador para Linux
#
# Instala o Dita com o Whisper rodando LOCALMENTE na sua máquina
# (nenhum áudio sai do computador). O Azure é opcional.
#
# Uso:
#   chmod +x install.sh
#   ./install.sh
#
set -euo pipefail

APP_DIR="${DITA_HOME:-$HOME/.local/share/dita}"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/dita"
CONFIG_FILE="$CONFIG_DIR/azure.env"
MODEL_DIR="$APP_DIR/models"
SYSTEMD_DIR="$HOME/.config/systemd/user"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${BLUE}==>${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*" >&2; exit 1; }

cat <<'BANNER'
  ____  _ _
 |  _ \(_) |_ __ _
 | | | | | __/ _` |
 | |_| | | || (_| |
 |____/|_|\__\__,_|
 Dita · transcrição de voz local
BANNER
echo

# ------------------------------------------------------------------ checagens
info "Verificando o sistema"
command -v node >/dev/null 2>&1 || fail "Node.js não encontrado (instale nodejs 20+ e rode de novo)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js 18+ é necessário (encontrado $(node -v))."
ok "Node.js $(node -v)"

command -v npm >/dev/null 2>&1 || fail "npm não encontrado."

if command -v apk >/dev/null 2>&1; then PKG_INSTALL="apk add --no-cache"
elif command -v apt-get >/dev/null 2>&1; then PKG_INSTALL="apt-get install -y"
elif command -v dnf >/dev/null 2>&1; then PKG_INSTALL="dnf install -y"
else PKG_INSTALL=""; fi

is_wayland() {
  [ "${XDG_SESSION_TYPE:-}" = "wayland" ] || [ -n "${WAYLAND_DISPLAY:-}" ]
}

# ------------------------------------------------------------------ dependências do sistema
info "Verificando dependências de áudio e de digitação"
MISSING=()

# gravação
if ! command -v pw-record >/dev/null 2>&1 && ! command -v arecord >/dev/null 2>&1; then
  MISSING+=("pipewire-bin|alsa-utils")
fi
# copiar para a área de transferência
command -v wl-copy >/dev/null 2>&1 || MISSING+=("wl-clipboard")
# digitar no aplicativo ativo
if is_wayland; then
  command -v ydotool >/dev/null 2>&1 || MISSING+=("ydotool")
else
  command -v xdotool >/dev/null 2>&1 || MISSING+=("xdotool")
  command -v xclip >/dev/null 2>&1 || MISSING+=("xclip")
fi
command -v notify-send >/dev/null 2>&1 || MISSING+=("libnotify-bin")
# compilar o whisper.cpp
command -v cmake >/dev/null 2>&1 || MISSING+=("cmake")
command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1 || MISSING+=("build-essential")
command -v curl >/dev/null 2>&1 || MISSING+=("curl")

if [ ${#MISSING[@]} -gt 0 ]; then
  if [ -z "$PKG_INSTALL" ]; then
    warn "Instale manualmente: ${MISSING[*]}"
  else
    echo "  Pacotes necessários: ${MISSING[*]}"
    read -rp "  Instalar agora com '${PKG_INSTALL}'? [S/n] " ans
    if [ "${ans:-S}" != "n" ] && [ "${ans:-S}" != "N" ]; then
      if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        sudo $PKG_INSTALL "${MISSING[@]//|/ }" || warn "Alguns pacotes não puderam ser instalados."
      else
        $PKG_INSTALL "${MISSING[@]//|/ }" || warn "Alguns pacotes não puderam ser instalados."
      fi
    else
      warn "Seguindo sem instalar; funcionalidades podem ficar limitadas."
    fi
  fi
fi

if is_wayland; then
  ok "Sessão Wayland detectada (wl-copy + ydotool)"
  if command -v ydotool >/dev/null 2>&1; then
    if ! systemctl is-active --quiet ydotool 2>/dev/null && ! pgrep -x ydotoold >/dev/null 2>&1; then
      warn "O daemon do ydotool não parece estar ativo."
      echo "     Inicie com:  sudo systemctl enable --now ydotool"
      echo "     (ou adicione seu usuário ao grupo 'input' se necessário)"
    fi
  fi
else
  ok "Sessão X11 detectada (xclip + xdotool)"
fi

# ------------------------------------------------------------------ arquivos da aplicação
info "Instalando o Dita em $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR" "$CONFIG_DIR" "$MODEL_DIR"
chmod 700 "$CONFIG_DIR"

for f in server.mjs linux-global.mjs azure-realtime.mjs whisper-local.mjs package.json package-lock.json README.md; do
  [ -f "$f" ] || fail "Arquivo $f não encontrado. Rode o instalador dentro da pasta do Dita."
  cp "$f" "$APP_DIR/"
done
rm -rf "$APP_DIR/dist" "$APP_DIR/scripts" "$APP_DIR/test" "$APP_DIR/tools"
cp -r dist "$APP_DIR/"
[ -d scripts ] && cp -r scripts "$APP_DIR/"
[ -d test ] && cp -r test "$APP_DIR/"
[ -d tools ] && cp -r tools "$APP_DIR/"
ok "arquivos copiados"

info "Instalando dependências do Node"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --silent ) || fail "Falha no npm install."
ok "dependências instaladas"

# ------------------------------------------------------------------ whisper.cpp
build_whisper() {
  info "Compilando o whisper.cpp (pode levar alguns minutos)"
  local src="$APP_DIR/whisper.cpp"
  if [ ! -d "$src/.git" ]; then
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$src"
  fi
  ( cd "$src" \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON >/dev/null \
    && cmake --build build -j"$(nproc)" --target whisper-cli >/dev/null )
  [ -x "$src/build/bin/whisper-cli" ] || fail "Não foi possível compilar o whisper.cpp."
  ok "whisper.cpp compilado"
}

WHISPER_BIN=""
if command -v whisper-cli >/dev/null 2>&1; then
  WHISPER_BIN="$(command -v whisper-cli)"
  ok "whisper-cli encontrado no sistema: $WHISPER_BIN"
elif [ -x "$APP_DIR/whisper.cpp/build/bin/whisper-cli" ]; then
  WHISPER_BIN="$APP_DIR/whisper.cpp/build/bin/whisper-cli"
  ok "whisper.cpp já compilado"
else
  if command -v git >/dev/null 2>&1 && command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then
    build_whisper
    WHISPER_BIN="$APP_DIR/whisper.cpp/build/bin/whisper-cli"
  else
    warn "Sem git/cmake/g++ não é possível compilar o Whisper local."
    warn "Instale essas ferramentas e rode: ./install.sh --build-whisper"
  fi
fi

# ------------------------------------------------------------------ modelo
MODEL_NAME="${DITA_MODEL:-base}"
MODEL_FILE="$MODEL_DIR/ggml-${MODEL_NAME}.bin"

choose_model() {
  echo
  echo "  Escolha o modelo do Whisper (qualidade × velocidade):"
  echo "    1) tiny   ~75 MB   mais rápido, menos preciso"
  echo "    2) base   ~142 MB  equilíbrio (recomendado)"
  echo "    3) small  ~466 MB  melhor em português"
  echo "    4) medium ~1.5 GB  alta qualidade, mais lento"
  read -rp "  Opção [2]: " opt
  case "${opt:-2}" in
    1) MODEL_NAME="tiny" ;;
    3) MODEL_NAME="small" ;;
    4) MODEL_NAME="medium" ;;
    *) MODEL_NAME="base" ;;
  esac
  MODEL_FILE="$MODEL_DIR/ggml-${MODEL_NAME}.bin"
}

if [ ! -f "$MODEL_FILE" ]; then
  # reaproveita um modelo já baixado em outro lugar
  EXISTING="$(find "$HOME/.cache/whisper" "$HOME/.local/share" /usr/share -maxdepth 4 -name "ggml-*.bin" 2>/dev/null | head -1)"
  if [ -n "$EXISTING" ]; then
    info "Reaproveitando modelo existente: $EXISTING"
    cp "$EXISTING" "$MODEL_FILE"
  else
    choose_model
    info "Baixando o modelo ggml-${MODEL_NAME}.bin"
    curl -L --fail --progress-bar \
      -o "$MODEL_FILE" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin" \
      || fail "Falha ao baixar o modelo. Verifique a conexão e rode de novo."
    ok "modelo baixado ($(du -h "$MODEL_FILE" | cut -f1))"
  fi
else
  ok "modelo já presente: $(basename "$MODEL_FILE")"
fi

# ------------------------------------------------------------------ configuração
info "Configurando o Dita"
LANGUAGE_DEFAULT="pt"

if [ ! -f "$CONFIG_FILE" ]; then
  umask 077
  cat > "$CONFIG_FILE" <<EOF
# Dita — configuração
# Depois de alterar, rode: systemctl --user restart dita

# Provedor de transcrição: "local" (Whisper na sua máquina) ou "azure"
DITA_PROVIDER=local

# Caminho do binário e do modelo do whisper.cpp
DITA_WHISPER_BIN=${WHISPER_BIN:-}
DITA_WHISPER_MODEL=${MODEL_FILE}

# Idioma: pt, en, es… ou "auto" para detectar
DITA_LANGUAGE=${LANGUAGE_DEFAULT}

# Número de threads de CPU (vazio = metade dos núcleos)
DITA_WHISPER_THREADS=

# --- Azure (opcional, só se DITA_PROVIDER=azure) ---
# AZURE_OPENAI_REALTIME_URL=
# AZURE_OPENAI_API_KEY=
EOF
  chmod 600 "$CONFIG_FILE"
  ok "configuração criada em $CONFIG_FILE"
else
  warn "configuração existente mantida em $CONFIG_FILE"
  # garante que os caminhos apontem para esta instalação
  if ! grep -q '^DITA_WHISPER_MODEL=' "$CONFIG_FILE"; then
    printf 'DITA_WHISPER_MODEL=%s\n' "$MODEL_FILE" >> "$CONFIG_FILE"
  fi
  if ! grep -q '^DITA_PROVIDER=' "$CONFIG_FILE"; then
    printf 'DITA_PROVIDER=local\n' >> "$CONFIG_FILE"
  fi
fi

# ------------------------------------------------------------------ atalho global
info "Criando o atalho global"
cat > "$BIN_DIR/dita-toggle" <<'SCRIPT'
#!/usr/bin/env bash
# Atalho global do Dita: chama o servidor local para iniciar/parar a gravação.
PORT="${DITA_PORT:-3927}"
curl -fsS -X POST "http://127.0.0.1:${PORT}/api/hotkey" >/dev/null 2>&1 \
  || notify-send "Dita" "O serviço do Dita não está rodando." 2>/dev/null
SCRIPT
chmod +x "$BIN_DIR/dita-toggle"
ok "$BIN_DIR/dita-toggle"

# ------------------------------------------------------------------ serviço systemd
info "Instalando o serviço de usuário (systemd)"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/dita.service" <<EOF
[Unit]
Description=Dita — transcrição de voz local
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/server.mjs
Restart=on-failure
RestartSec=3
Environment=DITA_CONFIG=${CONFIG_FILE}
Environment=PATH=${BIN_DIR}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload 2>/dev/null || warn "systemd --user indisponível; rode o servidor manualmente."
systemctl --user enable --now dita 2>/dev/null && ok "serviço iniciado" || warn "Ative manualmente: systemctl --user enable --now dita"

# ------------------------------------------------------------------ atalho de teclado
echo
info "Atalho de teclado (F8)"
echo "  O Dita não altera suas configurações de teclado sozinho."
echo "  Configure F8 nas Preferências do sistema apontando para:"
echo -e "     ${BOLD}${BIN_DIR}/dita-toggle${NC}"
echo
echo "  GNOME:  Configurações → Teclado → Atalhos personalizados → +"
echo "  KDE:    Configurações do Sistema → Atalhos → Adicionar novo → Comando"
echo "  XFCE:   Configurações → Teclado → Atalhos de teclado → Adicionar"

# ------------------------------------------------------------------ resumo
PORT_TEST=3927
echo
echo -e "${GREEN}==============================================${NC}"
echo -e "${GREEN}  Dita instalado!${NC}"
echo -e "${GREEN}==============================================${NC}"
echo
echo "  Provedor : Whisper local (nenhum áudio sai da máquina)"
echo "  Modelo   : ${MODEL_NAME}"
echo "  Interface: http://127.0.0.1:${PORT_TEST}"
echo
echo "  Testar agora:"
echo -e "     ${YELLOW}systemctl --user status dita${NC}"
echo -e "     ${YELLOW}journalctl --user -u dita -f${NC}"
echo
echo "  Usar: pressione F8, fale, pressione F8 de novo."
echo
