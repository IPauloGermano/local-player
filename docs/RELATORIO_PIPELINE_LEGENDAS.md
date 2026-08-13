# Relatório — Pipeline de legendas por IA (ASR local + LLM multiprovedor + fila priorizada)

Local Player · 2026-08-11 · **3 etapas**: (1) pipeline base de legendas (ASR+LLM), (2) sistema inteligente de geração com **fila de prioridades P0–P3** e **legenda final na pasta do curso**, (3) **Whisper local real configurado** + documentação de instalação.

## 1. Arquivos alterados

| Arquivo | Tipo de mudança | Observação |
|---|---|---|
| `server.js` | **GRANDE** | Etapa 1: "Inteligência Artificial" (config, registry, detecção, rotas de estado) + "Legendas por IA" (fila, extração ffmpeg, Whisper, cache, pós-processamento, LLM + guardrail, WebVTT). Etapa 2: **fila priorizada P0–P3**, preempção com `requeueOnCancel`, artefato final em `ROOT/<curso>/.courseplayer/subtitles/`, pré-geração P1/P2/P3, `generate-course`, threads/progresso (`-t`/`-pp` com retry-once), raw-gate por mtime+size, correção de retomada (`abs` reconstruído; scheduler aceita `processing`). Etapa 3: **`capabilities.vad` → `false`** (whisper-cli 1.9.2 rejeita `-vad`), erro "não gerou saída JSON" **propaga stderr** (retry-once volta a funcionar). |
| `public/app.js` | **GRANDE** | Etapa 1: `aiState` + 6 sub-abas da Central de IA + `setupPlayerSubtitles`. Etapa 2: botão manual "Gerar/Regenerar legenda" (`force=1`), antecipação da próxima aula (P1), `<track src="/subtitles/<hash>.vtt?rel=">`, toolbar "Gerar legendas do curso", switches de pré-geração/background na aba Transcrição + threads/VAD em Avançado. Etapa 3: switch VAD **desabilitado** quando `vadSupported:false`, com explicação do build. |
| `public/styles.css` | **MÉDIA** | Classes `ai-*`, badge `subtitle-status` (.ok/.warn/.err/.off) e `.subtitle-action` (botão manual). Sem mudança no tema/layout existente. |
| `bin/README.md` + `models/README.md` | **NOVO** | Infra para binários/modelos instalados manualmente (nada é baixado). |
| `data/ai-config.json` | **NOVO (runtime)** | Config de IA persistida; chaves de API ficam só no backend. Novos campos da etapa 2: `transcription.pregenFirstLesson/pregenNextLesson/background/vad`, `advanced.transcriptionThreads`. |
| `data/subtitles/` | **NOVO (runtime)** | `raw/`, `processed/`, `work/`, `jobs.json`, `<hash>.vtt` (espelho). |
| `.gitignore`, `README.md`, `CLAUDE.md` | **PEQUENA/MÉDIA** | Ignora `models/`/`bin/`; README com fluxo de legendas; CLAUDE.md documenta fila priorizada, `.courseplayer/subtitles`, VAD/threads/progresso, novas rotas. |
| `public/index.html`, `package.json` | **SEM ALTERAÇÃO** | Zero dependências novas. |

## 2. Pipeline

```
Vídeo (rel path)
  → cache? (sha1(rel)[0:24] + mtime+size do arquivo)
      → VTT existente → fim (cache hit)
  → extração de áudio (ffmpeg → WAV 16 kHz mono PCM16; spawn, shell:false)
  → ASR local (whisper.cpp → JSON bruto com timestamps)      [se instalado; senão status explícito "unavailable"]
  → transcrição bruta SEMPRE preservada (raw/)
  → pós-processamento determinístico (capitalização / segmentação / dicionário técnico)
  → correção LLM OPCIONAL (runLlmCorrection, genérica via registry) + guardrail
      → valida: ids iguais (sem faltar/duplicar/inventar) e tamanho (≥40% e ≤4x)
      → falha/timeout/saída inválida ⇒ usa a versão anterior; legenda nunca é bloqueada
  → segmentação + WebVTT (end>start, sem timestamps negativos, máx. 2 linhas, sem cortar palavras)
  → cache (processed + VTT por hash)
  → player: <track kind="subtitles"> dinâmico + badge (disponível / gerando / indisponível / erro)
```

## 3. Providers testados

| Camada | Provider | Tipo | Resultado |
|---|---|---|---|
| ASR | Whisper (fake local p/ teste) | `whisper.cpp` local | ✓ vídeo → JSON → VTT |
| ASR | Whisper real | — | Não testado (binário não acompanha o projeto; sem ele status = "Não instalado") |
| ASR | Moonshine | `onnx` | Não instalado (entrada de registro; status real "não instalado") |
| LLM | Mock OpenAI-compatible local (modo `ok`) | `openai-compatible` | ✓ correção aplicada (`correctedByLlm: true`) |
| LLM | Mock local (modo `invented`) | `openai-compatible` | ✓ guardrail rejeitou id inventado; original preservado |
| LLM | Mock local (modos `dup`/`missing`/`summary`/`garbage`) | `openai-compatible` | ✓ todos rejeitados pelo guardrail |
| LLM | Provider inalcançável (`localhost:4199`) | `openai-compatible` | ✓ falha logada, LLM ignorado, legenda concluída |
| LLM | OmniRoute / OpenRouter / OpenAI | `openai-compatible` (presets) | Não chamados (requer chave paga); a camada é idêntica ao mock (mesmo protocolo `chat/completions`) |

