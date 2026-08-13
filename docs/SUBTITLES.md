# Legendas por IA — pipeline completo

> Referência aprofundada do subsistema de legendas do Local Player. O `CLAUDE.md` mantém o resumo + invariantes; este arquivo é a fonte do detalhe. Pipeline: `Vídeo → extração de áudio (ffmpeg → WAV 16kHz mono PCM16) → ASR local (whisper.cpp) → transcrição bruta → pós-processamento determinístico → correção LLM opcional + guardrail → segmentação → WebVTT → cache → <track> no player`. Geração é **adicional**: sem binário/modelo/LLM/chave/internet o player funciona normal.

## Registry data-driven

Fonte de verdade; zero `if (provider === X)` no fluxo): `AI_TRANSCRIPTION_PROVIDERS` (whisper/whisper.cpp local com `capabilities:{vad:false,wordTimestamps:false,threads:true}` + moonshine/onnx **stub** — só entrada de registro, capabilities todas false), `AI_LLM_PROVIDER_TYPES` (`openai-compatible`, `chatEndpoint` = `/chat/completions`), `AI_LLM_PRESETS` (OmniRoute, OpenRouter, OpenAI, Personalizado). Adicionar provider = nova entrada no registry; fluxo/UI/API não mudam. **`capabilities.vad` é falso de propósito**: o whisper-cli **1.9.2 instalado rejeita a flag curta `-vad`** (exit 0 sem saída) e o VAD real usa `-vm`/`--vad-model` exigindo `ggml-silero-vad.bin` (não instalado). Habilite VAD = instalar o modelo silero e passar `-vm`.

## Config

Em `data/ai-config.json` (escrita atômica + fila serializada, padrão de `updateProgress`): `{ transcription:{provider,model,language,enabled,generateMode,pregenFirstLesson,pregenNextLesson,background,vad}, correction:{...}, postprocessing:{...}, llm:{providers:[...]}, advanced:{maxConcurrentAiJobs,llmTimeoutMs,transcriptionThreads} }`. `maskAiConfig()` serializa respostas (só `hasApiKey`, nunca a chave); `applyAiPatch()` faz o merge parcial do `POST /api/ai/config`; `sanitizeAiConfig()` valida contra o registry. **Ao adicionar campo novo, aplique-o em `applyAiPatch` E `maskAiConfig`** (bugs de persistência passados nasceram de esquecer um dos dois).

**Workspace temporário**: WAV de extração e saída do whisper vivem em `os.tmpdir()/local-player-workspace` (modo "auto" — configurável pela Central de IA) — não na pasta do app, para não martelar o pendrive com arquivos grandes. Mínimo de `300 MB` livres para iniciar extração; subpastas `audio/` (descartável) e `work/` (saída do Whisper). O que é pequeno/necessário para retomada (raw/processed JSON) fica em `data/subtitles/`. Workspace custom inválido vira erro imediato (`safeMkdir`, sem `recursive:true` — trava em paths patológicos).

## Fila priorizada P0–P3

`PRIORITY_DEMAND=0`/`NEXT=1`/`FIRST=2`/`BG=3`, número menor vence): **P0** = demanda (aula aberta no player), **P1** = próxima aula provável (frontend enfileira a aula seguinte quando a atual tem legenda), **P2** = primeira aula de cada curso após scan/rescan (`maybePregenFirstLessons`, só a primeira, dedup por `hasValidSubtitle`), **P3** = background (`maybePregenBackground`, lote `BACKGROUND_BATCH`=20, só quando **não há** P0/P1/P2 pendentes). A biblioteca **nunca** é gerada de uma vez — geração é orientada à demanda. `POST /api/subtitles/generate` repassa `priority`/`force`/`skipIfReady`; `generate-course` enfileira em P3.

## Preempção

(estratégia "a"): P0/P1 pode liberar slot preemptando job barato de reiniciar — `extracting` (rápido) ou `transcribing` dentro de `PREEMPT_GRACE_MS` (20s, modelo recém-carregado). Whisper.cpp carrega o modelo **por execução**; preemptar transcrição profunda desperdiçaria CPU (documentado como limitação). O preemptado volta à fila em **P3** (`PREEMPT_RETRY_PRIORITY`) com `requeueOnCancel`. A demanda **nunca espera** a fila.

