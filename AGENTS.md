# CLAUDE.md

Guia de trabalho para agentes/desenvolvedores. O código é a fonte de verdade.
Referência técnica detalhada: `docs/DOCUMENTACAO.md`; legendas: `docs/SUBTITLES.md`;
instalação do whisper: `docs/whisper.md`; checklist de validação: `docs/VALIDACAO.md`.

## Projeto

Player local/offline em Node.js + Express (backend único `server.js`, SPA em
`public/` em JS puro, ambos **sem build step**) para organizar/reproduzir mídia
em disco: scan da árvore, serve originais com Range, progresso por aula, busca,
favoritos, atalhos, **transcoding de fallback** (ffmpeg, só para formatos que o
navegador não reproduz) e **legendas automáticas por IA** (Whisper local +
correção LLM opcional — adicional, nunca dependência). Texto de UI/README/
comentários em **pt-BR**.

**Tópicos vs cursos (explícito, sem inferência estrutural)**: pasta é **tópico**
se contém `.topic` **ou** o nome termina em `(TP)`; senão é `folder`
(curso/módulo). Tópico abre lista de filhos com breadcrumb; curso abre o player.
Estrutura física é a fonte de verdade. `(TP)` é removido só do título exibido.

## Comandos

```bash
npm install --no-bin-links   # --no-bin-links ajuda em drives externos/FAT/exFAT
npm start                    # node server.js, escuta em :4173 (PORT/HOST override)
```

- Sintaxe: `node --check server.js public/app.js public/scope.js`
- Testes:

```bash
node --test test/progress.test.js test/topics.test.js test/libraries.test.js \
  test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js \
  test/progress-invariance.test.js test/progress-persistence.test.js \
  test/progress-forensic.test.js
```

  `progress`, `sidebar-runtime-smoke`, `progress-invariance`,
  `progress-persistence` e `progress-forensic` sobem servidor real com
  `LP_DATA_DIR` em dir temporário; os demais são puros.
- **`LP_DATA_DIR`** (env opcional): redireciona `data/` — usada pelos testes
  como sandbox; uso normal não define.
- Dependência real: **Express** apenas. Sem linter.

## Multiplataforma (Linux + Windows)

- **Caminhos**: sempre APIs de `path`; nunca concatenar separador manual; não
  assumir `/tmp`, `~`, `C:\`, `D:\`.
- **Rel paths canônicos usam sempre `/`** (árvore, chaves de progresso, URLs);
  `abs` mantém separador nativo. `resolveSafeRelPath()` devolve `rel` com `/`.
- **Subprocessos**: `spawn`/`execFile` com array de args, **sem `shell: true`**.
  `FFMPEG_BIN`/`FFPROBE_BIN`/`WHISPER_BIN` aceitam caminho com espaços; bare
  `ffmpeg`/`ffprobe`/`whisper-cli` do PATH funcionam.
- **Filesystem**: `fs.rename` sobrescreve no Windows; `fsync` de dir é
  best-effort; nada de `chmod`/symlinks; não depender de case.
- **Runtime em `data/`** (dentro do app). Exceção única: workspace temporário
  das legendas em `os.tmpdir()/local-player-workspace` (configurável pela
  Central de IA).
- **Frontend**: URLs `/`, encoding por segmento (`encodeURIComponent`), atalhos
  por `event.key` (ABNT2/americano), fullscreen pela API padrão (nunca F11).

## Arquitetura (resumo)

- `ROOT = path.resolve(__dirname, "..")` — **nunca hardcode**. Bibliotecas
  externas em `data/libraries.json` (padrão = `ROOT`, path imutável; externas
  com id `randomUUID`). `validateLibraryPath`: absoluto + realpath, proíbe
  `__dirname`/`public`/`node_modules`/`data`, rejeita aninhamento. Scan
  sequencial das habilitadas. Media/transcode/legendas/progresso/favoritos
  escopados por biblioteca (`libId\0rel`).
- Scan exclui pasta do app, entradas com prefixo `.`, `IGNORED_EXT`
  (`.ini`/`.db`/`.lnk`); capas fora dos materiais/busca. Nós: `folder` |
  `topic` | `video` | `file`. Ordenação `localeCompare(..., "pt-BR",
  {numeric:true, sensitivity:"base"})`.
- Árvore cacheada em `treeCaches` (Map por biblioteca); rescan via
  `GET /api/tree?rescan=1`/`POST /api/rescan` (tudo) ou
  `POST /api/libraries/:id/rescan` (uma). Capa por nome (`cover`/`poster`/
  `banner`/...) ou herda de filho; sem imagem → gradiente com iniciais.
- Títulos (`normalizeDisplayTitle`, **no servidor**): `name` nunca muda.
  Remove prefixos simbólicos, rótulos (`Aula 03 - `), sufixos de autoria,
  numeração inicial, truncamentos, `~1`, tags, sublinhados; capitalização de
  sentença pt-BR preservando siglas (SQL, Python, Node.js). Módulos mantêm
  número; tópicos/aulas removem.
- Frontend: roteamento por hash (`#/`, `#/settings`, `#/course/...`,
  `#/topic/...`), `state` global, localStorage **só** para preferências.
  Helpers puros de escopo/navegação em `public/scope.js` (require-ável pelos
  testes).

