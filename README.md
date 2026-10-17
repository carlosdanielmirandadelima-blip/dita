# Dita

**Ditado por voz para Linux — 100% offline.**

Pressione um atalho, fale, pressione de novo: o texto aparece digitado no
aplicativo que estiver em foco. A transcrição roda **na sua propria maquina**
com [whisper.cpp](https://github.com/ggerganov/whisper.cpp). Nenhum audio sai
do computador.

> Funciona em X11 e Wayland. Compativel com Ubuntu, Debian, Fedora e Arch.

---

## Como funciona

```
microfone --> gravacao (pw-record/arecord)
                    |
                    v
            Whisper local (whisper.cpp)
                    |
                    v
        texto colado no app em foco
        (wl-copy + ydotool  |  xclip + xdotool)
```

- **Sem conta, sem chave de API, sem internet** depois de instalar o modelo.
- O modelo fica em `~/.local/share/dita/models/`.
- O audio e gravado em um diretorio temporario e apagado logo apos a transcricao.

---

## Instalar

Requisitos: Linux com Node.js 20+, `git`, `cmake` e um compilador C++.
O instalador tenta instalar o resto sozinho (dependencias de audio e de
digitacao).

```bash
git clone https://github.com/carlosdanielmirandadelima-blip/dita.git
cd dita
chmod +x install.sh
./install.sh
```

O instalador:

1. verifica as dependencias (audio, area de transferencia, digitacao);
2. instala o Dita em `~/.local/share/dita`;
3. **compila o whisper.cpp** automaticamente;
4. baixa um modelo (voce escolhe: tiny, base, small ou medium);
5. cria o servico de usuario `dita.service`;
6. cria o comando global `~/.local/bin/dita-toggle`.

### Modelos

| Modelo | Tamanho | Bom para |
|---|---|---|
| `tiny` | ~75 MB | maquinas fracas, respostas rapidas |
| `base` | ~142 MB | **padrao** - bom equilibrio |
| `small` | ~466 MB | melhor precisao em portugues |
| `medium` | ~1.5 GB | maxima qualidade, mais lento |

Para trocar depois: `DITA_MODEL=small ./install.sh` ou edite
`~/.config/dita/azure.env`.

---

## Usar

1. Pressione **F8** --> o Dita comeca a gravar (aparece uma notificacao).
2. Fale normalmente.
3. Pressione **F8** de novo --> ele transcreve e **cola o texto** no app em foco.

A interface web fica em <http://127.0.0.1:3927>.

### Configurar o atalho F8

O instalador **nao altera** suas configuracoes de teclado. Configure uma vez:

- **GNOME**: Configuracoes --> Teclado --> Atalhos personalizados --> `+`
  Nome: `Dita` - Comando: `~/.local/bin/dita-toggle`
- **KDE**: Configuracoes do Sistema --> Atalhos --> Adicionar novo --> Comando
- **XFCE**: Configuracoes --> Teclado --> Atalhos de teclado --> Adicionar

Atribua a tecla **F8** ao comando.

---

## Configuracao

Arquivo: `~/.config/dita/azure.env` (permissao `600`)

```text
# Provedor: "local" (Whisper na sua maquina) ou "azure" (servico remoto)
DITA_PROVIDER=local

DITA_WHISPER_BIN=/home/voce/.local/share/dita/whisper.cpp/build/bin/whisper-cli
DITA_WHISPER_MODEL=/home/voce/.local/share/dita/models/ggml-base.bin

# Idioma: pt, en, es... ou "auto" para detectar
DITA_LANGUAGE=pt

# Threads de CPU (vazio = metade dos nucleos)
DITA_WHISPER_THREADS=
```

Depois de alterar:

```bash
systemctl --user restart dita
```

### Variaveis de ambiente aceitas

| Variavel | Para que serve |
|---|---|
| `DITA_PROVIDER` | `local` ou `azure` |
| `DITA_WHISPER_BIN` | caminho do binario do whisper.cpp |
| `DITA_WHISPER_MODEL` | caminho do modelo `ggml-*.bin` |
| `DITA_WHISPER_THREADS` | numero de threads |
| `DITA_LANGUAGE` | idioma (`pt`, `en`, `auto`...) |
| `DITA_CONFIG` | caminho do arquivo de configuracao |
| `PORT` | porta da interface (padrao `3927`) |

---

## Azure (opcional)

O Dita tambem aceita o **Azure `gpt-realtime-whisper`** - util se voce ja tem
uma conta e quer qualidade de nuvem. Nesse caso, o arquivo de configuracao
recebe o endpoint do seu recurso e a credencial:

```text
DITA_PROVIDER=azure
AZURE_OPENAI_REALTIME_URL=https://SEU-RECURSO.openai.azure.com/openai/v1/realtime?model=gpt-realtime-whisper
```

E a credencial correspondente (veja o exemplo comentado em
`install.sh`, secao de configuracao). Voce tambem pode alternar pelo botao na
interface web.

**A credencial nunca vai para o navegador** - fica so no arquivo local com
permissao `600`.

---

## Wayland e X11

| Sessao | Area de transferencia | Digitacao |
|---|---|---|
| Wayland | `wl-copy` | `ydotool` |
| X11 | `xclip` | `xdotool` |

No Wayland o `ydotool` precisa do daemon ativo:

```bash
sudo systemctl enable --now ydotool
```

Se a digitacao nao funcionar, verifique se seu usuario esta no grupo `input`:

```bash
sudo usermod -aG input "$USER"   # depois faca logout e login
```

---

## Comandos uteis

```bash
systemctl --user status dita      # estado do servico
systemctl --user restart dita     # reiniciar
journalctl --user -u dita -f      # logs ao vivo
```

---

## Desenvolvimento

```bash
npm install
npm run build     # gera dist/ da interface
npm test          # testes do backend local
node server.mjs   # roda em http://127.0.0.1:3927
```

Estrutura:

```
server.mjs           servidor HTTP + API (status, transcribe, provider, hotkey)
whisper-local.mjs    backend local (whisper.cpp): detecta binario/modelo, transcreve
azure-realtime.mjs   backend opcional Azure (WebSocket)
linux-global.mjs     gravacao + digitacao no app em foco (F8)
dist/                interface web (build)
install.sh           instalador
```

### Testar a transcricao local

```bash
DITA_WHISPER_BIN=/caminho/whisper-cli \
DITA_WHISPER_MODEL=/caminho/ggml-base.bin \
node tools/teste-local.mjs
```

---

## Privacidade

- O audio **nunca** sai da maquina no modo local.
- Nao ha telemetria nem chamadas externas em tempo de execucao.
- A unica conexao de rede e o download do modelo durante a instalacao.
- A interface escuta apenas em `127.0.0.1` (nao e acessivel pela rede).

---

## Licenca

MIT - veja [LICENSE](LICENSE).
