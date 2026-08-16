# CLAUDE.md

Guia para trabalhar neste repositório (auditado do código real — o código é a fonte de verdade). Detalhe de implementação → `docs/` — **leia o ponteiro antes de mexer no subsistema**: `DOCUMENTACAO.md` (scan/API/media/persistência/transcoding), `SUBTITLES.md` (legendas + editor), `VALIDACAO.md` (checklist), `whisper.md` (instalação whisper.cpp), `BIBLIOTECAS.md` (bibliotecas externas), `TOPICOS-MARCADORES.md`, `AUDITORIA-PROGRESSO.md`.

## Projeto

Player local/offline em Node.js + Express (backend único `server.js`, SPA em `public/` em JS puro, ambos **sem build step**) para organizar/reproduzir mídia em disco: scan da árvore, serve originais com Range, progresso por aula, busca, favoritos, atalhos, **transcoding de fallback** (ffmpeg, só para formatos que o navegador não reproduz) e **legendas automáticas por IA** (Whisper local + correção LLM opcional — adicional, nunca dependência). Texto de UI/README/comentários em **pt-BR**.

**Tópicos vs cursos (explícito, sem inferência estrutural)**: pasta é **tópico** se contém `.topic` **ou** o nome termina em `(TP)`; senão é `folder` (curso/módulo). Tópico abre lista de filhos com breadcrumb (`Home › TI › Python`); curso abre o player. Estrutura física é a fonte de verdade. `(TP)` é removido só do título de exibição.

## Comandos

```bash
npm install --no-bin-links   # --no-bin-links ajuda em drives externos/FAT/exFAT
npm start                    # node server.js, escuta em :4173 (PORT/HOST override)
```

- Verificação de sintaxe: `node --check server.js public/app.js public/scope.js`
- Testes: `node --test test/progress.test.js test/topics.test.js test/libraries.test.js test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js` (progresso/tópicos/bibliotecas/escopo/sidebar; `progress` e `sidebar-runtime-smoke` sobem servidor real com `LP_DATA_DIR` em dir temporário; os demais são puros).
- **`LP_DATA_DIR`** (env opcional): redireciona `data/` (progresso/cache/config IA) — usada pelos testes como sandbox; uso normal não define.
- Dependência real: **Express** apenas. Sem linter. Checklist: `docs/VALIDACAO.md`.

## Multiplataforma (Linux + Windows)

