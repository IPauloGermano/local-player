# Local Player — Documentação Técnica

Referência técnica central. Escrita a partir do código real (`server.js`,
`public/`, `package.json`, `test/`) — o código é a fonte de verdade. Para
instalação/uso voltados ao usuário: `README.md`. Subsistemas especializados:
`docs/SUBTITLES.md` (legendas/IA), `docs/whisper.md` (instalação do whisper),
`docs/VALIDACAO.md` (checklist).

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Estrutura de diretórios e dados de runtime](#3-estrutura-de-diretórios-e-dados-de-runtime)
4. [Scan e árvore de conteúdo](#4-scan-e-árvore-de-conteúdo)
5. [Tópicos por marcador explícito](#5-tópicos-por-marcador-explícito)
6. [Bibliotecas externas](#6-bibliotecas-externas)
7. [Normalização de títulos](#7-normalização-de-títulos)
8. [Segurança](#8-segurança)
9. [API](#9-api)
10. [Persistência de progresso](#10-persistência-de-progresso)
11. [Transcoding de fallback](#11-transcoding-de-fallback)
12. [Legendas por IA](#12-legendas-por-ia)
13. [Frontend](#13-frontend)
14. [Variáveis de ambiente](#14-variáveis-de-ambiente)
15. [Invariantes](#15-invariantes)

---

## 1. Visão geral

O **Local Player** é um player local/offline (Node.js + Express + SPA em
HTML/CSS/JS puro, **sem build step**) que lê mídia direto do disco. O backend
único (`server.js`) escaneia bibliotecas, expõe uma API JSON, serve os arquivos
originais com HTTP Range e executa transcoding/legendas; o frontend (`public/`)
é uma SPA que conversa com essa API. Roda em `http://localhost:4173`.

Arquivos principais:

| Arquivo | Papel |
| --- | --- |
| `server.js` | Backend completo: scan, API, media, persistência, transcoding, legendas |
| `public/index.html` | Casca da SPA (topbar + `<main id="app">`) |
| `public/app.js` | UI, roteamento, player, atalhos |
| `public/scope.js` | Helpers puros de escopo/navegação (require-ável pelos testes) |
| `public/styles.css` | Estilos (tema escuro, responsivo) |
| `test/` | Testes `node:test` |

Dependência real única: **Express** (`package.json`). FFmpeg/FFprobe são
binários do sistema, opcionais (fallback de transcoding e extração de áudio das
legendas).

## 2. Arquitetura

Fluxo de dados principal:

```text
init() → GET /api/tree + GET /api/progress → state → roteia por hash
renderCourse → escolhe a aula (regra de retomada) → <video src="/media/<rel>">
tracking (timeupdate 5s/pause/ended/beforeunload) → POST /api/progress
→ updateProgress (fila serializada) → writeFileAtomic (com backup prévio)
error no vídeo → prepareTranscoded → /api/video/fallback → /transcoded/<hash>.mp4
na montagem → setupPlayerSubtitles → status → overlay+badge+botão; nunca bloqueia play()
```

- Backend e frontend conversam só por HTTP (`/api/*`, `/media/*`,
  `/transcoded/*`); não há socket/SSE.
- Roteamento do frontend por hash (`#/`, `#/settings`, `#/course/...`,
  `#/topic/...`).
- Tudo local; os únicos acessos externos possíveis são o teste de conexão do
  LLM e a correção opcional de legendas (quando configurados).

## 3. Estrutura de diretórios e dados de runtime

```text
Biblioteca/                  ← ROOT (pasta-pai do app; biblioteca padrão)
├── Curso A/
└── _LocalPlayer/            ← o app
    ├── server.js, package.json, README.md, CLAUDE.md
    ├── public/              ← SPA (index.html, app.js, scope.js, styles.css)
    ├── data/                ← runtime (gitignored)
    │   ├── progress.json (+ .bak, .corrupt-<ts>, .tmp órfãos)
    │   ├── libraries.json   ← registro das bibliotecas
    │   ├── ai-config.json   ← config de IA (chaves SÓ aqui)
    │   ├── transcoded/      ← cache de vídeos convertidos
    │   └── subtitles/       ← raw/, processed/, edited/, backup/, jobs.json, <hash>.vtt
    ├── test/                ← testes node:test
    └── docs/
```

- `ROOT = path.resolve(__dirname, "..")` — derivado da localização do app,
  nunca hardcoded. `APP_DIR_NAME` = nome da pasta do app, ignorado no scan.
- `data/` pode ser redirecionado com `LP_DATA_DIR` (usado pelos testes).
- `bin/` + `models/` (gitignored) — instalação **manual** do whisper
  (`whisper-cli*`, `ggml-*.bin`); nada é baixado pelo projeto.
- O servidor **não** escreve log em arquivo (só stdout); `GET /api/logs` serve
  um anel em memória.

## 4. Scan e árvore de conteúdo

O scanner (`scanDir`/`scanLibrary`) transforma o disco em uma árvore de nós:

```js
{ type: "folder", name, path, title, children, videoCount, coverImage }  // curso/módulo
{ type: "topic",  name, path, title, children, videoCount, coverImage }  // pasta marcada
{ type: "video",  name, path, ext, size, title }                          // aula
{ type: "file",   name, path, ext, size }                                 // material não-vídeo
```

Regras:

- Exclusões no scan: pasta do app (só na raiz da biblioteca padrão), entradas
  com prefixo `.`, extensões em `IGNORED_EXT` (`.ini`, `.db`, `.lnk`).
- Extensões de vídeo reconhecidas: `VIDEO_EXT` = `.mp4 .mkv .webm .mov .avi
  .m4v .wmv`. Imagens (`IMAGE_EXT`) são usadas como capas quando o nome contém
  uma dica.
- Ordenação: `localeCompare(..., "pt-BR", {numeric:true, sensitivity:"base"})`.
- Árvore cacheada em `treeCaches` (Map **por biblioteca**, persistido em
  `data/tree-cache-<libId>.json` para boot instantâneo); rescan via
  `GET /api/tree?rescan=1` ou `POST /api/rescan` (todas) /
  `POST /api/libraries/:id/rescan` (uma). Uma biblioteca indisponível não
  corrompe o cache das demais.

### Capas

`pickCoverImage` procura na pasta imagens cujo nome contenha uma dica de
`COVER_NAME_HINTS` (`cover`, `thumbnail`, `poster`, `banner`, `image`, `img`);
`chooseCoverImage` permite herdar a capa de uma pasta filha. Sem imagem →
gradiente com iniciais no frontend. A imagem de capa é **excluída** dos
materiais e da busca.

## 5. Tópicos por marcador explícito

Classificação **sem inferência estrutural** (nenhuma heurística de conteúdo,
profundidade ou contagens):

> pasta é **tópico** se contém o arquivo `.topic` **ou** o nome real termina
> com `(TP)` (regex `\(TP\)\s*$` com `i`); senão é `folder` (curso/módulo).

- `Projeto TP`, `(TP) Curso`, `Aula TP avançado` **não** são tópicos.
- O `.topic` é dotfile: ignorado no scan/static, nunca aparece na árvore,
  busca, materiais nem contagens. `(TP)` e a numeração inicial são removidos
  **apenas** do título exibido; o `name` real nunca muda.
- O marcador vence conteúdo direto: `Híbrido/{.topic, aula.mp4}` é tópico (o
  vídeo continua como filho).
- Roteamento: `#/topic/<path>` e `#/course/<path>` caem no mesmo parse;
  `renderCourse` resolve o nó e, se `type === "topic"`, delega a `renderTopic`
  (links legados `#/course/<tópico>` degradam bem).
- Busca acha tópicos (resultado `#/topic/`); `.topic` nunca é resultado.
- Favoritos continuam **só em cursos**; tópico não agrega progresso.
- Como criar: arquivo vazio `ROOT/<pasta>/.topic`, ou renomear a pasta com o
  sufixo `(TP)` no final.

## 6. Bibliotecas externas

Registro em `data/libraries.json` (`{libraries:[{id,name,path,enabled,isDefault,createdAt}], updatedAt}`),
lazy e memoizado (`loadLibraries`); corrompido → preservado como `.corrupt-<ts>`
e re-semeado. A **padrão** (`id = "default"`) tem path **imutável** (`ROOT`);
externas têm id `randomUUID` (estável a renomeação).

**Validação de path** (`validateLibraryPath`): string obrigatória, sem NUL,
**absoluto** obrigatório, `fs.realpath` (canônico), e rejeição de:

- diretórios proibidos: pasta do app (`__dirname`), `public/`, `node_modules/`, `data/`;
- **aninhamento** com biblioteca existente (igual, ancestral ou descendente).

O path validado é usado uma única vez no registro; operações de mídia sempre
resolvem contra o path canônico da biblioteca (`resolveLibraryRel`).

**Escopo por biblioteca** (chaves/caches):

- Progresso: `libId\0rel`; favoritos: `libId\0path` (chaves legadas sem `\0`
  migram para `default\0...` no boot, idempotente).
- Transcode/legendas: `sha1(libId\0rel)[0:24]` — o mesmo rel em bibliotecas
  distintas não colide.
- VTT canônico de legenda: `<lib.path>/<curso>/.courseplayer/subtitles/<hash>.vtt`.

**Remoção é config-only** (`DELETE /api/libraries/:id`): nunca toca filesystem;
progresso/caches permanecem (readição pelo mesmo path reusa tudo). Bloqueios:
padrão → 403; jobs ativos (transcode/legenda em execução, scan em andamento) →
409; jobs apenas enfileirados são descartados. Scan é **sequencial**
(deliberado, para não martelar o barramento em pendrives).

**Media**: `/media/<rel>` (padrão) ou `/media/<libId>/<rel>` (externa);
`parseMediaRequest` resolve a biblioteca. `requestLibrary` deriva a biblioteca
da query/body; id desconhecido → **400** (nunca degrada para a padrão).

## 7. Normalização de títulos

`normalizeDisplayTitle` (**no servidor**): `name` nunca muda (dirige
ordenação/busca). Remove prefixos simbólicos, rótulos (`Aula 03 - `,
`Módulo 1 - `), sufixos de autoria (` - By @canal`), numeração inicial
(conservadora: `3D Modelagem` sobrevive), truncamentos, `~1`, tags,
sublinhados; capitalização de sentença pt-BR preservando siglas/nomes (SQL,
Python, Node.js; `"ti": "TI"` em `TITLE_KEEP_CASE`). Módulos mantêm o número
de exibição; tópicos/aulas removem. O frontend só valida
(`validateDisplayTitle`, avisa no console).

## 8. Segurança

Mecanismos implementados (todos verificáveis no código):

- **Path traversal**: todo path de cliente passa por `resolveSafeRelPath()`
  (normaliza → resolve contra a base da biblioteca → exige que o resultado
  esteja dentro da base) ou `resolveLibraryRel(lib, rel)`; resultado `null` →
  **400/404**. O navegador nunca envia path absoluto — a âncora é a config.
- **Symlink/junction**: `resolveSafeRelPath` é lexical; `fileWithinLibrary(lib,
  abs)` faz `realpath` do arquivo e do path da biblioteca e exige contenção. É
  aplicado em **todo** ponto que ABRE arquivo da biblioteca (`/media`,
  fallback/ffprobe, pipeline de legendas). Scan não indexa links.
- **Pasta do app**: `isAppDirRel` bloqueia o primeiro segmento com o nome da
  pasta do app, só na biblioteca padrão. Dotfiles → 404 (`hasDotSegment`).
- **Conteúdo ativo**: materiais com extensões em `ACTIVE_EXT`
  (`.html .htm .xhtml .svg .xml .js .mjs .json`) são servidos como
  `attachment` + `X-Content-Type-Options: nosniff` — nunca renderizados no
  origin da app.
- **`/transcoded/*`**: não aceita path de usuário; o nome é validado por regex
  estrita `^[0-9a-f]{24}\.mp4$`.
- **Chaves de IA**: só no backend (`data/ai-config.json`); `GET /api/ai/*`
  devolve apenas `hasApiKey`; logs nunca imprimem chave/token/prompt.
- **CSP**: a SPA é servida com `Content-Security-Policy` restritiva
  (`default-src 'self'` etc.).
- **Sem `express.static(ROOT)`**: a pasta do app não vaza por `/media/*`
  (BUG-001 corrigido); `express.static(public)` serve apenas a SPA.
- **Rede**: `app.listen(PORT)` escuta em todas as interfaces por padrão —
  outros dispositivos da mesma rede abrem a interface. Restringir com
  `HOST=127.0.0.1` não é uma garantia de isolamento; é um limitador de
  exposição.

> Regra para quem mexer: **todo** endpoint novo que aceite path do cliente
> passa por `resolveSafeRelPath()`/`resolveLibraryRel()`, e todo ponto que
> ABRE arquivo da biblioteca exige `fileWithinLibrary()`.

## 9. API

Rotas de legendas/IA → `docs/SUBTITLES.md`.

| Método | Rota | Propósito |
| --- | --- | --- |
| `GET` | `/api/tree?rescan=1` | Árvores por biblioteca (cacheadas; `rescan=1` força todas) |
| `POST` | `/api/rescan` | Força scan de todas + enfileira P2/P3 de legendas |
| `GET` | `/api/libraries` | Lista bibliotecas (resumo) |
| `POST` | `/api/libraries` | Cria externa `{name?, path}` → 201/400 |
| `PATCH` | `/api/libraries/:id` | Renomeia/ativa/desativa/altera path (padrão: path imutável → 403) |
| `DELETE` | `/api/libraries/:id` | Remove da config (config-only; jobs ativos → 409; padrão → 403) |
| `POST` | `/api/libraries/:id/rescan` | Re-escaneia uma biblioteca (dedup → 409) |
| `GET` | `/api/progress` | Todo o progresso (`{ "libId\0rel": {position,duration,completed,updatedAt} }`) |
| `POST` | `/api/progress` | Salva 1 aula (`libraryId` via query/body) |
| `POST` | `/api/progress/clear` | Limpa por curso/prefixo ou global |
| `GET` | `/media/*` | Original (vídeo/material) via `sendFile`, Range/206 |
| `GET` | `/api/video/fallback?path=` | Plano de transcoding (`compatible`/`status:'transcoding'\|'ready'`/`error`) |
| `GET` | `/transcoded/<24-hex>.mp4` | Cache de transcode (final ou `.tmp` em crescimento) |
| `POST` | `/api/transcode/clear` | Limpa `data/transcoded/` e cancela jobs; **nunca toca progresso** |
| `GET` | `/api/ai/status` | Estado real da IA (providers ASR/LLM, `hasApiKey`) |
| `GET` | `/api/ai/config` | Config de IA **mascarada** (só `hasApiKey`) |
| `POST` | `/api/ai/config` | Merge parcial + salva (`apiKey` seta, `clearApiKey` limpa) |
| `POST` | `/api/ai/reset` | Volta a config de IA ao padrão |
| `POST` | `/api/ai/llm/test` | Testa conexão LLM (mensagem mínima) |
| `GET` | `/api/storage/status` | Tamanhos de `data/`, transcode, legendas; espaço livre do workspace |
| `GET` | `/api/system/status` | Estado do sistema (biblioteca/dispositivo/app; `no-store`) |
| `GET` | `/api/logs` | Logs técnicos em memória (anel; filtros `?level=`/`?q=`) |

Respostas-chave de `/api/video/fallback`:

```jsonc
{ "compatible": true, "url": "/media/<rel>" }                        // toca direto
{ "compatible": false, "status": "ready", "url": "/transcoded/<h>.mp4" }
{ "compatible": false, "status": "transcoding", "url": "/transcoded/<h>.mp4" }
{ "error": true, "message": "..." }
```

## 10. Persistência de progresso

O progresso é salvo diretamente na raiz de cada biblioteca em
**`<lib.path>/.courseplayer/progress.json`** (com chaves relativas portáteis
`rel`), viajando com a biblioteca (HD/SSD/pendrive). Um espelho consolidado
é mantido em `data/progress.json` (chaveado por **`<libraryId>\0<rel>`**).
Valor: `{position, duration, completed, updatedAt}`.

Garantias (implementadas em `server.js`):

- **Escrita atômica e durável** (`writeFileAtomic`): tmp exclusivo → `fsync` →
  `rename` → `fsync` do dir (best-effort). `.tmp` órfãos limpos no boot.
- **Fila serializada** (`updateProgress`): read-modify-write encadeado em
  promises; `shuttingDown` rejeita novos saves e drena a fila no shutdown
  (`SHUTDOWN_PROGRESS_FLUSH_MS`).
- **Backup + auto-recuperação**: `progress.json.bak` (e `.bak.1`, rotação)
  guardam o estado pré-mudança tanto na biblioteca quanto no espelho central;
  no boot, `restoreProgressFromBackup` recria o main a partir do melhor backup
  se ausente/corrompido; corrompidos são preservados como `.corrupt-<ts>` (nunca
  apagados).
- **Guarda regressiva por conteúdo**: um save normal nunca remove chaves, não
  zera estado não-vazio, não regride `completed` (true→false exceto toggle
  explícito do ✓), não perde `duration`/`position` válidas — regressão é
  rejeitada e o estado persistido preservado. Redução de posição é permitida
  (reassistir/voltar). Clear explícito é o único caminho destrutivo.
- `POST /api/transcode/clear` e scans/rescan **nunca** tocam `progress.json`.
- Sem escritor inesperado: `{}` só é gravado por clear explícito; não há
  filtragem contra a árvore nem pruning de órfãos.

Regras finas do frontend (`setupVideoTracking`): `timeupdate` (throttle 5s),
`pause`, `ended` (conclui + avança, só com `wasPlaying`), `beforeunload`/hidden
flush via `sendBeacon`. Auto-conclusão >95%; reassistir concluído mantém
conclusão; posição 0 não apaga; sem metadata não grava. Retomada: seek em
`loadedmetadata` quando `3 < position < duration-2`.

## 11. Transcoding de fallback

Só após `error` no `<video>` → `/api/video/fallback` → ffprobe (`probeMedia`,
com fallback para stderr do ffmpeg). **Compatível** é servido direto — a
decisão nunca é pela extensão (mp4/mov/m4v/webm/ogg + h264/vp8/vp9/av1/theora +
aac/mp3/opus/vorbis/flac ou sem áudio).

- **Cache**: `data/transcoded/sha1(libId\0rel)[0:24].mp4`, invalidação por
  mtime do original; `.tmp` só vira final via `rename` após exit 0.
- **Jobs**: `transcodeJobs` (dedup) + fila FIFO; `MAX_CONCURRENT_TRANSCODES`
  (default 1); enfileirados órfãos há 120s são cancelados.
- **Streaming progressivo**: MP4 fragmentado (`-movflags
  frag_keyframe+empty_moov+default_base_moof`) → serve o `.tmp` em crescimento;
  seek além do convertido espera `TRANSCODE_SEEK_WAIT_MS` (60s) e responde 416.
  `+faststart` deliberadamente não usado.
- Args fixos sem shell: `-c:v libx264 -preset veryfast -crf 23 -pix_fmt
  yuv420p -c:a aac -b:a 128k -progress pipe:1 -loglevel error`; progresso
  logado em passos de 25%. Sem ffmpeg → mensagem clara, não 500 cru.
- **Contrato frontend**: o MESMO `<video>` tem `src` trocado (preserva
  GainNode/listeners); posição/volume reaplicados quando a região fica
  `buffered`; badge não-bloqueante + "Tentar novamente" em falha.

## 12. Legendas por IA

Pipeline: extração de áudio (ffmpeg → WAV 16kHz mono PCM16) → whisper.cpp →
transcrição bruta → pós-processamento determinístico → correção LLM opcional +
guardrail → WebVTT → cache. **Adicional**: sem binário/modelo/LLM/chave/
internet o player funciona normal. Detalhe completo (registry, fila P0–P3,
preempção, estado/retomada, raw-sourced gate, cache/artefato, correção LLM,
concorrência, player, segurança, env vars, editor desativado): **`docs/SUBTITLES.md`**.
Instalação do whisper: **`docs/whisper.md`**.

Resumo:

- Registry data-driven é a fonte de verdade dos providers ASR/LLM.
- Fila P0–P3 (menor vence): P0 demanda, P1 próxima aula, P2 1ª aula de cada
  curso pós-scan, P3 background (`BACKGROUND_BATCH`=20). **Nunca** gerar a
  biblioteca inteira.
- VTT canônico em `<lib>/.courseplayer/subtitles/<hash>.vtt` (ignorado pelo
  scan) + espelho `data/subtitles/`.
- Concorrência: transcode e whisper compartilham `heavySlots`; LLM não.
- Player: overlay `.subtitle-overlay` (nunca `<track>`), badge, botão; nunca
  bloqueia `video.play()`.

## 13. Frontend

### Roteamento e estado

- Hash routing (`route()`): `#/` home, `#/settings`, `#/course/<path>` /
  `#/topic/<path>` (mesmo parse; `renderCourse` delega a `renderTopic` se
  `type === "topic"`), com prefixo opcional de biblioteca `<libId>/`.
- Estado global `state` (árvores por biblioteca, progresso, flatVideos, aula
  atual). `loadAll()` anota `libId` em cada nó (`annotateLibId`) e sanea o
  progresso. localStorage **só** para preferências (favoritos, aparência do
  player, volume/ganho/mudo/velocidade, modo de progresso, atalhos).
- Helpers puros em `public/scope.js`: `isDescendantPath`,
  `isSidebarNavigableNode`, `collectCoursesInScope`, `collectDirectCourses`,
  `flattenVideos`, `buildContinueItems` (sem DOM/estado).

### Home e tópicos

- **Home**: cards de curso e tópico (por marcador), capa ou gradiente,
  favoritos ao topo (só cursos), busca accent-insensitive.
- **Escopo contextual**: "Seu progresso" = cursos **diretos** da raiz
  (`collectDirectCourses`); sem curso direto na raiz (biblioteca toda em
  tópicos), cai para o **global** (`collectCoursesInScope`) — o bloco nunca
  some por estrutura. "Continuar assistindo" = **global** (todas as
  bibliotecas, até 8 itens, um por curso; `position > 5 && !completed`).
  Dentro de um tópico, ambos consideram **só a subárvore**
  (`collectCoursesInScope(topicNode)`), recursivo em tópicos aninhados;
  comparação por segmentos (`isDescendantPath`): `TI` não alcança `TI2`.
  Curso ausente da árvore não é exibido, mas o progresso persistido permanece.

### Curso / player

- **Curso** (`renderCourse`): toolbar (favoritar, limpar progresso, gerar
  legendas), player, cabeçalho da aula (breadcrumb + Anterior/Próxima),
  sidebar de navegação + progresso, "Materiais da aula" abaixo do player.
  `expandedFolders` em memória (não persistido); `closeOtherModules` = acordeão.
- **Sidebar = navegação de aulas**: só `isSidebarNavigableNode`
  (`folder`/`topic`/`video`); `type === "file"` nunca vira item de
  sidebar/aula/prev-next/avanço pós-`ended`/contagem — materiais vivem
  exclusivamente em "Materiais da aula" e na busca.
- **Seleção de aula**: `lessonPath` explícita → mais recente em andamento
  (`position > 5 && !completed`, por `updatedAt`) → 1ª não concluída → 1ª vídeo.
- **Áudio**: `video.volume` até 100%; excesso (100–200%) via GainNode do Web
  Audio (AudioContext único; recria só o source na troca de `<video>`).
  Velocidade 0.5–2× persistida.
- **Atalhos configuráveis**: 14 ações em `DEFAULT_SHORTCUTS` (modo captura,
  conflito rejeitado, pulados em inputs, `Esc` fecha popovers); reconhecidos
  por `event.key`.
- **Configurações**: limpar progresso global, limpar transcode,
  `closeOtherModules`, atalhos, Central de IA (6 abas). Ações destrutivas com
  `openConfirmDialog`.

### Mobile

- Drawer de aulas (`drawer-open`), fecha ao tocar fora/selecionar/Esc.
- ≤600px: cabeçalho da aula reorganizado (título + `☰ Aulas`, breadcrumb
  compacto, Anterior/Próxima em linha própria), ações secundárias no menu ⋮,
  controles do player em uma linha.
- `overscroll-behavior-y: none` em `html, body` (≤900px) desativa o
  pull-to-refresh nativo (evita o efeito de "encolher" o player no Android).
- `.player-wrap` usa `aspect-ratio: 16/9` + `max-height: min(72vh, 780px)` /
  `min(72svh, 780px)` (svh = estável; não reage à barra de URL no landscape).

## 14. Variáveis de ambiente

Lidas pelo processo (`server.js`); todas opcionais:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `4173` | Porta do servidor |
| `HOST` | todas as interfaces | Interface de escuta |
| `LP_DATA_DIR` | `data/` | Redireciona os dados de runtime (testes) |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Caminho dos binários (aceita espaços) |
| `MAX_CONCURRENT_TRANSCODES` | `1` | Conversões simultâneas |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | `1` | Transcrições whisper simultâneas |
| `MAX_CONCURRENT_AI_JOBS` | `1` | Slots `heavySlots` (transcode + whisper), máx. 8 em runtime |
| `BACKGROUND_SUBTITLE_GENERATION` | config da Central de IA | `true`/`1` liga geração P3 em background |
| `WHISPER_BIN` | `whisper-cli*` em `bin/` | Caminho do binário whisper |
| `WHISPER_MODEL_DIR` | `models/` | Pasta com `ggml-*.bin` |
| `LP_PROGRESS_FORENSIC` | (inativo) | `1` liga instrumentação `[PROGRESS-WRITE]`/snapshots |

## 15. Invariantes

Ver `CLAUDE.md` (lista operacional). Destaques: ROOT derivado de `__dirname`;
todo path passa por `resolveSafeRelPath()`/`resolveLibraryRel()`; remoção de
biblioteca config-only; chaves/caches escopados por biblioteca; rel paths
sempre `/`; sem symlink/junction (tudo que abre arquivo exige
`fileWithinLibrary()`); conteúdo ativo servido como `attachment` + `nosniff`;
persistência atômica+fila+backup; transcode/clear nunca toca progresso; legenda
nunca é dependência do player; `type` (nunca extensão) decide sidebar.
