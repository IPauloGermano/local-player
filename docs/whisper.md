# Whisper local — instalação e configuração

Guia independente para colocar o **whisper.cpp** funcionando com o Local Player
(transcrição local de legendas). Tudo aqui foi **testado** numa máquina Ubuntu
x86-64 com o release **whisper.cpp 1.9.2** e o modelo **`ggml-small.bin`**.

Nada é baixado pelo projeto. O servidor apenas **detecta** o binário e o modelo
e executa o whisper como processo local (`spawn`, sem shell). Sem binário ou
modelo, o player continua funcionando normal — a legenda simplesmente fica
"indisponível".

---

## 1. Requisitos

- **ffmpeg** com `ffmpeg`/`ffprobe` no PATH (ou `FFMPEG_BIN`/`FFPROBE_BIN`) — já
  usado pelo transcoding; a extração de áudio para o ASR depende dele.
- Um filesystem **com permissão de execução** para o binário (Linux/NTFS).
  **Drives FAT/vfat (pendrive) não executam binários.**
- O modelo GGML (`ggml-*.bin`) — dados, pode ficar em qualquer filesystem
  (inclusive no pendrive).

---

## 2. Instalar o binário

1. Baixe o release para sua plataforma:
   <https://github.com/ggml-org/whisper.cpp/releases> — por exemplo
   `whisper-bin-ubuntu-x64.tar.gz` (Linux x86-64).
2. Extraia. O pacote traz o `whisper-cli` **e as bibliotecas irmãs**
   (`libggml*.so*`). **Mantenha tudo junto na mesma pasta**: o executável
   carrega `libggml-cpu-*.so`/`libggml-base.so`/`libggml.so.0` pelo caminho do
   próprio binário (rpath). Mover só o `whisper-cli` quebra o load.
3. Torne-o executável: `chmod +x whisper-cli`.

```bash
# Exemplo: extrair para ~/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/
tar -xzf whisper-bin-ubuntu-x64.tar.gz
chmod +x whisper-bin-ubuntu-x64/whisper-cli

# Conferir que carrega e mostra a versão:
whisper-bin-ubuntu-x64/whisper-cli --version
# -> whisper.cpp version: 1.9.2
```

Se o app (e o `bin/`) estiver num pendrive vfat, **não** copie o binário para
lá — aponta `WHISPER_BIN` para o caminho ext4 (veja §4).

---

## 3. Instalar o modelo

Baixe um modelo GGML do repositório oficial
(`ggerganov/whisper.cpp` no Hugging Face) e coloque em `models/`:

```bash
# ~465 MB — boa relação precisão/velocidade
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
  -O models/ggml-small.bin

# Alternativas menores (menos precisas, mais rápidas):
#   ggml-base.bin  (~142 MB)
#   ggml-tiny.bin  (~75 MB)
```

Caminho esperado: `models/ggml-small.bin` (o servidor varre `models/` por
`ggml-*.bin`). Variantes quantizadas (`ggml-small-q5_1.bin`) também são
reconhecidas.

---

## 4. Apontar o servidor para o binário (envs)

| Env | Padrão | Uso |
| --- | --- | --- |
| `WHISPER_BIN` | procura `whisper-cli*` em `bin/` | caminho completo do binário (aceita espaços) |
| `WHISPER_MODEL_DIR` | `models/` (ao lado do `server.js`) | pasta com os `ggml-*.bin` |

```bash
WHISPER_BIN=/caminho/para/whisper-cli npm start
```

Exemplo real desta máquina (app no pendrive vfat, binário no disco interno
ext4):

```bash
WHISPER_BIN="$HOME/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/whisper-cli" \
PORT=4173 node server.js
```

---

## 5. Validar a instalação

```bash
# 1. Status real — binário + modelo detectados:
curl http://localhost:4173/api/ai/status
#    whisper: available=true, installedModel=small, models[small].installed=true

# 2. Config atual (mascarada, sem chaves):
curl http://localhost:4173/api/ai/config

# 3. Gerar a legenda de um vídeo sob demanda (priority 0 = aula aberta):
curl -X POST "http://localhost:4173/api/subtitles/generate?priority=0&path=<rel-do-video>"

# 4. Quando pronto, o VTT canônico fica em:
#    ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt
#    e o espelho em data/subtitles/<hash>.vtt
```