## Estado & retomada

Jobs com `status` em `queued|extracting|transcribing|processing|correcting|formatting`; em `data/subtitles/jobs.json` (persistido) + `subtitleQueue` + `activeSubtitleHashes` (Set). No boot, `loadSubtitleJobs` reconstrói `abs` do `rel`, e todo job ativo vai para a fila: com **raw válido** → `processing` (retoma do pós-processamento, sem re-roda whisper); sem artefato → `queued` (recomeça). O scheduler aceita `queued` e `processing`.

## Raw-sourced gate

O pipeline só **retoma do raw** quando `raw.source.mtimeMs+size` batem com o arquivo atual. Vídeo substituído/tocado ⇒ raw descartado e **re-extração + re-transcrição** (nunca reusa transcrição velha). `force` (`?force=1`, botão "Regenerar") apaga cache **e** raw → regenera do zero.

## Cache & artefato final

Chave `sha1(rel).slice(0,24)` (nunca nome de vídeo/curso); invalidação por `mtime + size` do original. O **VTT canônico** fica em `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (`.courseplayer` começa com `.` → ignorado pelo scan) **e** o espelho em `data/subtitles/<hash>.vtt` (cache + resiliência para vídeos sem curso). A rota `GET /subtitles/<hash>.vtt?rel=` serve o canônico primeiro. `clear` global varre `.courseplayer`; `clear` por vídeo apaga ambos. `.courseplayer` vazio é removido na varredura.

## Whisper

`-m -f -l -oj -otxt -of` + flags opcionais — `-t N` (`advanced.transcriptionThreads`, 0 = auto), `-pp` (progresso real: stderr `progress = N%` → `job.percent`, exposto em `/api/subtitles/status`; nunca percent inventado). **VAD não é passado** (`capabilities.vad:false`; o 1.9.2 rejeita `-vad` silenciosamente — exit 0 sem saída — e o VAD real via `-vm` exige modelo silero ausente). Se o binário **rejeitar** qualquer flag extra (build antigo) o erro de "não gerou saída JSON" **propaga o stderr**, o retry-once detecta a flag rejeitada pela regex e repete com conjunto mínimo, mantendo o erro original se ambos falharem.

## Detecção real

`getAiStatus`/`detectTranscriptionProvider`: whisper instalado se `WHISPER_BIN` (env) existe ou há `whisper-cli*` em `bin/`; modelo se `models/ggml-<model>.bin` existe (ou `WHISPER_MODEL_DIR`); expõe `capabilities.vad/threads`. Nada é baixado; sem binário/modelo o status é honesto `available:false, modelInstalled:false`.

## Correção LLM

`runLlmCorrection`, genérica via registry): recebe só `{id,text}`, devolve só `{id,text}`; config+chave resolvidas no backend. Guardrail (`applyLlmGuardrail`) rejeita ids faltando/duplicados/inventados e conteúdo <40% ou >4x do original → usa a versão anterior. Falha/timeout/saída inválida ⇒ LLM ignorado, legenda **nunca** bloqueada.

## Concorrência

Transcode ffmpeg e whisper compartilham o MESMO semáforo `heavySlots` (nunca simultâneos por padrão). `MAX_CONCURRENT_AI_JOBS` env (default 1) inicializa; `advanced.maxConcurrentAiJobs` ajusta em runtime via `refreshHeavyMax`. LLM (rede, não CPU) **não** consome slot. Preempção só libera slot extra para quem é mais prioritário.

## Player

`<track kind="subtitles" srclang="pt-BR">` dinâmico (`src = /subtitles/<hash>.vtt?rel=<path>` → VTT do curso primeiro) + badge de status discreto (`.subtitle-status` .ok/.warn/.err/.off → "Legenda disponível" / "Gerando legenda…" / "Legenda indisponível" / "Erro ao gerar") + botão manual `.subtitle-action` ("Gerar legenda" quando sem legenda/erro; "Regenerar" com `force=1` quando pronta/erro). Polling em `setupPlayerSubtitles`; ao trocar de aula, `<track>`/badge antigos removidos. **Nunca `await` a geração antes de `video.play()`**.

## Segurança

Chaves só no backend; logs `[SUBTITLE]`/`[AI]` nunca imprimem chave/token/prompt completo; `spawn(..., {shell:false})` (whisper e ffmpeg); paths via `resolveSafeRelPath()`; hashes em URLs.

## Env vars

`WHISPER_BIN` (caminho do whisper-cli; filesystems FAT não executam — instale em local com exec, ex. `~/.local/opt/whisper.cpp/`), `WHISPER_MODEL_DIR` (default `models/`), `MAX_CONCURRENT_AI_JOBS` (slots `heavySlots` transcode+whisper, default 1), `MAX_CONCURRENT_TRANSCRIPTIONS` (transcrições whisper simultâneas, default 1) e `BACKGROUND_SUBTITLE_GENERATION` (`true`/`1` liga P3 em background).

---

# Editor de legendas (estilo YouTube)

> **Desativado no frontend** (a pedido do usuário): o botão **"✎ Legendas"** foi removido do player e a rota `?editSubtitles=1` é ignorada (`subtitleEditorMode` é forçado a `false` em `renderCourse`) — o editor nunca abre na UI. O código do editor e as rotas de backend (`editor`/`save`/`export`/`ai-corrections`) permanecem no repositório, mas são inalcançáveis. Para reativar, devolva o botão e deixe `renderCourse` honrar `editMode`. A seção abaixo documenta o comportamento do editor caso seja reativado.

Camada opcional sobre o pipeline: edita o VTT/processed sem nunca tocar a transcrição bruta. Entrada pela rota `#/course/<curso>?lesson=<aula>&editSubtitles=1` (botão **"✎ Legendas"** nos controles do player) ou pelo `<track>`/badge.