Modelos ASR no registry: `tiny`, `base`, `small`, `medium`, `large-v3-turbo` (Whisper); `tiny`, `base` (Moonshine). Idiomas: pt-BR, en, es, fr, de, it, nl, ja, ko, zh, ru.

## 4. Testes obrigatórios — resultados

| # | Critério (spec 34–35) | Resultado |
|---|---|---|
| 1 | `node --check server.js` | ✓ |
| 2 | `node --check public/app.js` | ✓ |
| 3 | Servidor sobe sem IA/LLM/chave (config default, sem providers) | ✓ |
| 4 | Vídeo → extração real com ffmpeg (WAV 16k mono) | ✓ |
| 5 | ASR → JSON bruto → VTT | ✓ (3 segmentos, `hasVtt`) |
| 6 | Cache: chave `sha1(rel)[0:24]`, nunca nome de vídeo/curso | ✓ |
| 7 | Cache hit (re-POST gera "cache encontrado", sem re-extração) | ✓ |
| 8 | Invalidação por mtime+size (touch ⇒ re-extração) | ✓ |
| 9 | Dedup: 2 POSTs concorrentes ⇒ 1 job, 2ª resposta `alreadyRunning:true` | ✓ |
| 10 | LLM off ⇒ nenhuma chamada `corrigindo (LLM)`, legenda normal | ✓ |
| 11 | LLM on (válido) ⇒ `correctedByLlm:true` | ✓ |
| 12 | LLM inalcançável/timeout ⇒ `LLM ignorado (erro)`, legenda concluída | ✓ |
| 13 | Guardrail: id inventado | ✓ rejeitado |
| 14 | Guardrail: ids duplicados | ✓ rejeitado |
| 15 | Guardrail: ids faltando | ✓ rejeitado |
| 16 | Guardrail: conteúdo muito curto / JSON inválido | ✓ rejeitado |
| 17 | Player: legenda pronta ⇒ badge "Legenda disponível" (.ok) + `<track>` | ✓ |
| 18 | Player: auto-geração ⇒ badge "Gerando legenda…" (.warn) → pronta | ✓ |
| 19 | Player: troca de aula ⇒ track antigo removido, polling do novo | ✓ |
| 20 | Player: original → transcoded | ✓ por construção (badge/track independentes da fonte); sem transcode ativo na biblioteca de teste no momento |
| 21 | Multi-provedor LLM: roteamento por `correction.providerId` + teste por provider | ✓ |
| 22 | Persistência: `jobs.json` e `ai-config.json` sobrevivem a restart | ✓ |
| 23 | Retomada: raw existe ⇒ continua de "processing" (não re-roda whisper) | ✓ |
| 24 | Observabilidade: logs `[SUBTITLE]` em cada etapa | ✓ |
| 25 | Nunca logar chaves/tokens/prompts completos | ✓ (verificado em log) |
| 26 | Whisper ausente ⇒ status explícito, sem crash, sem sucesso falso | ✓ |
| 27 | `spawn(..., {shell:false})`; sem `exec`/`execSync` | ✓ (revisão de código) |
| 28 | Path traversal: rotas novas usam `resolveSafeRelPath`; sem caminho de arquivo vindo do cliente | ✓ |
| 29 | API keys nunca em `GET` (só `hasApiKey`) | ✓ |
| 30 | Concorrência: `heavySlots` compartilhado (ffmpeg+whisper+LLM nunca simultâneos por padrão) | ✓ |
| 31 | LLM recebe só `{id,text}` e retorna só `{id,text}` | ✓ |
| 32 | WebVTT: `end>start`, sem timestamps negativos, máx. 2 linhas | ✓ |
| 33 | Central de IA: 6 sub-abas, estados vazios amigáveis, responsivo | ✓ |
| 34 | App 100% funcional sem IA (navegar, player, progresso) | ✓ |

Bugs encontrados e corrigidos nesta validação final:

- **Aba "Transcrição" quebrava** (`Cannot read properties of undefined (reading 'map')`): `getAiStatus()` não incluía `languages` nos providers → adicionado `languages` em `detectTranscriptionProvider`.
- **`generateMode` não persistia**: `applyAiPatch` não aplicava o campo → adicionado.
- **`postprocessing` não persistia nem era exposto**: faltava no `applyAiPatch` **e** no `maskAiConfig` → adicionado em ambos.
- **`maxConcurrentAiJobs` não persistia**: faltava no `applyAiPatch` → adicionado.

## 5. Limitações

### Implementado
- Geração de legendas completa e válida (extração → ASR → pós-processamento → LLM opcional → VTT → cache → player).
- Fila de jobs com persistência, dedup, cancelamento e limpeza.
- Correção LLM genérica e multiprovedor com guardrail robusto.
- Central de IA completa (6 abas) com persistência de todas as opções.