- **Caminhos**: sempre APIs de `path`; nunca concatenar separador manual; não assumir `/tmp`, `~`, `C:\`, `D:\`.
- **Rel paths canônicos usam sempre `/`** (árvore, chaves de progresso, URLs); `abs` mantém separador nativo. `resolveSafeRelPath()` devolve `rel` com `/`.
- **Subprocessos**: `spawn`/`execFile` com array de args, **sem `shell: true`**. `FFMPEG_BIN`/`FFPROBE_BIN` aceitam caminho com espaços; bare `ffmpeg`/`ffprobe` do PATH funcionam.
- **Filesystem**: `fs.rename` sobrescreve no Windows; `fsync` de dir é best-effort; nada de `chmod`/symlinks; não depender de case (Linux sensível, Windows não).
- **Runtime em `data/`** (dentro do app). Exceção única: workspace temporário das legendas em `os.tmpdir()/local-player-workspace` (configurável pela Central de IA). Sem `/tmp`, sem `~/.config`.
- **Frontend**: URLs `/`, encoding por segmento (`encodeURIComponent`), atalhos por `event.key` (ABNT2/americano), fullscreen pela API padrão (nunca F11).

## Arquitetura

### Scan & raiz

- `ROOT = path.resolve(__dirname, "..")` — **nunca hardcode**; deriva da localização do app (copia para qualquer drive).
- **Bibliotecas externas**: registradas em `data/libraries.json` (padrão = `ROOT`, path **imutável**; externas com id `randomUUID`). `validateLibraryPath`: path absoluto + realpath, proíbe `__dirname`/`public`/`node_modules`/`data`, rejeita aninhamento. Scan sequencial das habilitadas. Media/transcode/legendas/progresso/favoritos escopados por biblioteca (`libId\0rel`). → `docs/BIBLIOTECAS.md`.
- Scan exclui pasta do app, entradas com prefixo `.`, `IGNORED_EXT` (`.ini`/`.db`/`.lnk`); capas ficam fora dos materiais/busca. Nós: `folder` \| `topic` \| `video` \| `file`. Ordenação `localeCompare(..., "pt-BR", {numeric:true, sensitivity:"base"})`.
- Árvore cacheada em `treeCache`; rescan via `GET /api/tree?rescan=1`/`POST /api/rescan`. Capa por nome (`cover`/`poster`/`banner`/...) ou herda de filho; sem imagem → gradiente com iniciais.

### Títulos (`normalizeDisplayTitle`, **no servidor**)

`name` nunca muda (dirige ordenação/busca). Remove prefixos simbólicos, rótulos (`Aula 03 - `, `Módulo 1 - `), sufixos de autoria, numeração inicial (conservadora: `3D Modelagem` sobrevive), truncamentos, `~1`, tags, sublinhados; capitalização de sentença pt-BR preservando siglas/nomes (SQL, Python, Node.js...). Módulos mantêm número (`01 - Título`); tópicos/aulas removem. Frontend só valida (`validateDisplayTitle`, avisa no console).

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

- Todo path de cliente passa por `resolveSafeRelPath()` (rejeita escape de `ROOT`). Media via `parseMediaRequest` + `sendFile` (Range → 206). `/transcoded/*` valida regex `^[0-9a-f]{24}\.mp4$`; `.tmp` órfão → 404. **Sem `express.static(ROOT)`** (BUG-001 corrigido: pasta do app bloqueada só na padrão + dotfiles → 404). `express.static(public)` serve a SPA.

### Persistência de progresso

`data/progress.json` (gitignored) → `{position, duration, completed, updatedAt}`. Escrita **atômica e durável** (`writeFileAtomic`: tmp exclusivo → fsync → rename → fsync dir best-effort), **fila serializada** (`updateProgress`), **backup + auto-recuperação** (`progress.json.bak`; inválido → renomeado para `.corrupt-<ts>` + restaura do backup). `.tmp` órfãos limpos no boot. Clear por prefixo `<coursePath>/` limpa aulas aninhadas.

### Transcoding de fallback

Só após `error` no `<video>` → `/api/video/fallback` → ffprobe (`probeMedia`, fallback p/ stderr do ffmpeg). **Compatível** (`mp4/mov/m4v/webm/ogg` + h264/vp8/vp9/av1/theora + aac/mp3/opus/vorbis/flac ou sem áudio) é servido direto — **decisão nunca pela extensão**.

- Cache: `data/transcoded/sha1(rel)[0:24].mp4`, invalidação por **mtime**; `.tmp` só vira final via `rename` após exit 0.
- Jobs: `transcodeJobs` (dedup) + fila FIFO; `MAX_CONCURRENT_TRANSCODES` (default 1); enfileirados órfãos há 120s são cancelados.
- **Streaming progressivo**: MP4 fragmentado (`-movflags frag_keyframe+empty_moov+default_base_moof`, `-g 60` ≈ 2s) → serve `.tmp` em crescimento; seek além do convertido espera `TRANSCODE_SEEK_WAIT_MS` (60s) e responde 416. `+faststart` deliberadamente **não** usado (exigiria 2º passe).
- Args fixos sem shell (`-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -progress pipe:1 -loglevel error`); progresso logado em passos de 25%. Sem ffmpeg → mensagem clara, não 500 cru. Envs: `FFMPEG_BIN`/`FFPROBE_BIN`/`MAX_CONCURRENT_TRANSCODES`.
- **Contrato frontend**: o MESMO `<video>` tem `src` trocado (preserva GainNode/listeners); posição/volume reaplicados quando a região fica `buffered`; badge não-bloqueante "Preparando compatibilidade..." + "Tentar novamente" em falha.

### Legendas por IA (resumo)

Pipeline: extração de áudio (ffmpeg → WAV 16kHz mono PCM16) → whisper.cpp → transcrição bruta → pós-processamento → correção LLM opcional (guardrail) → WebVTT → cache. **Adicional — sem binário/modelo/LLM/chave/internet o player funciona normal.**

- **Registry data-driven** é a fonte de verdade (nada de `if (provider === X)`).
- Fila **P0–P3** (menor vence): P0 demanda, P1 próxima aula, P2 1ª aula de cada curso pós-scan, P3 background. **Nunca gerar a biblioteca inteira.** Preempção só de jobs baratos em `PREEMPT_GRACE_MS`; volta em P3.
- Raw-sourced gate: reuso do raw só com `source.mtimeMs+size` válidos; `force=1` regenera do zero.
- VTT canônico em `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (ignorado pelo scan) + espelho `data/subtitles/`; chave `sha1(rel)[0:24]`.
- Raw **nunca sobrescrito**; correção LLM guardada (ids + conteúdo <40%/>4x rejeitados; falha/timeout ⇒ original, legenda nunca bloqueada).
- Concorrência: transcode e whisper compartilham `heavySlots`; LLM não consome slot. Envs: `WHISPER_BIN`/`WHISPER_MODEL_DIR` (→ `docs/whisper.md`), `MAX_CONCURRENT_TRANSCRIPTIONS` (default 1), `BACKGROUND_SUBTITLE_GENERATION`.
- Player: overlay `.subtitle-overlay` (nunca `<track>`), badge `.subtitle-status`, botão `.subtitle-action`. **Nunca `await` geração antes de `video.play()`.**

### Editor de legendas (estilo YouTube)

**Desativado no frontend**: botão "✎ Legendas" removido e `?editSubtitles=1` ignorado (`subtitleEditorMode` forçado a `false` em `renderCourse`) — editor nunca abre na UI. Código/rotas (`editor`/`save`/`export`/`ai-corrections`) permanecem, inalcançáveis. Para reativar: devolva o botão e deixe `renderCourse` honrar `editMode`. → `docs/SUBTITLES.md`.

### Frontend (`public/`)

- Roteamento por hash (`route()`): `#/` (home), `#/settings`, `#/course/<path>?lesson=<path>`, `#/topic/<path>` (mesmo parse; `renderCourse` resolve na árvore inteira e delega a `renderTopic` se `type==="topic"`). Objeto global `state`. **localStorage** só para preferências (`course-favorites`, `course-player-settings`, volume/gain/muted/speed, progress-mode).
- **Home** (`renderHome`): cards de curso e tópico (por marcador), capa ou gradiente+iniciais, favoritos ao topo (só cursos), busca **accent-insensitive** (acha tópicos/cursos/aulas aninhados). **Escopo contextual** (`public/scope.js`): "Seu progresso" = só cursos **diretos** da raiz (`collectDirectCourses`; some se a raiz não tem curso direto); "Continuar assistindo" = **global** (todas as bibliotecas, até 8, um por curso, `buildContinueItems`). Card reutilizado: `renderNodeCard`.
- **Tópico** (`renderTopic`): breadcrumb clicável (`Home › TI › Python`, ancestrais → `#/topic/`), grid dos filhos. **Escopo contextual refina**: dentro do tópico, "Seu progresso" e "Continuar assistindo" consideram **só a subárvore** (`collectCoursesInScope(topicNode)`); aninhado refina ainda mais. Sem favoritos/player; empty state.
- **Curso** (`renderCourse`): toolbar (favoritar, limpar progresso, gerar legendas do curso), player, cabeçalho da aula (breadcrumb + Anterior/Próxima), sidebar de navegação + progresso do curso, "Materiais da aula" abaixo do player. `expandedFolders` **em memória** (auto-expandido para ancestrais da aula; não persistido); `closeOtherModules` = acordeão.
- **Sidebar = navegação de aulas**: só `isSidebarNavigableNode` (`folder`/`topic`/`video`); `type === "file"` **nunca** vira item de sidebar, aula, prev/next, avanço pós-`ended`, "current lesson" nem contagem — materiais vivem **exclusivamente** em "Materiais da aula" (`filter(c => c.type==="file")` da pasta da aula) e na busca. `state.flatVideos = flattenVideos(course)` só com vídeos. Decisão por `type`, nunca por extensão.
- Seleção de aula: `lessonPath` explícita → retoma mais recente em andamento (`position>5 && !completed`, por `updatedAt`) → 1ª não concluída → 1ª vídeo.
- Tracking (`setupVideoTracking`): `timeupdate` (throttle 5s), `pause`, `ended` (conclui + avança, só com `wasPlaying`), `beforeunload` flush. Persist fino: auto-conclusão >95%; reassistir concluído mantém conclusão; posição 0 não apaga; sem metadata não grava; `loadAll()` sanea (posição perto do fim sem `completed` → `duration-5`). Retomada: seek em `loadedmetadata` quando `3 < position < duration-2`; `ended` volta do início.
- **Áudio**: `video.volume` até 100%; excesso (100–200%) via GainNode do Web Audio (AudioContext único, criado só com `gain>100%`; recria apenas o source node na troca de `<video>`). Velocidade 0.5–2× persistida em `course-player-speed`.
- **Atalhos configuráveis**: 13 ações em `DEFAULT_SHORTCUTS` (editáveis em Configurações, modo captura; conflito rejeitado; pulados em inputs; `Esc` fecha popovers).
- Fallback: `error` → `prepareTranscoded()` (badge, pede fallback, troca `src`, retoma em `buffered`; guardas `data-fallback`/`data-retry-original`).
- **Legendas no player** (`setupPlayerSubtitles`): `GET /api/subtitles/status` → overlay/badge/botão; gera P0 (`POST /api/subtitles/generate?priority=0`); com `pregenNextLesson` enfileira a próxima em P1 (`?priority=1&skipIfReady=1`). Tudo não-bloqueante.
- **Configurações**: limpar progresso global, limpar transcode, `closeOtherModules`, atalhos, **Central de IA** (6 abas; `GET /api/ai/status`, `POST /api/ai/config` — chaves nunca voltam; teste de conexão LLM). Ações destrutivas com `openConfirmDialog`. Topbar (`index.html`): logo/home, busca, **⟳ Atualizar** (`POST /api/rescan` → `loadAll()` → `route()`), configurações.

## Estrutura de arquivos

- `server.js` — backend completo (scan, API, media, persistência, transcoding, legendas).
- `public/` — `index.html` (casca + topbar), `app.js` (UI/routing/player/atalhos), `scope.js` (**helpers puros** de escopo/navegação: `isDescendantPath`, `isSidebarNavigableNode`, `collectCoursesInScope`, `collectDirectCourses`, `flattenVideos`, `buildContinueItems`; sem DOM/estado, `require()`-ável pelos testes), `styles.css`.
- `docs/` — detalhe de implementação (ver cabeçalho). `test/` — `topics`, `libraries`, `scope`, `sidebar` (puros); `progress`, `sidebar-runtime-smoke` (sobem servidor com `LP_DATA_DIR`).
- `data/` — runtime: `progress.json` (+`.bak`, `.corrupt-<ts>`, `.tmp`), `transcoded/`, `ai-config.json` (chaves só aqui), `subtitles/` (`raw/`, `processed/`, `work/`, `edited/`, `backup/`, `jobs.json`, `<hash>.vtt`). **Atenção**: `data/server.log` e backups tipo `*.wiped-*`/`*.bak` são **artefatos manuais** de sessões antigas — o servidor não escreve log em arquivo nem os gera.
- `bin/` + `models/` — instalação **manual** do whisper (`whisper-cli*`, `ggml-*.bin`); nada é baixado. **FAT/vfat não executa binários**: instale em filesystem com exec (ex. `~/.local/opt/whisper.cpp/`) e aponte `WHISPER_BIN`; modelos via `WHISPER_MODEL_DIR`.
- `.gitignore` — `node_modules/`, `data/`, `models/`+`bin/`, `*.tmp`/`*.temp`, `*.log`, `.env*`, configs locais de editor.

## Fluxo de dados (resumo)

1. `init()` → `GET /api/tree` + `GET /api/progress` → `state` → roteia por hash.
2. `renderCourse` escolhe a aula (regra de retomada) → `<video src="/media/<path>">`.
3. Tracking → `POST /api/progress` → `updateProgress` (fila serializada) → `writeFileAtomic` (com backup prévio).
4. `error` no vídeo → `prepareTranscoded` → `/api/video/fallback` → `src = /transcoded/<hash>.mp4` (cresce).
5. Na montagem, `setupPlayerSubtitles` → status → overlay + badge + botão; gera P0 e pré-gera P1; servidor enfileira P2 pós-scan e P3 background. Nunca bloqueia `play()`. Detalhes: `docs/SUBTITLES.md`.
6. `beforeunload` → flush final. Editor: desativado no frontend.

## Invariantes (não quebrar sem justificativa forte)

- **ROOT deriva de `__dirname`**; todo path de cliente passa por `resolveSafeRelPath()` (e por `resolveLibraryRel`/`requestLibrary` em ops por biblioteca — id desconhecido → 400, nunca degrada para a padrão).
- **Remoção de biblioteca é config-only** (nunca rm em arquivos; jobs ativos → 409; enfileirados descartados).
- **Chaves/caches escopados por biblioteca**: progresso `libId\0rel`, transcode/legendas `sha1(libId\0rel)[0:24]`, favoritos `libId\0path`.
- **Rel paths sempre `/`** (nunca `\`). **Compatíveis servidos direto** — fallback só após `error`.
- **Sem suporte a symlink/junction** (invariante multiplataforma): scan não indexa links e todo ponto que ABRE arquivo da biblioteca (`/media`, fallback/ffmpeg, pipeline de legendas) exige `fileWithinLibrary()` (realpath contido no path da biblioteca) — link apontando para fora → 404/400, nunca serve/processa o alvo.
- **Materiais com conteúdo ativo** (html/htm/xhtml/svg/xml/js/mjs/json) são servidos como `attachment` + `nosniff` (/media); nunca renderizados no origin da app.
- **Arquivo em crescimento**: `fd.stat()` (sem `fs.fstat`), copiar buffers antes de `res.write` (subarrays aliasam buffer reutilizado), tratar corrida de rename (job terminou no meio → abrir o final), nunca servir `.tmp` parcial como final.
- **Persistência** atômica + fila + backup; preservar corrompido (`.corrupt-<ts>`).
- **Hash routing** + troca de `src` no **mesmo** `<video>` (preserva Web Audio) são contratos. **Range preservado** em media.
- Sem build step/framework; sem novas dependências sem motivo. **`EADDRINUSE` → exit(1)**; `unhandledRejection`/`uncaughtException` logados, não derrubam (protege progresso).
- **`POST /api/transcode/clear` nunca toca `progress.json`**.
- **Legenda nunca é dependência do player**: nada bloqueia `play()`; sem binário/modelo/LLM/chave/internet funciona (badge "indisponível").
- **Registry = fonte de verdade** dos providers ASR/LLM. **Chaves só no backend** (`ai-config.json`); `GET /api/ai/*` retorna só `hasApiKey`; logs nunca imprimem chave/token/prompt.
- **LLM guardada** (ids + <40%/>4x rejeitados; falha ⇒ original). **Raw nunca sobrescrito**; reuso só com `source.mtime+size` válidos.
- **VTT canônico em `.courseplayer/subtitles/`**; `clear` apaga canônico + espelho.
- **Nunca gerar a biblioteca inteira** (P0–P3); preempção só de jobs baratos. Transcode + whisper compartilham `heavySlots`; LLM não.
- **Editor**: edição nunca sobrescreve raw/processed (`edited/<hash>.json`); save com `version` divergente = **409**; `backupEditedSubtitle` antes de regenerar. Overlay customizado substitui `<track>`; geometria pela área real do vídeo.
- **Sidebar = navegação de aulas** (só `isSidebarNavigableNode`); `type === "file"` nunca vira item de aula/progresso/contagem — só "Materiais da aula" e busca. Decisão por `type`, nunca extensão.

## Gotchas

- `npm install --no-bin-links` é intencional (drives externos). **Transcoding é fallback, não padrão** — converter compatível é regressão.
- Duas instâncias corrompem `progress.json` (por isso EADDRINUSE sai claro). Títulos calculados **no servidor**. `expandedFolders` não é persistido.
- Árvore re-renderiza com frequência (`updateProgressUI`) — preserve listeners/estado do `<video>`.
- Whisper não executa em FAT/vfat. Transcode × whisper esperam um ao outro por design (fila FIFO de waiters), não deadlock. Config de IA só grava em disco quando muda.

## Como validar alterações (resumo)

1. `node --check server.js public/app.js public/scope.js` + `node --test test/progress.test.js test/topics.test.js test/libraries.test.js test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js`.
2. `npm start` e exercite UI (scan, navegação, player sem transcode em compatíveis, busca, favoritos, progresso, atalhos). Tópicos: `docs/VALIDACAO.md` item 12.
3. Fallback: `.mkv`/`.avi` → badge → reprodução em segundos → `[TRANSCODE] progresso` no log → final em `data/transcoded/`; seek além do convertido aguarda/416.
4. Persistência: derrube o servidor no meio da gravação (ou simule `progress.json` corrompido) → recuperação do backup.
5. Path traversal: `/media/../../etc/passwd`, `?path=../../etc/passwd` e variantes Windows (`\`, absolutos) → 404/400.
6. Duas instâncias na mesma porta → mensagem clara + exit. 7. IA sem nada: `GET /api/ai/status` → `available:false`; Central renderiza as 6 abas.
8–11. Geração/LLM/concorrência/editor: **`docs/VALIDACAO.md`** (checklist completo).