### API (`server.js`)

Rotas de legendas/IA → `docs/SUBTITLES.md`.

| Rota | Propósito |
|---|---|
| `GET /api/tree?rescan=1` · `POST /api/rescan` | Árvores por biblioteca (cacheadas) |
| `GET/POST /api/libraries` · `PATCH/DELETE /api/libraries/:id` · `POST /api/libraries/:id/rescan` | CRUD de bibliotecas (path da padrão imutável → 403; DELETE config-only, jobs ativos → 409) |
| `GET/POST /api/progress` · `POST /api/progress/clear` | Progresso (chaves `libId\0rel`); clear por curso/prefixo ou global |
| `GET /media/*` | Originais com Range por biblioteca (`/media/<rel>` padrão, `/media/<libId>/<rel>` externa) |
| `GET /api/video/fallback?path=` | Plano de transcoding (`compatible`/`status:'transcoding'\|'ready'`/`error`) |
| `GET /transcoded/<24-hex>.mp4` | Cache de transcode (final com Range ou `.tmp` progressivo) |
| `POST /api/transcode/clear` | Limpa `data/transcoded/` e cancela jobs; **nunca toca `progress.json`** |
| `GET /api/ai/status` · `GET/POST /api/ai/config` · `POST /api/ai/reset` · `POST /api/ai/llm/test` | Central de IA (chaves nunca voltam; só `hasApiKey`) |
| `GET /api/storage/status` · `GET /api/system/status` · `GET /api/logs` | Estado de armazenamento/sistema/logs em memória (Central de IA) |

- Todo path de cliente passa por `resolveSafeRelPath()` (rejeita escape de
  `ROOT`); ops por biblioteca usam `requestLibrary`/`resolveLibraryRel` (id
  desconhecido → 400). Media via `parseMediaRequest` + `sendFile` (Range →
  206). `/transcoded/*` valida regex `^[0-9a-f]{24}\.mp4$`; `.tmp` órfão → 404.
  **Sem `express.static(ROOT)`**; `express.static(public)` serve a SPA.

### Persistência de progresso

`data/progress.json` → `{position, duration, completed, updatedAt}`. Escrita
**atômica e durável** (`writeFileAtomic`: tmp exclusivo → fsync → rename →
fsync dir best-effort), **fila serializada** (`updateProgress`), **backup +
auto-recuperação** (`progress.json.bak`; inválido → `.corrupt-<ts>` + restaura
do backup). Guarda regressiva por conteúdo: um save normal nunca remove
chaves/regride `completed`/perde posição/duration válida. `.tmp` órfãos limpos
no boot. Clear por prefixo `<coursePath>/` limpa aulas aninhadas.