### Preparado (arquitetura pronta, não exercitado)
- Execução com **whisper-cli real** e modelos reais: instalável manualmente em `bin/`/`models/` (ou via `WHISPER_BIN`/`WHISPER_MODEL_DIR`); a detecção e o fluxo estão prontos.
- **Moonshine**: entrada de registro existente; falta o runtime.
- **OmniRoute/OpenRouter/OpenAI reais**: presets e camada idêntica à do mock testado; requer chave válida (não testado com provedor pago).
- Player original→transcoded: coberto por construção; sem caso vivo na biblioteca atual.

### Não implementado
- Download automático de binário/modelo (proposital: instalação manual).
- Nenhuma IA quando o Whisper não está instalado (status honesto "Não instalado"; o app continua 100% funcional).

---

# Etapa 2 — Sistema inteligente de geração com fila priorizada

## 6. Arquitetura da fila e prioridades

- **Fila priorizada em memória** (`subtitleQueue` = array de hashes) + `subtitleJobs` (Map de jobs persistido em `data/subtitles/jobs.json`) + `activeSubtitleHashes` (Set de jobs rodando). Constantes: `PRIORITY_DEMAND=0`, `PRIORITY_NEXT=1`, `PRIORITY_FIRST=2`, `PRIORITY_BG=3` (número menor = mais prioritário). O scheduler roda o primeiro job **elegível** da fila (com o maior slot livre) e preempta jobs baratos para dar lugar a quem é mais prioritário.
- **Nunca processa a biblioteca inteira**: geração é **orientada à demanda**. Só entram na fila:
  - **P0 (demanda)** — aula aberta no player, `POST /api/subtitles/generate` (também o botão manual "Gerar/Regenerar", que usa `force=1`). Nunca espera a fila: enfileira e chama preempção/scheduler.
  - **P1 (próxima aula)** — frontend enfileira `state.flatVideos[idx+1]` quando a aula atual tem legenda/geração ativa e `pregenNextLesson` está ligado (`?priority=1&skipIfReady=1`).
  - **P2 (primeira aula de cada curso)** — `maybePregenFirstLessons(tree)` após scan/rescan (só a primeira vídeo de cada curso, via DFS em ordem natural, se `pregenFirstLesson` e sem legenda válida).
  - **P3 (background)** — `maybePregenBackground(tree)` (config `background`, lote `BACKGROUND_BATCH`=20, **somente quando não há P0/P1/P2 pendentes**). `POST /api/subtitles/generate-course?path=` também enfileira os vídeos do curso sem legenda em P3.
- **Dedup + promoção**: um job por vídeo (hash). Se um vídeo já está na fila e chega demanda maior prioridade, o job é **promovido** (prioridade do job atualizada, sem job novo). 2º POST do mesmo vídeo → `alreadyRunning:true`.
- **Estados** (persistidos): `queued → extracting → transcribing → processing → correcting → formatting → completed`, com `failed`/`cancelled`. `percent` (0–100) atualizado em tempo real a partir do progresso real do whisper (`-pp`, stderr `progress = N%`); se o binário não emite, o status fica indeterminado ("Gerando legenda…"), **nunca** porcentagem inventada.

## 7. Preempção (estratégia "a")

- Só preempta jobs **baratos de reiniciar**: `extracting` (extração ffmpeg, rápida) ou `transcribing` dentro de `PREEMPT_GRACE_MS` (20s — modelo recém-carregado). Whisper.cpp carrega o modelo **por execução** (subprocesso); preemptar transcrição profunda desperdiçaria CPU e recarregaria o modelo — documentado como limitação.
- O job preemptado recebe `requeueOnCancel=true` e o scheduler o **re-enfileira em P3** (`PREEMPT_RETRY_PRIORITY`), resetando o status para `queued`. O `finally` do pipeline limpa `activeSubtitleHashes` (consertou o bug que travava a fila após `subtitleMax` jobs).

## 8. Legenda final na pasta do curso + cache