- **Overlay de exibição** (substitui `<track>`): camada única `.subtitle-overlay` posicionada pela geometria REAL do vídeo renderizado (`object-fit: contain` → letterbox, `ResizeObserver` + `MutationObserver` com debounce `pc-idle` + `fullscreenchange` + resize). Fonte ≈ 5,5% da altura do frame, clamp `[12px,52px]`; `pointer-events:none`; o texto é atualizado por `textContent` (sem re-render). O WebVTT vira só fonte de dados. **Nunca bloqueia `video.play()`**.
- **Editor** (`#subtitle-editor`): lista de segmentos (`.se-row`, id estável `sN`), textarea por segmento, tempos editáveis por inputs `m:ss.mmm` + botões **"Definir início/fim"** (marca o `currentTime` do vídeo) + nudge **±0,5s/±1s**; ações **adicionar após / dividir no cursor / mesclar com o próximo / excluir**; click na linha navega o vídeo; o segmento atual é destacado por troca de classe em `timeupdate` (sem re-render da lista) com auto-scroll que pausa 3s quando o usuário rola; **undo/redo** via pilha limitada de snapshots (60) capturados no `focusin`; **dirty guard** restaura o hash do editor e pede confirmação ao sair com alterações; **preview ao vivo** no overlay (mesma referência de `editor.segments`).
- **Persistência**: edição salva em `data/subtitles/edited/<hash>.json` — JSON estruturado com `segments:[{id,start,end,text}]` (ids estáveis, NUNCA índice de array), `version` inteiro, `source{mtimeMs,size}`, `correctedByLlm`; o VTT derivado é sempre re-gerado a partir desse JSON (`renderVtt`) para o espelho E o canônico `.courseplayer`. `loadEditableDoc` serve **edited > processed (mtime+size válido) > vtt**; o raw nunca é servido nem sobrescrito. `backupEditedSubtitle` copia a edição para `data/subtitles/backup/` **antes** de um `force`/regeneração e remove a edição ativa (a legenda volta ao estado de geração).
- **Concorrência entre abas**: o save envia `version`; o servidor compara com o `version` persistido — divergente = **409** e o editor mostra o diálogo "Conflito de edição" ("Esta legenda foi alterada em outra aba…") com **Recarregar editor** (recarrega do servidor) ou **Manter minhas edições** (continua; o próximo save tenta de novo). Nunca sobrescreve silenciosamente.
- **IA no editor**: "Corrigir com IA" → `POST /api/subtitles/ai-corrections` reusa `runLlmCorrection` + guardrail; o LLM recebe apenas `{id,text}` (timestamps nunca enviados) e devolve `{id,text}`; as correções voltam como mapa id→text aplicado na cópia de trabalho (o usuário revisa e salva). **Exportar** VTT/SRT usa o mesmo doc editável. **Regenerar** força nova geração (backup da edição antes).
- **Segurança**: todas as rotas do editor passam por `resolveSafeRelPath()`; validação de segmentos no servidor (`validateEditorSegments`: limites de quantidade/texto/duração mínima); chaves só no backend.