### Transcoding de fallback

Só após `error` no `<video>` → `/api/video/fallback` → ffprobe (`probeMedia`,
fallback p/ stderr do ffmpeg). **Compatível** (mp4/mov/m4v/webm/ogg +
h264/vp8/vp9/av1/theora + aac/mp3/opus/vorbis/flac ou sem áudio) é servido
direto — **decisão nunca pela extensão**.

- Cache: `data/transcoded/sha1(libId\0rel)[0:24].mp4`, invalidação por mtime;
  `.tmp` só vira final via `rename` após exit 0.
- Jobs: `transcodeJobs` (dedup) + fila FIFO; `MAX_CONCURRENT_TRANSCODES`
  (default 1); enfileirados órfãos há 120s são cancelados.
- **Streaming progressivo**: MP4 fragmentado (`-movflags
  frag_keyframe+empty_moov+default_base_moof`) → serve `.tmp` em crescimento;
  seek além do convertido espera `TRANSCODE_SEEK_WAIT_MS` (60s) e responde 416.
  `+faststart` deliberadamente **não** usado.
- Args fixos sem shell (`-c:v libx264 -preset veryfast -crf 23 -pix_fmt
  yuv420p -c:a aac -b:a 128k -progress pipe:1 -loglevel error`); progresso
  logado em passos de 25%. Sem ffmpeg → mensagem clara, não 500 cru.
- **Contrato frontend**: o MESMO `<video>` tem `src` trocado (preserva
  GainNode/listeners); posição/volume reaplicados quando a região fica
  `buffered`; badge não-bloqueante "Preparando compatibilidade..." +
  "Tentar novamente" em falha.

### Legendas por IA (resumo — detalhe em `docs/SUBTITLES.md`)

Pipeline: extração de áudio (ffmpeg → WAV 16kHz mono PCM16) → whisper.cpp →
transcrição bruta → pós-processamento → correção LLM opcional (guardrail) →
WebVTT → cache. **Adicional — sem binário/modelo/LLM/chave/internet o player
funciona normal.**

- **Registry data-driven** é a fonte de verdade (nada de `if (provider === X)`).
- Fila **P0–P3** (menor vence): P0 demanda, P1 próxima aula, P2 1ª aula de cada
  curso pós-scan, P3 background. **Nunca gerar a biblioteca inteira.** Preempção
  só de jobs baratos em `PREEMPT_GRACE_MS`; volta em P3.
- Raw-sourced gate: reuso do raw só com `source.mtimeMs+size` válidos;
  `force=1` regenera do zero.
- VTT canônico em `<lib>/.courseplayer/subtitles/<hash>.vtt` (ignorado pelo
  scan) + espelho `data/subtitles/`; chave `sha1(libId\0rel)[0:24]`.
- Raw **nunca sobrescrito**; correção LLM guardada (ids + conteúdo <40%/>4x
  rejeitados; falha/timeout ⇒ original, legenda nunca bloqueada).
- Concorrência: transcode e whisper compartilham `heavySlots`; LLM não consome
  slot. Envs: `WHISPER_BIN`/`WHISPER_MODEL_DIR` (→ `docs/whisper.md`),
  `MAX_CONCURRENT_TRANSCRIPTIONS` (default 1), `MAX_CONCURRENT_AI_JOBS`
  (default 1), `BACKGROUND_SUBTITLE_GENERATION`.
- Player: overlay `.subtitle-overlay` (nunca `<track>`), badge
  `.subtitle-status`, botão `.subtitle-action`. **Nunca `await` geração antes
  de `video.play()`.**
- **Editor de legendas**: desativado no frontend (botão removido e
  `?editSubtitles=1` ignorado). Código/rotas permanecem, inalcançáveis. Para
  reativar: devolva o botão e deixe `renderCourse` honrar `editMode`.