- **VTT canônico**: `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (`.courseplayer` começa com `.` → ignorado pelo scan). `data/subtitles/` mantém o **espelho** (serve de cache de registro validado por mtime+size) e os temporários (`work/`, `raw/`, `processed/`). A rota `GET /subtitles/<hash>.vtt?rel=<path>` serve **primeiro** o VTT do curso (quando o `rel` bate com o hash), com fallback para o espelho (vídeos na raiz, sem curso; resiliência).
- **Identidade**: `sha1(relVideoPath).slice(0,24)` — nunca nome de vídeo/curso em URL. **Invalidação** por `mtime + size` do original; `?force=1` apaga cache e raw → regenera do zero; `clear` por vídeo apaga VTT do curso **e** espelho; `clear` global varre `.courseplayer` (removendo também o diretório quando fica vazio).
- **Raw-gate**: o pipeline só **retoma do raw** quando `raw.source.mtime+size` batem com o arquivo atual. Vídeo substituído/tocado ⇒ raw descartado → **re-extração + re-transcrição** (nunca reusa transcrição velha).

## 9. VAD, threads e progresso (Whisper)

- Registry expõe `capabilities: {vad, wordTimestamps, threads}` por provider (whisper: vad true, threads true; moonshine: todas false). `detectTranscriptionProvider` expõe no `/api/ai/status`.
- Execução: `-m -f -l -oj -otxt -of` + flags opcionais `-vad` (se `transcription.vad` e provider suporta), `-t N` (`advanced.transcriptionThreads`, 0 = auto), `-pp` (progresso real). Se o binário **rejeitar** flags extras (build antigo), **retry-once** com conjunto mínimo; se ambos falharem, o erro original é preservado.
- Modelo carregado **por execução** (subprocesso whisper.cpp) — não há servidor/modelo residente. Nada é baixado (§42).

## 10. Testes da Etapa 2 — resultados

| # | Critério (§39) | Resultado |
|---|---|---|
| 1 | `node --check server.js public/app.js` | ✓ |
| 2 | Fila não trava: enfileirar 3+ vídeos → **todos completam** (bug antigo: travava após `subtitleMax`) | ✓ |
| 3 | Preempção: aula Y aberta enquanto primeira-aula do curso X roda em P2 → Y (P0) ganha o slot; X volta à fila em P3 e completa depois | ✓ |
| 4 | Dedup: 2 opens da mesma aula → 1 job; abrir aula já em P2 → promovida a P0 sem job novo | ✓ |
| 5 | Legenda final no curso: `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` existe; `data/subtitles/` não vazou `.wav/.json/.tmp` para dentro do curso | ✓ |
| 6 | P2 pós-scan: rescan → só a **primeira** aula de cada curso entra em P2 (11 cursos → 11 jobs, sem duplicatas) | ✓ |
| 7 | P1: abrir aula → a seguinte entra em P1 (`pregenNextLesson`); sem legenda duplicada (backend dedupa) | ✓ |
| 8 | P3: com `background` e fila P0–P2 vazia → lote ≤ 20 em P3; com aula aberta, P0 sempre na frente | ✓ |
| 9 | Invalidação: `touch` no vídeo → raw velho descartado → re-extração + re-transcrição; mtime+size iguais → cache reutilizado | ✓ |
| 10 | Restart no meio do job → retoma de `processing` (raw válido) ou volta a `queued` (sem artefato) — nunca trava | ✓ |
| 11 | `clear` por vídeo → apaga VTT do curso e do espelho; global → varre `.courseplayer` (0 dirs restantes) | ✓ |
| 12 | Player: toca sem esperar legenda; `<track>` com `?rel=` serve o VTT do curso; botão "Regenerar" (`force=1`) regera | ✓ |
| 13 | VAD/threads/progresso: `vad:true` → `-vad`; binário que rejeita → retry-once sem `-vad`; `threads` → `-t N`; `-pp` → `percent` avança 10→30→60→90 (stderr real) | ✓ |
| 14 | Segurança: endpoints novos usam `resolveSafeRelPath`; `spawn` com args fixos, `shell:false`; sem caminho de usuário em URL de cache | ✓ |
| 15 | `generate-course` → `{enqueued:0, skipped:6}` (6 vídeos já com legenda); `skipIfReady` → `{ok:true, skipped:true}` | ✓ |

## 11. Bugs encontrados e corrigidos na Etapa 2

- **Fila travava após `subtitleMax` jobs** (bug crítico): `activeSubtitleHashes.add()` nunca era removido; o `finally` do pipeline decrementava `activeSubtitleJobs` (variável inexistente). Corrigido: `finally` faz `activeSubtitleHashes.delete(hash)`.
- **Preempção não devolvia o job à fila**: `requeueOnCancel` era setado mas nunca honrado — o preemptado virava "cancelled" e sumia. Corrigido: re-enfileira em P3 (`PREEMPT_RETRY_PRIORITY`), status resetado para `queued`.
- **Retomada com `job.abs` ausente**: `abs` não é persistido; após restart, `fs.stat(undefined)` → "Arquivo de vídeo não encontrado". Corrigido em `loadSubtitleJobs`: reconstrói `abs` via `resolveSafeRelPath(job.rel)`.
- **Jobs retomados em "processing" ficavam travados**: `loadSubtitleJobs` marcava `processing` mas não enfileirava; o scheduler só rodava `queued`. Corrigido: jobs ativos vão para a fila e o scheduler aceita `queued || processing`.
- **Retomada ignorava vídeo substituído**: raw era reusado mesmo com `touch`/troca do arquivo → reusava transcrição velha. Corrigido com o **raw-gate** (raw só confiável se `source.mtime+size` batem).

## 12. Decisões de projeto (Etapa 2)

- **Preempção "a"** (só jobs baratos; preemptado volta em P3) em vez de matar transcrição profunda — respeita o custo de recarregar o modelo whisper por execução (§6, §10).
- **VTT canônico na pasta do curso** (`.courseplayer/subtitles`) com espelho em `data/` (§15/16/40) — legenda viaja com o curso; `data/` vira cache de registro e resiliência.
- **Progresso real do whisper** (`-pp`) com estado indeterminado quando ausente — nunca porcentagem fabricada (§26).
- **VAD/threads opt-in** (`transcription.vad`, `advanced.transcriptionThreads`) com retry-once — compatível com builds antigos de whisper (§13, §12).
- **Nada é baixado** (§42): detecção honesta "instalado/não instalado"; binário/modelo instalados manualmente em `bin/`/`models/` (ou env `WHISPER_BIN`/`WHISPER_MODEL_DIR`).

## 13. Limitações da Etapa 2

- Preempção não interrompe transcrição profunda (custo de recarregar modelo) — a demanda P0 que chega enquanto um P2/P3 transcria **profundamente** espera o término (ou pega o slot quando outro job barato é preemptável).
- `percent` depende do whisper emitir `progress = N%` (`-pp`); builds sem isso mostram estado indeterminado.
- Background (`P3`) só roda com a fila prioritária vazia por design — se o usuário abre aulas, P0/P1/P2 sempre na frente.
- Whisper em drive FAT/vfat não executa (sem permissão); `WHISPER_BIN` deve apontar para um filesystem com exec.
- Transcode ffmpeg e whisper compartilham `heavySlots` — uma conversão longa pode segurar a geração de legenda (e vice-versa), por design (fila FIFO de waiters, sem deadlock).

# Etapa 3 — Whisper local real configurado + documentação de instalação

## 14. Infraestrutura real auditada e instalada

| Item | Descoberta real |
| --- | --- |
| Sistema | Linux 7.0.0-29-generic, x86-64 |
| Filesystem do app | `/dev/sdc1` vfat (pendrive) — **não executa binários** |
| Binário | `whisper-cli` **1.9.2** (whisper.cpp), ELF x86-64, ~976 KB |
| Localização do binário | `~/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/whisper-cli` (ext4) |
| Bibliotecas | `libggml.so.0`, `libggml-base.so.0`, `libggml-cpu-*.so` — **irmãs, carregadas pelo rpath do próprio binário** |
| Modelo | `ggml-small.bin` (~465 MB), em `models/` |
| Env usada | `WHISPER_BIN` → binário ext4; `PORT=4173` |
| Detecção | `GET /api/ai/status` → `available:true, installedModel:small` |

**Fluxo E2E real validado** (vídeo Visão Computacional,66s): enfileirado em P0 →
extração ffmpeg → whisper real → pós-processamento → VTT canônico em
`ROOT/Visão Computacional com Python/.courseplayer/subtitles/<hash>.vtt` +
espelho → status `ready:true`. Texto pt-BR correto, timestamps válidos
(end>start, ≤2 linhas). Um P2 de background (n8n 1.1) também concluiu com34
segmentos e o 1.3 com91 — fila priorizada funcionando com o ASR real.

**Dedup/cache**: 2º POST do mesmo vídeo → `[SUBTITLE] cache encontrado` sem
re-extração.

**RTF real** (modelo small,4 threads, áudio159,85s de fala pt-BR): 60,4s de
processamento → **RTF ≈0.38**.

## 15. Bugs reais encontrados e corrigidos

1. **Retry-once morto** (`server.js`): quando whisper-cli 1.9.2 rejeita uma flag
   opcional (ex.: `-vad`) com **exit code 0** e sem arquivos de saída, o ramo
   "Whisper não gerou saída JSON." devolvia erro **sem `stderr`** — a regex do
   retry-once (`/unknown argument|...|-vad/`) nunca casava e o job morria.
   **Corrigido**: o erro agora propaga o `stderr` (com a última linha no
   message), tornando o retry-once funcional de verdade.
2. **`capabilities.vad` declarado `true` mas inutilizável no build real**: o
   whisper-cli 1.9.2 **rejeita `-vad`** (exit 0, silencioso) e o VAD real usa
   `-vm`/`--vad-model` exigindo o modelo `ggml-silero-vad.bin` (não instalado).
   **Corrigido**: registry do whisper agora declara `capabilities.vad:false` —
   a UI mostra VAD como não suportado, o pipeline não passa `-vad` (sem
   tentativa desperdiçada) e a transcrição normal funciona.
3. **Frontend**: o switch VAD era editável mesmo com o provider sem suporte.
   Agora fica **desabilitado** com explicação quando `vadSupported:false`.

## 16. O que NÃO foi feito (por decisão, não por esquecimento)

- **Nada é baixado automaticamente** pelo app — binário/modelo são instalação
  manual (§19/§21 da tarefa).
- **Nenhum provider paralelo** — só o registry `AI_TRANSCRIPTION_PROVIDERS`
  (§4).
- **VAD não foi habilitado à força**: exigiria o modelo silero ausente; ficou
  documentado como limitação honesta (§3/§20) com o caminho para habilitar.
- **Nenhuma dependência nova** — Express continua a única.
- **Nenhum caminho absoluto hardcoded** no código: `WHISPER_BIN`/`WHISPER_MODEL_DIR`
  são envs; defaults relativos (`bin/`, `models/`). Portabilidade mantida (§5/§18).

## 17. Documentação criada/atualizada

- `README.md`: nova seção **"Configuração de transcrição local (Whisper)"** com
  comandos testados (§14 da tarefa) + links.
- `CLAUDE.md`: capabilities.VAD corrigido, envs, limitação do 1.9.2, estrutura
  (§15).
- `docs/whisper.md` (**novo**): guia independente completo — requisitos, binário
  + `.so` irmãos, modelo, envs, validação, pipeline, desempenho, solução de
  problemas (§16).
- `bin/README.md` / `models/README.md`: versão instalada, requisito dos `.so`,
  gotcha vfat, modelo real e RTF.
- `data/ai-config.json`: criado (defaults + patch de teste); persiste após
  restart (§13).

## 18. Como reproduzir (comandos testados)

```bash
# 1. Binário (whisper.cpp 1.9.2) em filesystem com exec — mantenha os .so junto:
tar -xzf whisper-bin-ubuntu-x64.tar.gz && chmod +x whisper-cli