No log do servidor você verá a cadeia
`extraindo áudio → transcrevendo → pós-processando → formatando VTT → concluído`.

---

## 6. Como o pipeline chama o whisper

Conjunto de args fixo (sem shell), construído pelo `server.js`:

```
whisper-cli -m <modelo> -f <wav 16k mono> -l pt -oj -otxt -of <prefixo>
             [-t N]      # se advanced.transcriptionThreads > 0
             [-pp]       # progresso real (stderr `progress = N%`)
```

- O áudio é extraído com ffmpeg para **WAV 16 kHz mono PCM16** antes da
  transcrição.
- `-l pt` vem da config `transcription.language`.
- Se o binário rejeitar alguma flag extra (build antigo), o pipeline detecta o
  erro no stderr e **repete uma vez** com o conjunto mínimo — a transcrição
  nunca quebra por flag.

### Limitação: VAD (pular silêncio)

O **whisper-cli 1.9.2 rejeita a flag curta `-vad`** (sai com código 0 sem gerar
saída — erro silencioso) e o VAD real é ativado por `-vm`/`--vad-model`, que
exige o modelo `ggml-silero-vad.bin` (**não instalado** por padrão). Por isso:

- o pipeline **não passa `-vad`** e a Central de IA mostra VAD como **não
  suportado** (honesto, sem tentativas desperdiçadas);
- transcrição normal funciona perfeitamente sem VAD.

Para habilitar VAD no futuro: baixe `ggml-silero-vad.bin`, aponte
`-vm`/`--vad-model` para ele e volte `capabilities.vad` do registry para `true`
(no `server.js`).

---

## 7. Desempenho real medido (referência)

| Item | Valor |
| --- | --- |
| Modelo | `ggml-small.bin` (~465 MB) |
| Máquina | Ubuntu x86-64 (CPU moderna, 4 threads) |
| Áudio de teste | 159,85 s de fala pt-BR |
| Tempo de processamento | 60,4 s |
| **RTF** | **≈0.38** (tempo de processamento ÷ duração do áudio) |

Modelos menores (`base`/`tiny`) transcrevem mais rápido com menos precisão.

---

## 8. Solução de problemas

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| Status mostra `available:false` | binário ausente em `bin/` ou `WHISPER_BIN` inválido | verifique §2/§4; `chmod +x` |
| `modelInstalled:false` | modelo ausente em `models/` (ou `WHISPER_MODEL_DIR`) | verifique §3 |
| `whisper_model_load: invalid model data (bad magic)` (exit≠0) | arquivo de modelo **0 bytes/corrompido** (download interrompido) — o binário está íntegro | apague o arquivo em `models/` e refaça o download do §3; confira o tamanho (~465 MB para `small`) e o magic `ggml` (`xxd` nos 4 primeiros bytes) |
| `não foi possível iniciar o Whisper` | binário sem execução (vfat) ou `.so` irmãos não acompanharam | mova a pasta inteira para ext4; aponte `WHISPER_BIN` |
| `Whisper não gerou saída JSON. (error: unknown argument: ...)` | flag não suportada pelo build | o pipeline já retenta com conjunto mínimo; confirme que é 1.9.x |
| Transcrição gera texto errado/língua trocada | `transcription.language` errado | ajuste a config (`pt`) |

---

## 9. Referência rápida

- Binário: `whisper-cli` (whisper.cpp), release oficial em
  <https://github.com/ggml-org/whisper.cpp/releases>.
- Modelos: `ggml-*.bin` em <https://huggingface.co/ggerganov/whisper.cpp>.
- Envs: `WHISPER_BIN`, `WHISPER_MODEL_DIR`, `FFMPEG_BIN`, `FFPROBE_BIN`.
- Config de IA: `data/ai-config.json` (chaves só no servidor).
- Providers: registrados em `AI_TRANSCRIPTION_PROVIDERS` no `server.js`
  (data-driven; fluxo/UI/API não mudam ao adicionar um provider).