### Frontend (`public/`)

- **Home**: cards de curso e tópico (por marcador), capa ou gradiente,
  favoritos ao topo (só cursos), busca accent-insensitive. **Escopo
  contextual**: "Seu progresso" = cursos diretos da raiz e, sem curso direto,
  cai para o global (bloco nunca some); "Continuar assistindo" = **global**
  (até 8, um por curso). Dentro de um tópico, ambos consideram **só a
  subárvore** (`collectCoursesInScope`).
- **Curso**: toolbar (favoritar, limpar progresso, gerar legendas), player,
  cabeçalho da aula (breadcrumb + Anterior/Próxima), sidebar de navegação +
  progresso, "Materiais da aula" abaixo do player. `expandedFolders` em
  memória (não persistido).
- **Sidebar = navegação de aulas**: só `isSidebarNavigableNode`
  (`folder`/`topic`/`video`); `type === "file"` **nunca** vira item de
  sidebar/aula/progresso/contagem — só "Materiais da aula" e busca. Decisão
  por `type`, nunca por extensão.
- Seleção de aula: `lessonPath` explícita → mais recente em andamento
  (`position>5 && !completed`, por `updatedAt`) → 1ª não concluída → 1ª vídeo.
- Tracking (`setupVideoTracking`): `timeupdate` (throttle 5s), `pause`,
  `ended` (conclui + avança, só com `wasPlaying`), `beforeunload` flush
  (`sendBeacon`). Persist fino: auto-conclusão >95%; reassistir concluído
  mantém conclusão; posição 0 não apaga; sem metadata não grava. Retomada:
  seek em `loadedmetadata` quando `3 < position < duration-2`.
- **Áudio**: `video.volume` até 100%; excesso via GainNode (AudioContext único,
  recria só o source node na troca de `<video>`). Velocidade 0.5–2× persistida.
- **Atalhos configuráveis**: 14 ações em `DEFAULT_SHORTCUTS` (modo captura,
  conflito rejeitado, pulados em inputs, `Esc` fecha popovers).
- Fallback: `error` → `prepareTranscoded()` (badge, troca `src`, retoma em
  `buffered`; guardas `data-fallback`/`data-retry-original`).
- **Legendas no player** (`setupPlayerSubtitles`): `GET /api/subtitles/status`
  → overlay/badge/botão; gera P0; com `pregenNextLesson` enfileira a próxima
  em P1. Tudo não-bloqueante.
- **Configurações**: limpar progresso global, limpar transcode,
  `closeOtherModules`, atalhos, Central de IA (6 abas). Ações destrutivas com
  `openConfirmDialog`. Topbar: logo/home, busca, **⟳ Atualizar** (`POST
  /api/rescan` → `loadAll()` → `route()`), configurações.
- **Mobile**: drawer de aulas (`drawer-open`), cabeçalho da aula reorganizado
  ≤600px, ações secundárias no menu ⋮, controles em uma linha, breadcrumb
  compacto. Overscroll vertical desativado no mobile
  (`overscroll-behavior-y: none`).

## Invariantes (não quebrar sem justificativa forte)

- **ROOT deriva de `__dirname`**; todo path de cliente passa por
  `resolveSafeRelPath()` (e `resolveLibraryRel`/`requestLibrary` em ops por
  biblioteca — id desconhecido → 400).
- **Remoção de biblioteca é config-only** (nunca rm; jobs ativos → 409).
- **Chaves/caches escopados por biblioteca**: progresso `libId\0rel`,
  transcode/legendas `sha1(libId\0rel)[0:24]`, favoritos `libId\0path`.