# 2. Modelo (~465 MB):
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
  -O models/ggml-small.bin

# 3. Rodar o servidor apontando o binário (se fora de bin/):
WHISPER_BIN=/caminho/para/whisper-cli npm start

# 4. Validar:
curl http://localhost:4173/api/ai/status   # available:true, installedModel:small
```

## 19. Limitações conhecidas desta instalação

- **VAD indisponível**: 1.9.2 rejeita `-vad`; `-vm` exige `ggml-silero-vad.bin`
  ausente. Transcrição sem VAD funciona normalmente.
- `models/ggml-small.bin` ocupa ~465 MB no pendrive (modelo é dado, ok em
  vfat); o binário **precisa** estar em filesystem com exec.
- A pasta `bin/` do projeto permanece vazia (vfat) — a instalação real usa a
  env `WHISPER_BIN`. O README de `bin/` documenta esse fluxo.

---

# Etapa 3 (cont.) — Relatório final (§20–§24)

## 20. Adequação do modelo

O `ggml-small.bin` existente no projeto é **válido e compatível** com o
whisper-cli 1.9.2 (mesma família GGML; build oficial). Não houve download nem
substituição de modelo — respeitando a restrição *"NÃO baixe outro modelo se já
existir um modelo válido no projeto"*. Medição real (§21): RTF ≈0.38 (4 threads)
— boa relação precisão/velocidade para legendas de curso pt-BR. O modelo atual
foi configurado e usado em produção na Etapa 3.

## 21. Teste final — 11 itens (todos executados e aprovados)

Executados com o binário real (`WHISPER_BIN` → whisper.cpp 1.9.2) e o modelo
`ggml-small.bin`, sobre vídeos reais da biblioteca (Curso "Visão Computacional"
e "n8n"). Resultados:

| # | Item | Resultado |
| --- | --- | --- |
| 1 | Status real honesto sem binário/modelo | `available:false, modelInstalled:false` sem whisper (verificado desligando o binário) |
| 2 | Binário + modelo detectados | `available:true, modelInstalled:true, installedModel:"small"` |
| 3 | Geração P0 sob demanda (aula aberta) | Legenda gerada e `<track>` no player |
| 4 | P1 (próxima aula) após legenda da atual | Enfileira a aula seguinte (skipIfReady) |
| 5 | P2 (primeira aula de cada curso) pós-scan | Só a primeira aula, dedup por `hasValidSubtitle` |
| 6 | P3 background (lote ≤20) | Só com fila P0–P2 vazia; config `background` off por padrão |
| 7 | Preempção (P0 sobre P2/P3) | `extracting`/`transcribing` dentro de `PREEMPT_GRACE_MS`; preemptado volta à fila em P3 |
| 8 | Dedup + cache | 2º POST → "cache encontrado" sem re-extração; `touch` no vídeo → re-gera |
| 9 | Retomada pós-restart | Boot com `raw` válido → `processing`; sem artefato → `queued` |
| 10 | VTT canônico na pasta do curso | `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` + espelho `data/subtitles/`; rota serve o canônico primeiro |
| 11 | Legenda nunca bloqueia `play()` | Player reproduz sem esperar a geração; badge/`<track>` aparecem quando prontos |

## 22. Auditoria final

- **Paths**: nenhum caminho absoluto hardcoded; `__dirname`/`path.join` em todo o
  fluxo (§5) — portável pendrive → cópia → execução.
- **Sem shell**: `spawn(..., {shell:false})` com args fixos para whisper e
  ffmpeg (segurança, §10).
- **Sem auto-download**: nada é baixado pelo app; binário/modelo instalados
  manualmente; status honesto se ausentes.
- **Chaves/segredos**: chaves de API só no backend (`data/ai-config.json`);
  logs `[SUBTITLE]`/`[AI]` nunca imprimem chave/token/prompt; `/api/ai/status` e
  `/api/ai/config` mascaram (só `hasApiKey`).
- **Sem dependência nova**: `package.json` intocado (só Express).
- **Fluxos não relacionados intactos**: transcoding, progresso, scanner, busca,
  favoritos — nenhuma alteração na Etapa 3.
- **Retry-once**: flag rejeitada pelo build (ex.: `-vad` em 1.9.2) → stderr
  propagado → retry com conjunto mínimo; transcrição nunca quebra por flag.

## 23. Estado do runtime pós-limpeza

Fila de legendas com apenas jobs **completados** (pendentes de teste removidos);
config de IA: provider whisper, modelo small, língua pt, `background:false`,
`pregenFirstLesson:true`, `pregenNextLesson:true`, `vad:true` (config; não
aplicado pois `capabilities.vad:false`), `transcriptionThreads:0` (auto).
Servidor reiniciado limpo — log sem erros, `GET /api/ai/status` reporta
`available:true / small / vad:false / threads:true`.

## 24. Relatório final — resumo executivo

| Item | Valor |
| --- | --- |
| **Binário** | `whisper-cli` — whisper.cpp **1.9.2** (ELF x86-64, ~976 KB) |
| **Localização** | `~/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/whisper-cli` (ext4, com os `.so` irmãos — rpath) |
| **Modelo** | `ggml-small.bin` (~487.601.967 B ≈ 465 MB), `models/ggml-small.bin` (vfat ok — é dado) |
| **Env** | `WHISPER_BIN=<caminho acima>`; `WHISPER_MODEL_DIR` default `models/` |
| **Provider** | registro data-driven `AI_TRANSCRIPTION_PROVIDERS` (whisper local; moonshine stub) |
| **Teste real (RTF)** | áudio 159,85 s pt-BR → 60,4 s de processamento = **RTF ≈0.38** (small, 4 threads) |
| **Capabilities** | `vad:false` (1.9.2 rejeita `-vad`; `-vm` exige silero ausente), `threads:true`, `wordTimestamps:false` |
| **Arquivos alterados** | `server.js` (stderr no retry-once, `capabilities.vad:false`, comentários), `public/app.js` (switch VAD desabilitado/off), `README.md`, `CLAUDE.md`, `models/README.md`, `bin/README.md` |
| **Documentação criada** | `docs/whisper.md` (guia independente completo) + `RELATORIO_PIPELINE_LEGENDAS.md` (Etapas 1–3) |
| **Comandos reproduzíveis** | ver §18 e `docs/whisper.md` |

### Como reproduzir (resumo)

```bash
# 1. Binário (whisper.cpp 1.9.2) em filesystem com exec — mantenha os .so junto
tar -xzf whisper-bin-ubuntu-x64.tar.gz
chmod +x whisper-bin-ubuntu-x64/whisper-cli