## API do subsistema

| Rota | Propósito |
| --- | --- |
| `GET /api/subtitles/status?path=<rel>` | Estado por vídeo (`ready`, `status`, `percent`, `pregenNextLesson`/`pregenFirstLesson`/`background` da config) — usado pelo player |
| `GET /api/subtitles/list` | Legendas prontas + jobs |
| `POST /api/subtitles/generate` | Enfileira geração (rel path; `?priority=0-3`, `?force=1`, `?skipIfReady=1`); dedup: 2º POST do mesmo vídeo → `alreadyRunning:true`, e promoção se a nova prioridade for maior |
| `POST /api/subtitles/generate-course?path=<course>` | Enfileira vídeos do curso sem legenda em **P3** (lote; mesmo gating de concorrência) |
| `POST /api/subtitles/cancel` | Cancela job por hash |
| `POST /api/subtitles/editor?path=<rel>` | Documento editável para o editor: **edited > processed (mtime+size válido) > vtt** (nunca raw); `ready`, `staleSource`, `canGenerate`/`canRegenerate` |
| `POST /api/subtitles/save?path=<rel>` | Grava edição manual (JSON estruturado com ids estáveis + VTT derivado → espelho + canônico `.courseplayer`); concorrência por `version` inteiro → divergente = **409** "alterada em outra aba" |
| `POST /api/subtitles/export?path=<rel>&format=vtt\|srt` | Exporta do MESMO doc editável (edited > processed > vtt); nunca raw |
| `POST /api/subtitles/ai-corrections?path=<rel>` | "Corrigir com IA" no editor: reusa `runLlmCorrection` + guardrail; LLM recebe só `{id,text}` e devolve `{id,text}` (timestamps nunca enviados); retorna mapa id→text para revisão — nada é gravado automaticamente |
| `POST /api/subtitles/clear` | Limpa jobs e legendas (body `{path}` = 1 vídeo; vazio = global; **nunca toca progresso**) |
| `GET /subtitles/<24-hex>.vtt?rel=<path>` | Serve o WebVTT: **primeiro** o canônico `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (quando `rel` bate com o hash), fallback para o espelho `data/subtitles/`; regex estrita de hash |

## Rotas de IA (config)

| Rota | Propósito |
| --- | --- |
| `GET /api/ai/status` | Estado real da IA: providers de transcrição (whisper/moonshine com `available`/`modelInstalled`/`languages`), providers LLM, `hasApiKey` |
| `GET /api/ai/config` | Config de IA **mascarada** — chaves nunca saem; só `hasApiKey` |
| `POST /api/ai/config` | Merge parcial + salva em `data/ai-config.json` (`apiKey`=string seta, `clearApiKey`=true limpa, ausente mantém) |
| `POST /api/ai/reset` | Volta a config de IA ao padrão |
| `POST /api/ai/llm/test` | Testa conexão LLM real (mensagem mínima "Responda apenas: OK"; nunca conteúdo de curso) |