- **Rel paths sempre `/`** (nunca `\`). **Compatíveis servidos direto** —
  fallback só após `error`.
- **Sem suporte a symlink/junction**: scan não indexa links; todo ponto que
  ABRE arquivo da biblioteca exige `fileWithinLibrary()` (realpath contido no
  path da biblioteca).
- **Materiais com conteúdo ativo** (html/htm/xhtml/svg/xml/js/mjs/json) servidos
  como `attachment` + `nosniff`; nunca renderizados no origin da app.
- **Arquivo em crescimento**: `fd.stat()`, copiar buffers antes de `res.write`,
  tratar corrida de rename, nunca servir `.tmp` parcial como final.
- **Persistência** atômica + fila + backup; preservar corrompido
  (`.corrupt-<ts>`). **`POST /api/transcode/clear` nunca toca `progress.json`**.
- **Hash routing** + troca de `src` no **mesmo** `<video>` (preserva Web
  Audio). **Range preservado** em media.
- Sem build step/framework; sem novas dependências sem motivo. `EADDRINUSE` →
  exit(1); `unhandledRejection`/`uncaughtException` logados, não derrubam.
- **Legenda nunca é dependência do player**; **Registry = fonte de verdade**
  dos providers ASR/LLM; **chaves só no backend**; logs nunca imprimem
  chave/token/prompt.
- **LLM guardada** (ids + <40%/>4x rejeitados; falha ⇒ original). **Raw nunca
  sobrescrito**. **VTT canônico em `.courseplayer/subtitles/`**; clear apaga
  canônico + espelho.
- **Tradução de legendas** (`translation` na config): LLM reusa o provider da
  correção; artefato derivado `baseHash-<lang>` (chave em `subtitleJobs`
  `hash-lang`, `kind:"translation"`); **nunca toca raw/processed/original**;
  só sob demanda (P0, no player); sem LLM → "Tradução indisponível". Whisper
  **não** traduz para PT (o `-tr` dele é EN-only).
- **Nunca gerar a biblioteca inteira** (P0–P3); preempção só de jobs baratos.
  Transcode + whisper compartilham `heavySlots`; LLM não.
- **Editor**: edição nunca sobrescreve raw/processed; save com `version`
  divergente = **409**; `backupEditedSubtitle` antes de regenerar. Overlay
  customizado substitui `<track>`; geometria pela área real do vídeo.
- **Sidebar = navegação de aulas**; `type === "file"` nunca vira item de
  aula/progresso/contagem. Decisão por `type`, nunca extensão.

## Gotchas

- `npm install --no-bin-links` é intencional. **Transcoding é fallback, não
  padrão** — converter compatível é regressão.
- Duas instâncias corrompem `progress.json` (por isso EADDRINUSE sai claro).
  Títulos calculados **no servidor**. `expandedFolders` não é persistido.
- Árvore re-renderiza com frequência (`updateProgressUI`) — preserve
  listeners/estado do `<video>`.
- Whisper não executa em FAT/vfat. Transcode × whisper esperam um ao outro por
  design (fila FIFO de waiters), não deadlock. Config de IA só grava em disco
  quando muda.

## Como validar alterações (resumo)

1. `node --check server.js public/app.js public/scope.js` + a suíte `node
   --test` completa (acima).
2. `npm start` e exercite a UI (scan, navegação, player, busca, favoritos,
   progresso, atalhos).
3. Fallback: `.mkv`/`.avi` → badge → reprodução em segundos → `[TRANSCODE]`
   no log → final em `data/transcoded/`; seek além do convertido aguarda/416.
4. Persistência: derrube o servidor no meio da gravação (ou simule
   `progress.json` corrompido) → recuperação do backup.
5. Path traversal: `/media/../../etc/passwd`, `?path=../../etc/passwd` e
   variantes Windows (`\`, absolutos) → 404/400.
6. Duas instâncias na mesma porta → mensagem clara + exit.
7. IA sem nada: `GET /api/ai/status` → `available:false`; Central renderiza as
   6 abas.
8. Geração/LLM/concorrência/editor: `docs/VALIDACAO.md` (checklist completo).