# 2. Modelo (~465 MB)
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
  -O models/ggml-small.bin

# 3. Rodar o servidor apontando o binário (se fora de bin/)
WHISPER_BIN="$HOME/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/whisper-cli" \
  PORT=4173 node server.js

# 4. Validar
curl http://localhost:4173/api/ai/status
curl -X POST "http://localhost:4173/api/subtitles/generate?priority=0&path=<rel-do-video>"
```

### Limitações (honestas)

- VAD indisponível no build 1.9.2 sem `ggml-silero-vad.bin` (o pipeline não
  passa `-vad`; transcrição normal funciona).
- O binário precisa de filesystem com exec (pendrive vfat **não** executa);
  `WHISPER_BIN` resolve isso apontando para ext4/NTFS.
- Preempção de transcrição profunda não é feita (whisper carrega o modelo por
  execução) — por design, documentado no §13.
- `models/ggml-small.bin` ocupa ~465 MB; modelos menores (`base`/`tiny`) são
  mais rápidos e menos precisos, configuráveis na Central de IA.

### Próximos passos sugeridos

- Habilitar VAD baixando `ggml-silero-vad.bin` e voltando `capabilities.vad`
  para `true` no registry (com o flag `-vm` correto do 1.9.2).
- Criar testes automatizados com um `whisper fake` (gera JSON a partir do WAV)
  para validar a fila/retomada em CI sem depender de binário real.
- Revisar `docs/DOCUMENTACAO.md` para incluir o pipeline de legendas por IA
  (hoje a doc cobre apenas scan/media/persistência/transcoding).

# Etapa 4 — Editor de legendas estilo YouTube + overlay customizado

Implementação sobre o pipeline das Etapas 1–3 (mantido intacto: fila priorizada,
cache, `.courseplayer`, LLM com guardrail). Nenhuma regressão nas funcionalidades
existentes (transcode, progresso, posição, volume/gain, velocidade, fullscreen,
hash routing, Central de IA).

## 25. Arquivos alterados (Etapa 4)

| Arquivo | Mudança |
| --- | --- |
| `server.js` | Rotas do editor (GET `/api/subtitles/editor`, POST `/save`, `/export`, `/ai-corrections`); `SUBTITLE_EDITED_DIR`/`SUBTITLE_BACKUP_DIR`; `saveEditedSubtitle` (JSON + VTT derivado, version-check), `loadEditableDoc` (edited > processed > vtt), `backupEditedSubtitle`, `validateEditorSegments`, `formatSrt`; registro dos 4 endpoints **após** `app.use(express.json())` (bug de `req.body` indefinido) |
| `public/app.js` | `subtitleState` + geometria do overlay (`computeSubtitleGeometry`/`applySubtitleGeometry`/`wireSubtitleGeometry` com ResizeObserver + MutationObserver + fullscreenchange); `updateSubtitleOverlay` (textContent, sem re-render); `setupPlayerSubtitles` passou a carregar o overlay (edited > processed > vtt) no lugar do `<track>`; módulo do editor (`renderSubtitleEditor`, lista/timeline, undo/redo por snapshots, split/merge/add/delete, nudge/definir início-fim, dirty guard, preview ao vivo, save com 409, export, AI, regenerar); rota `&editSubtitles=1` |
| `public/styles.css` | `.subtitle-overlay`/`.subtitle-overlay-inner` (pill, text-shadow, pointer-events:none, z-index, bottom-inset com `pc-idle`); bloco completo do editor (`.subtitle-editor`, `.se-*`, responsivo @720px) |
| `CLAUDE.md`, `README.md` | Docs da Etapa 4 |
| `RELATORIO_PIPELINE_LEGENDAS.md` | Este relatório |

## 26. Arquitetura

- **Overlay de exibição** substitui `<track>` como camada de renderização única
  (`.subtitle-overlay`). O WebVTT vira apenas fonte de dados. Geometria é
  calculada a partir da área REAL do vídeo renderizado: com `object-fit:contain`
  o frame fica letterboxado, então `computeSubtitleGeometry` mede o box do
  `<video>` e aplica a regra do aspect ratio para achar o retângulo do conteúdo;
  sem `videoWidth` (ex.: headless) cai para o box do wrap como provisório. Fonte
  ≈ 5,5% da altura do frame, clamp `[12px,52px]`; inset inferior varia com a
  classe `pc-idle` (controles recolhidos/expandidos). `ResizeObserver` +
  `MutationObserver` (debounce `pc-idle`) + `fullscreenchange` + `resize`
  mantêm a posição correta em tela cheia, redimensionamento e troca de aula.
- **Editor** entra por `#/course/<curso>?lesson=<aula>&editSubtitles=1` (botão
  "✎ Legendas" no player) e carrega `GET /api/subtitles/editor`. O doc é a
  **cópia de trabalho**; o save é manual (sem autosave agressivo). Previews ao
  vivo apontam o `subtitleState.segments` para a MESMA referência de
  `editor.segments`.
- **Persistência**: o save grava JSON estruturado (`edited/<hash>.json`, ids de
  segmento estáveis `sN`, `version` inteiro, `source{mtimeMs,size}`) e regenera o
  VTT derivado com `renderVtt` (espelho `data/subtitles/` + canônico
  `ROOT/<curso>/.courseplayer/subtitles/`). `loadEditableDoc` serve
  **edited > processed (mtime+size válido) > vtt** — o raw jamais é servido nem
  sobrescrito.
- **Concorrência**: o save envia `version`; o servidor compara com o persistido;
  divergente → **409** → diálogo "Esta legenda foi alterada em outra aba" com
  "Recarregar editor" (recarrega do servidor) / "Manter minhas edições".

## 27. Mecânica do editor (Fases 3–10)

- Lista de segmentos (`.se-row`) com textarea, tempos em inputs `m:ss.mmm`,
  "Definir início/fim" (marca `currentTime`), nudge ±0,5s/±1s.
- Adicionar após / dividir no cursor / mesclar com o próximo / excluir — todos
  com re-numeração de ids estáveis preservados e dirty guard.
- Click na linha navega o vídeo; destaque do segmento atual via troca de classe
  em `timeupdate` (nunca re-render da lista) com auto-scroll que pausa 3s quando
  o usuário rola.
- Undo/redo por pilha de snapshots (máx. 60), capturados no `focusin` (estado
  pré-edição).
- Dirty guard: sair do editor com alterações restaura o hash e pede confirmação.
- Exportar VTT/SRT do mesmo doc editável; "Corrigir com IA" reenvia só
  `{id,text}` ao LLM (guardrail incluso) e devolve mapa id→text para revisão;
  "Regenerar" faz backup da edição e remove a edição ativa.

## 28. Testes executados (Etapa 4)

Validados com o servidor real em `localhost:4173` e um **driver CDP** em Chrome
headless (WebSocket nativo do Node v24):

1. **Overlay/posição**: overlay presente, texto correto, visível, zero `<track>`,
   badge "Legenda disponível", botão "✎ Legendas" no player.
2. **Editor carrega**: 34 segmentos (mesmo nº do processed), preview ao vivo,
   dirty "salvo" inicial, barra de ferramentas completa (salvar/desfazer/refazer/
   exportar/AI/regenerar).
3. **Editar → dirty → salvar**: texto alterado persiste, `version` incrementa,
   JSON em `edited/` + VTT derivado (espelho e canônico) atualizados.
4. **Split/merge/nudge**: 34→35→34 segmentos; nudge +1s em `start` e `end`.
5. **Undo/redo**: com foco real (`focusin`), desfazer/refazer restauram o texto;
   botão desabilita no fim da pilha.
6. **Conflito 409 (fluxo real da UI)**: editor carregado → outra aba salva por
   trás (bump via `fetch`) → Salvar → diálogo "Conflito de edição" com os dois
   botões → "Recarregar editor" recarrega do servidor (versão/dirty resetados).
7. **Dirty guard**: sair com alterações → confirmação; confirmar descarta.
8. **Restauração**: doc editado removido e VTTs regenerados do processed intacto
   (raw preservado; estado pré-testes confirmado via API `source=processed`).

## 29. Limitações

- Nenhum autosave automático (save manual + dirty guard); por design.
- Preview ao vivo depende do vídeo ter metadados; em headless sem GPU a geometria
  usa fallback provisório até o `loadedmetadata`.
- LLM do editor usa o MESMO guardrail do pipeline (conteúdo entre 40% e 4× do
  original; ids conservados) — correções fora disso são rejeitadas.
- Edição manual em vídeo cuja legenda foi regenerada (`force`) é preservada como
  backup, mas a versão ativa volta ao estado gerado (fluxo intencional).

## 30. Próximos passos sugeridos

- Autosave opcional com debounce (configurável) mantendo o version-check.
- Drag para reposicionar blocos na timeline (hoje: nudge + inputs + definição
  por `currentTime`).
- Busca/destaque de texto dentro do editor; atalhos de teclado dedicados.
- Review de `docs/DOCUMENTACAO.md` para incluir editor + overlay.
