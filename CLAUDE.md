# CLAUDE.md

Este arquivo orienta Claude Code (claude.ai/code) no trabalho com este repositório. Foi reescrito a partir de auditoria do código real (`server.js`, `public/`, `package.json`) — o código é a fonte de verdade.

> Documentação profunda (detalhe de implementação) foi movida para `docs/` — **leia o ponteiro antes de mexer no subsistema**: `docs/DOCUMENTACAO.md` (scan, API, media, persistência, transcoding), `docs/SUBTITLES.md` (pipeline de legendas + editor), `docs/VALIDACAO.md` (checklist de validação), `docs/whisper.md` (instalação do whisper.cpp), `docs/BIBLIOTECAS.md` (bibliotecas externas configuráveis).

## Projeto

O **Local Player** é um player local/offline para organizar e reproduzir conteúdo de mídia armazenado em disco (HDs externos / pendrives). Ele pode estruturar qualquer biblioteca de conteúdo em pastas — cursos, aulas, treinamentos, vídeos educacionais, coleções de vídeo. Escaneia a árvore de pastas, serve vídeos/materiais diretamente do disco, persiste progresso por aula e oferece busca, favoritos e atalhos de teclado. Um **fallback de transcoding** (ffmpeg) converte apenas os formatos que o navegador não reproduz; originais compatíveis nunca tocam o ffmpeg. Gera também **legendas automáticas por vídeo** (ASR local Whisper + correção LLM opcional) — recurso adicional, nunca dependência do player.

**Navegação hierárquica por tópicos**: pastas marcadas **explicitamente** como tópico viram **tópicos navegáveis** — um card que abre a lista de filhos com breadcrumb (`Home › TI › Python`) em profundidade arbitrária. Só quando se chega num **curso** (pasta normal) a experiência atual do player abre. A estrutura física de diretórios é a fonte de verdade (sem taxonomia paralela). Regra e detalhes: `docs/TOPICOS-MARCADORES.md`.

- **Backend**: arquivo único Node.js + Express (`server.js`), sem build step.
- **Frontend**: SPA em HTML/CSS/JS puro em `public/`, sem build step, sem framework.
- **Texto de UI, README e comentários em pt-BR** — mantenha novas strings de UI em português.

## Comandos

```bash
npm install --no-bin-links   # instala dependências (--no-bin-links ajuda em drives externos/FAT/exFAT)
npm start                    # inicia o servidor (scripts.start = "node server.js")
```

- Escuta em `http://localhost:4173` (sobrescreva com a env `PORT`). Por padrão
  escuta em todas as interfaces (acesso pela rede local é comportamento
  documentado); para restringir à máquina local, use `HOST=127.0.0.1`.
- **Sem linter, sem build step**. Verificação rápida de sintaxe: `node --check server.js public/app.js public/scope.js`. Testes: `node --test test/progress.test.js test/topics.test.js test/libraries.test.js test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js` (integridade do progresso + tópicos por marcador + bibliotecas externas + escopo contextual + sidebar/materiais; progresso e o smoke de sidebar sobem o servidor real com `LP_DATA_DIR` num diretório temporário; os demais são puros, sem DOM). Para validar comportamento, rode o servidor e exercite a UI (ou `curl` as rotas da API). Checklist completo: `docs/VALIDACAO.md`.
- **`LP_DATA_DIR`** (env, opcional): aponta progresso/caches/config de IA para outro diretório (`data/` por padrão). Usada pelos testes para rodar em sandbox sem tocar o `data/` real; uso normal não define a env.
- Dependência real: **Express** (`^4.19.2`, instalado 4.22.2). Não adicione dependências sem justificativa forte.

## Multiplataforma (Linux + Windows)

O mesmo código roda em Linux e Windows, sem scripts separados. Regras a manter:

- **Caminhos**: sempre as APIs de `path` (`path.join`, `path.resolve`, `path.basename`, `path.dirname`, `path.extname`). Nunca concatene separador manualmente (`folder + "/" + file`). Não assuma `/tmp`, `~`, `/home`, `C:\` nem `D:\`.
- **Rel paths canônicos**: paths relativos da árvore, chaves de progresso e URLs usam **sempre** `/`. `resolveSafeRelPath()` devolve `rel` com `/` (no Windows `path.normalize` produziria `\` e quebraria a correspondência com o scan); `abs` mantém o separador nativo para o filesystem.
- **Subprocessos**: `spawn`/`execFile` com array de args e **sem `shell: true`** (nada de `bash`, `rm`, `export`, quoting). `FFMPEG_BIN`/`FFPROBE_BIN` aceitam caminho completo com espaços (`C:\ffmpeg\bin\ffmpeg.exe`); bare `ffmpeg`/`ffprobe` funcionam se estiverem no PATH.
- **Filesystem**: `fs.rename` sobrescreve o destino no Windows (MoveFileEx); `fsync` de diretório é best-effort (falha no Windows e é ignorado). Não dependa de permissões Unix (`chmod`, UID/GID) nem de symlinks.
- **Case sensitivity**: Linux é case-sensitive, Windows não. Não crie lógica que dependa de maiúsculas/minúsculas (comparações de extensão já usam `toLowerCase()`).
- **Temporários/cache**: progresso, cache, backups e config de IA ficam em `data/` (dentro da pasta do app). Exceção única e intencional: o **workspace temporário do pipeline de legendas** (WAV de extração + saída do whisper) usa `os.tmpdir()/local-player-workspace` por padrão (configurável pela Central de IA) — para não martelar o pendrive com arquivos grandes. Fora isso: sem `/tmp`, sem `~/.config`.
- **Frontend**: URLs sempre `/`, encoding por segmento (`encodeURIComponent`); atalhos reconhecidos por `event.key` (configuráveis, então suportam ABNT2/americano); fullscreen via API padrão do navegador (nunca capturar F11).

## Arquitetura

### Raiz da biblioteca & scan

- `server.js` escaneia `ROOT = path.resolve(__dirname, "..")` — o diretório que contém todas as pastas de curso. **Nunca hardcode a raiz**; ela deriva da localização do app para que o app possa ser copiado para qualquer drive.
- **Bibliotecas externas configuráveis** (feature de múltiplas bibliotecas): além da raiz padrão, bibliotecas extras são registradas pelo frontend em `data/libraries.json` (`{libraries:[{id,name,path,enabled,isDefault,createdAt}],updatedAt}`, lazy e semeado com a padrão). `validateLibraryPath` exige path **absoluto**, faz realpath (symlink/junction), proíbe `__dirname`/`public`/`node_modules`/`data` e rejeita aninhamento com bibliotecas existentes. A **padrão** tem path **imutável** (`ROOT`); ids de externas são `randomUUID` (estáveis). Scan **sequencial** das habilitadas; `GET /api/tree` retorna `{libraries:[summary...]}`. Media/transcode/legendas/progresso/favoritos escopados por biblioteca (`libId\0rel`). Resumo completo: `docs/BIBLIOTECAS.md`.
- A pasta do próprio app (`_LocalPlayer`, via `APP_DIR_NAME = path.basename(__dirname)`) é excluída do scan, assim como entradas com prefixo `.` e arquivos com `IGNORED_EXT` (`.ini`, `.db`, `.lnk`). Imagens de capa são excluídas dos materiais e da busca.
- `scanDir()` monta a árvore recursivamente. Tipos de nó: `folder` (curso/módulo — comportamento normal), `topic` (marcado explicitamente), `video`, `file` (material não-vídeo). Ordenação natural por `localeCompare(..., "pt-BR", { numeric: true, sensitivity: "base" })`.
- **Regra tópico-vs-curso (explícita, sem inferência estrutural)**: uma pasta é **tópico** se existir o arquivo `.topic` dentro dela **ou** se o nome real terminar com `(TP)` (regex `\(TP\)\s*$`, case-insensitive). **Senão**, é `folder` (curso/módulo) — conteúdo direto, subpastas, profundidade e contagens de vídeo/aula **não** influenciam. O marcador `.topic` é um dotfile (ignorado pelo scan e pelo static `dotfiles: "ignore"`): nunca vira material, resultado de busca nem entra em contagens; não confundir com `.courseplayer` (pasta de artefatos de legenda, propósito diferente). `(TP)` é removido **só** do título de exibição em `normalizeDisplayTitle` (o `name` real permanece; vídeos não são afetados).
- A árvore é cacheada em `treeCache` (com `scannedAt`); `GET /api/tree?rescan=1` ou `POST /api/rescan` força novo scan.
- **Capas**: cada pasta escolhe uma capa das próprias imagens por nome (dicas: `cover`, `thumbnail`, `poster`, `banner`, `image`, `img`) ou herda de pasta filha. Capa direta pontua 200, capa de filho 50. Sem imagem, o frontend renderiza um gradiente determinístico com as iniciais do curso.

### Normalização de títulos

- Todo nó da árvore carrega um `title` de exibição calculado no servidor por `normalizeDisplayTitle()` (cursos, módulos e aulas). O `name` original do arquivo/pasta **nunca** é alterado — ele continua dirigindo ordenação e indexação de busca.
- Pipeline: remove prefixos simbólicos (`==`, `###`, `--`, `**`, `>`, `_`, `=`), rótulos (`Aula 03 - `, `Módulo 1 - `), sufixos de autoria (` - By @canal`), numeração inicial, truncamentos (`Arq...` → `Arq`), artefato `~1` (8.3), tags `[PROJETO]`, sublinhados entre palavras, separadores soltos; aplica capitalização de sentença pt-BR preservando nomes próprios/siglas (`TITLE_KEEP_CASE`: SQL, Python, PostgreSQL, Node.js, NumPy, etc.).
- Remoção de numeração é conservadora: números de conteúdo sobrevivem (`3D Modelagem`, `4K Vídeos`, `9.5 título`). Módulos mantêm o número de exibição (`keepNumber` → `"01 - Título"`); tópicos e aulas removem a numeração inicial (`1. Language` → `Language`, primeira letra sempre maiúscula via `toDisplayCase`).
- O frontend também valida títulos em `validateDisplayTitle` (só avisa no console — não oculta nada).

### API (`server.js`)

Rotas principais. Rotas de legendas/IA → `docs/SUBTITLES.md`.

| Rota | Propósito |
| --- | --- |
| `GET /api/tree?rescan=1` | Árvores por biblioteca (cacheadas) → `{libraries:[summary...]}` |
| `POST /api/rescan` | Força novo scan de todas, retorna `{libraries:[...]}` |
| `GET /api/libraries` | Summary das bibliotecas (sem cache → status `unknown`) |
| `POST /api/libraries` | Cria `{name?, path}` (path validado/canonicalizado uma vez) → 201 |
| `PATCH /api/libraries/:id` | `{name?, enabled?, path?}`; path da padrão é imutável (403) |
| `DELETE /api/libraries/:id` | Remove da **configuração** (nunca aceita path; padrão→403; jobs ativos→409; enfileirados descartados) — **nunca toca arquivos** |
| `POST /api/libraries/:id/rescan` | Reescanela UMA biblioteca (409 se já em andamento; dir sumiu → 200 `unavailable`) |
| `GET /api/progress` | Todo o progresso salvo (chaves `libId\0rel`) |
| `POST /api/progress` | Salva `{path: <rel>, position, duration, completed}` de uma aula (+ `libraryId` p/ externa; a chave é derivada) |
| `POST /api/progress/clear` | Limpa progresso de um curso (`coursePath`, rel) ou de tudo (body vazio); `libraryId` opcional |
| `GET /media/*` | Serve originais por biblioteca com Range — `/media/<rel>` (padrão) ou `/media/<libId>/<rel>` (externa) |
| `GET /api/video/fallback?path=<rel>` | Plano de transcoding: `{compatible:true,url}` \| `{compatible:false,status:'transcoding'\|'ready',url}` \| `{error,message}` |
| `GET /transcoded/<24-hex>.mp4` | Serve o cache de transcode: arquivo final (Range completo) ou `.tmp` em crescimento (progressivo) enquanto o job roda |
| `POST /api/transcode/clear` | Apaga `data/transcoded/` e cancela jobs; **nunca toca `progress.json`** |

- `app.use(express.json({ limit: "100kb" }))`.
- **Segurança de path**: todo path vindo do cliente passa por `resolveSafeRelPath()`, que rejeita qualquer coisa que escape de `ROOT`. Aplique a novos endpoints que recebam paths.
- **Media**: `/media/*` é resolvido por biblioteca (`parseMediaRequest`: primeiro segmento que casa id de externa vira prefixo; senão, padrão) + `res.sendFile()` (express/send trata `Range` → 206, `Content-Length`, `Content-Type` — o que o `<video>` precisa para seek/buffer). Vídeos e materiais seguem o mesmo caminho; originais nunca são processados. **BUG-001 corrigido**: não existe mais `express.static(ROOT)` — a pasta do app é bloqueada **só na biblioteca padrão** (`isAppDirRel`) e segmentos dotfile → 404 (`hasDotSegment`).
- `/transcoded/*` valida o nome com regex estrita `^([0-9a-f]{24})\.mp4$` (nunca um path do usuário); `.tmp` órfão sem job → 404.
- `express.static(public)` por último serve a SPA.

### Persistência de progresso & durabilidade

- Progresso em `data/progress.json`, chaveado pelo path relativo à biblioteca da aula → `{position, duration, completed, updatedAt}`. Gitignored.
- **Escrita atômica e durável** (`writeFileAtomic`): conteúdo → arquivo temporário exclusivo → `fsync` → `rename` sobre o destino → `fsync` do diretório (best-effort). Sobrevive a crash, queda de energia e desmontagem do pendrive no meio da escrita.
- **Fila serializada** (`updateProgress`, cadeia de promises): torna o read-modify-write atômico e evita colisão no arquivo temporário. Uma escrita que falha não trava a fila (a rota responde 500).
- **Backup + auto-recuperação** (`readProgress`/`initPersistence`): antes de sobrescrever, o último estado válido é copiado para `progress.json.bak`. Se `progress.json` estiver com JSON inválido, ele é renomeado para `progress.json.corrupt-<timestamp>` e o estado é restaurado do backup; se o backup também estiver corrompido, é preservado do mesmo jeito e o progresso começa vazio. `.tmp` órfãos (de escritas interrompidas e de transcodes) são limpos no boot. Na primeira execução, o backup é semeado com o estado atual.
- `POST /api/progress/clear` remove por prefixo de chave do curso (`<coursePath>/`), limpando aulas aninhadas juntas.

### Transcoding de fallback

Arquivos compatíveis com o navegador são servidos direto e **nunca** transcodificados. Quando o `<video>` dispara `error` no original, o frontend chama `/api/video/fallback`; o servidor analisa com **ffprobe** (`probeMedia`, fallback para o stderr de `ffmpeg -i`) e só então inicia o job.

- **Conjunto de compatibilidade** (`isBrowserCompatibleVideo`): contêineres `mp4/mov/m4v/webm/ogg` + vídeo `h264|vp8|vp9|av1|theora` + áudio `aac|mp3|opus|vorbis|flac` (ou sem áudio). Decisão nunca pela extensão.
- **Cache**: `data/transcoded/<sha1(rel).slice(0,24)>.mp4` — determinístico, path-safe, sem colisão entre cursos. Invalidado por **mtime** (`final.mtimeMs >= orig.mtimeMs`). `ffmpeg` escreve `<nome>.mp4.tmp`; `fs.rename(tmp→final)` só após exit 0 — um parcial nunca é servido como final.
- **Jobs & concorrência**: `transcodeJobs` Map (um ffmpeg por vídeo, deduplicado) + `transcodeQueue` FIFO; no máximo `MAX_CONCURRENT_TRANSCODES` (default 1) rodam de uma vez. Jobs enfileirados sem consumidor há 120s são cancelados (verificado a cada 60s).
- **Streaming progressivo** (tocar antes da conversão terminar): a saída usa **MP4 fragmentado** `-movflags frag_keyframe+empty_moov+default_base_moof` — o init box é escrito primeiro, então o servidor pode servir o `.tmp` em crescimento (`serveGrowingFile`/`streamGrowingFile`) e o navegador começa a tocar em segundos. `-g 60` ≈ fragmentos de 2s. `+faststart` é deliberadamente **não** usado (exigiria segundo passe, dobrando o tempo). Durante a conversão, seek além do já convertido espera até `TRANSCODE_SEEK_WAIT_MS` (60s) e então responde 416; reprodução sequencial é contínua. Arquivos completos são servidos via `sendFile` com seek total.
- **Args do ffmpeg** (fixos, sem shell): `-y -i <src> -map 0:v:0 -map 0:a:0? -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g 60 -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 -progress pipe:1 -nostats -loglevel error`. Progresso é parseado do `-progress` (`out_time_us`/`out_time_ms`), logado em passos de 25% (`[TRANSCODE] progresso N%`).
- **Env vars**: `FFMPEG_BIN`/`FFPROBE_BIN` (default `ffmpeg`/`ffprobe` do PATH, nunca hardcoded), `MAX_CONCURRENT_TRANSCODES`. Se o ffmpeg estiver ausente, `/api/video/fallback` retorna mensagem clara em vez de 500 cru.
- **Segurança**: paths via `resolveSafeRelPath()`; nomes de cache são hashes (nunca nomes de usuário em URL); `spawn`/`execFile` com args fixos, sem shell.
- **Logging** esparso: `[TRANSCODE] iniciado / cache encontrado / aguardando job existente / progresso N% / concluído / falhou / cancelado / cache limpo`.
- **Contrato com o frontend**: o MESMO elemento `<video>` tem o `src` trocado (preserva o GainNode do Web Audio e os listeners); posição/volume são reaplicados quando a região-alvo fica `buffered`; um badge não-bloqueante "Preparando compatibilidade..." aparece enquanto o job roda. Falha mostra erro claro com "Tentar novamente" (re-tenta o fallback; o retry do original é caminho separado, guardado por `data-retry-original`).

### Legendas por IA (resumo)

Pipeline: `Vídeo → extração de áudio (ffmpeg → WAV 16kHz mono PCM16) → ASR local (whisper.cpp) → transcrição bruta → pós-processamento determinístico → correção LLM opcional + guardrail → segmentação → WebVTT → cache → player`. Geração é **adicional**: sem binário/modelo/LLM/chave/internet o player funciona normal.

- **Registry data-driven** é a fonte de verdade (whisper local + stubs); adicionar provider = nova entrada no registry, nada de `if (provider === X)` no fluxo.
- **Fila priorizada P0–P3** (menor vence): P0 demanda (aula aberta no player), P1 próxima aula (`pregenNextLesson`), P2 primeira aula de cada curso pós-scan, P3 background (só com P0–P2 vazia). **Nunca gerar a biblioteca inteira de uma vez.**
- **Preempção** só de jobs baratos (`extracting` ou `transcribing` dentro de `PREEMPT_GRACE_MS`); preemptado volta à fila em P3.
- **Raw-sourced gate**: só retoma do raw quando `raw.source.mtimeMs+size` batem com o arquivo; `force=1` apaga cache **e** raw → regenera do zero.
- **VTT canônico** em `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (ignorado pelo scan) + espelho `data/subtitles/`; chave `sha1(rel).slice(0,24)`.
- **Transcrição bruta nunca é sobrescrita**; correção LLM guardada por guardrail (ids + conteúdo <40%/>4x); falha/timeout ⇒ LLM ignorado, legenda nunca bloqueada.
- **Concorrência**: transcode e whisper compartilham `heavySlots` (nunca simultâneos por padrão); LLM não consome slot.
- **Env vars**: `WHISPER_BIN`/`WHISPER_MODEL_DIR` (binário/modelos; instalação em `docs/whisper.md`), `MAX_CONCURRENT_TRANSCRIPTIONS` (default 1 — limite de transcrições simultâneas) e `BACKGROUND_SUBTITLE_GENERATION=true|1` (liga a geração em background P3; só aplica quando a env existe — senão vale a config persistida da Central de IA).
- **Player**: overlay customizado `.subtitle-overlay` (substitui `<track>`) + badge `.subtitle-status` + botão `.subtitle-action`. **Nunca `await` a geração antes de `video.play()`**.

> Detalhe completo (config `ai-config.json`, flags do whisper `-t`/`-pp`/VAD, detecção real, retomada de jobs, API do subsistema, editor): **`docs/SUBTITLES.md`**.

### Editor de legendas (estilo YouTube)

> **Desativado no frontend** (a pedido do usuário): o botão **"✎ Legendas"** foi removido do player e a rota `?editSubtitles=1` é ignorada (`subtitleEditorMode` é forçado a `false` em `renderCourse`) — o editor nunca abre na UI. O código do editor e as rotas de backend (`editor`/`save`/`export`/`ai-corrections`) permanecem no repositório, mas são inalcançáveis. Para reativar, devolva o botão e deixe `renderCourse` honrar `editMode`. Comportamento documentado do editor: `docs/SUBTITLES.md`.

### Frontend (`public/`)

- Roteamento por hash (`route()`): `#/` (home), `#/settings` (configurações), `#/course/<encodedPath>?lesson=<encodedLessonPath>` e `#/topic/<encodedPath>`. Ambos os caminhos de pasta caem no mesmo parse; `renderCourse` resolve o nó por path na árvore inteira (`findNodeByPath`) e, se `type==="topic"`, delega a `renderTopic` (links velhos `#/course/<tópico>` degradam bem). `location.hash` dirige a navegação; `init()` carrega árvore + progresso, roteia e registra atalhos.
- Objeto global `state` com árvore, progresso e nós atuais do curso/vídeo.
- **localStorage** (preferências do usuário, nunca no servidor): `course-favorites`, `course-player-progress-mode`, `course-player-settings` (`closeOtherModules` + `shortcuts`), `course-player-volume`, `course-player-gain`, `course-player-muted`, `course-player-speed`.
- **Home** (`renderHome`): **Home mista** — cards de curso e de tópico (classificação por marcador explícito no scan), capa (ou gradiente + iniciais). Card de tópico: `href = #/topic/<path>`, sem favorito, meta "N itens" (filhos diretos), tag "Tópico". Busca **accent-insensitive** em `buildSearchResults` (caminha a árvore inteira via `collectAllFolders` — acha tópicos, cursos e aulas aninhados; tópico → resultado `#/topic/`; Enter abre o 1º respeitando o tipo). Favoritos ao topo (só cursos). **Escopo contextual** (helpers puros em `public/scope.js`): "Seu progresso" na Home conta **só os cursos diretos** da raiz (`collectDirectCourses`) e **não aparece** quando a raiz não tem curso direto (biblioteca toda organizada em tópicos → o bloco vive dentro dos tópicos); "Continuar assistindo" é **GLOBAL** na Home (todos os cursos de todas as bibliotecas, inclusive aninhados em tópicos — `collectCoursesInScope(tree)`), até 8 itens, um por curso. Aulas dentro de tópicos continuam com `#/course/<nested>?lesson=...`. Card reutilizado por Home e tópico: `renderNodeCard(node)`.
- **Visão de tópico** (`renderTopic`, rota `#/topic/<path>`): breadcrumb clicável (`Home › TI › Python`, ancestrais → `#/topic/`), título do tópico e grid dos filhos (`renderNodeCard`). **Escopo contextual (CURRENT_TOPIC subtree only, recursivo)**: dentro do tópico, "Seu progresso" e "Continuar assistindo" (até 8, um por curso) consideram **somente** os cursos da subárvore do tópico (`collectCoursesInScope(topicNode)`) — tópicos irmãos, cursos da Home e outras bibliotecas ficam de fora; tópico aninhado refina (`TI/Programação` só vê o que está abaixo de `TI/Programação`). Não abre player, não mostra favoritos; empty state para tópico vazio. Back/forward do navegador funcionam por `hashchange`.
- **Visão do curso** (`renderCourse`): resolve o curso por path na árvore inteira (não só top-level) — habilita cursos aninhados em tópicos. Toolbar (favoritar, "Limpar progresso do curso", **"Gerar legendas do curso"** → `POST /api/subtitles/generate-course?path=`), player, cabeçalho da aula (breadcrumb + Anterior/Próxima), **sidebar de navegação de aulas** + progresso do curso. `expandedFolders` é **em memória** (resetado ao entrar, auto-expandido para ancestrais da aula atual; não persistido). `closeOtherModules` = acordeão (nível 1). **Sidebar vs materiais**: a sidebar é **navegação de aulas** — exibe apenas módulos/pastas de navegação e vídeos/aulas (`isSidebarNavigableNode` em `public/scope.js`); arquivos não-vídeo (`type === "file"`: PDF/DOC/XLS/PPT/ZIP/TXT/imagens de material) **não** aparecem como itens da sidebar, ficam **exclusivamente** na seção **"Materiais da aula"** abaixo do player (`parentFolder.children.filter(c => c.type === "file")`). A lista de navegação do player (`state.flatVideos = flattenVideos(course)`) contém **só vídeos** — anterior/próxima/avanço pós-`ended`/retomada ignoram materiais. Busca continua achando materiais; capas (imagens promovidas a capa pelo scan) continuam excluídas dos materiais.
- **Seleção de aula**: `lessonPath` explícito na URL → essa aula; senão retoma a mais recente em andamento (`position > 5 && !completed`, por `updatedAt`); senão a primeira não concluída; senão a primeira vídeo.
- **Tracking de progresso** (`setupVideoTracking`): `timeupdate` persiste com throttle de 5s, `pause` persiste, `ended` marca concluída e avança para a próxima aula (só com reprodução real — `wasPlaying`). `beforeunload` dá o flush final (`currentVideoPersist`).
- **Regras finas do persist** (`persist()`): auto-conclusão em >95%; reassistir parcialmente vídeo concluído **não** remove a conclusão (mantém posição máxima); posição zerada não apaga progresso válido; sem metadados nada é gravado. `loadAll()` sanea progresso carregado (posição perto do fim sem `completed` recuada para `duration-5`).
- **Retomada no player**: seek em `loadedmetadata` quando `position > 3 && position < duration - 2` (nunca busca até o fim). Concluídos por ✓ retomam na posição salva; por `ended` (position ≈ duration) voltam do início.
- **Áudio**: volume nativo 0–100% via `video.volume` (nunca > 1); acima de 100% (até 200%) o excesso vem de um `GainNode` do Web Audio — um único `AudioContext` por página, criado **apenas quando o ganho extra é usado** (`gain > 100%`). Só o `MediaElementAudioSourceNode` é recriado quando o `<video>` muda (`ensureAudioGraph`/`detachAudioSource`). Badge "EXTRA" mostra o ganho ativo. Resume exige gesto do usuário.
- **Velocidade**: 0.5–2× (0.5, 0.75, 1, 1.25, 1.5, 1.75, 2), persistida em `course-player-speed`; aplicada ao montar (`applySavedSpeed`) e restaurada ao trocar de aula.
- **Atalhos configuráveis**: 13 ações em `DEFAULT_SHORTCUTS` (search `/`, home `h`, next `n`, prev `p`, playpause `Espaço`, back5 `←`, fwd5 `→`, back10 `j`, fwd10 `l`, mute `m`, speedDown `,`, speedUp `.`, fullscreen `f`), editáveis em Configurações (modo captura, "Restaurar atalhos padrão"). Conflito com tecla usada é rejeitado. Pulados em input/textarea/select/contenteditable; suspensos com modal aberto; `Esc` fecha popovers.
- **Fallback de compatibilidade**: `error` do `<video>` chama `prepareTranscoded()` — badge "Preparando compatibilidade...", pede `/api/video/fallback`, troca o `src` e retoma posição/volume quando a região fica `buffered`. Trata `compatible:true` (re-tenta original), erros do servidor (mostra + "Tentar novamente") e listeners órfãos (guardas `data-fallback`/`data-retry-original`).
- **Legendas no player** (`setupPlayerSubtitles`): consulta `GET /api/subtitles/status?path=<rel>` e, conforme o estado, carrega o **overlay customizado** `.subtitle-overlay` (via `GET /api/subtitles/editor`, edited > processed > vtt; nunca `<track>`) ou mostra o badge `.subtitle-status` (disponível / gerando / indisponível / erro) + botão manual `.subtitle-action` ("Gerar legenda" sem legenda/erro; "Regenerar" com `force=1` quando pronta/erro) → `POST /api/subtitles/generate` com `priority=0`. Ao trocar de aula, overlay/badge/botões antigos são removidos e o polling do novo começa. Com `pregenNextLesson` e aula atual com legenda/geração ativa, enfileira a **próxima aula** via `POST /api/subtitles/generate?priority=1&skipIfReady=1`. Tudo não-bloqueante.
- **Configurações** (`renderSettings`, rota `#/settings`): "Limpar todo o progresso" (global → `POST /api/progress/clear` vazio), "Limpar cache de vídeos transcodificados" (`POST /api/transcode/clear`), switch "Fechar outros módulos", seção de atalhos e **Central de IA** (`renderAiSection`/`renderAiPanel` + estado `aiState`): 6 sub-abas (Visão geral, Transcrição, Correção e formatação, Provedores LLM, Modelos, Avançado) com status real (`GET /api/ai/status`), edição via `POST /api/ai/config` (chaves nunca voltam do servidor) e teste de conexão LLM. Ações destrutivas usam diálogo próprio (`openConfirmDialog`, sem `confirm()` nativo).
- Barra superior (`index.html`): logo/home, busca, botão **⟳ Atualizar** (reescaneia via `POST /api/rescan` → `loadAll()` → `route()`) e botão de configurações.

## Estrutura de arquivos

- `server.js` — backend completo (scan, API, media, persistência, transcoding, legendas por IA).
- `public/index.html` — casca da SPA (topbar + `<main id="app">`).
- `public/scope.js` — helpers **puros** de escopo contextual (Home/tópicos) e de navegação (sidebar): `isDescendantPath` (path REAL, por segmentos — `TI/` não alcança `TI2/`), `isSidebarNavigableNode` (navegável na sidebar de aulas = `folder`/`topic`/`video`; `file`/material rejeitado — decisão por `type`, nunca por extensão no frontend), `collectCoursesInScope`, `collectDirectCourses`, `flattenVideos` (só vídeos — base da lista de navegação, prev/next/ended), `buildContinueItems` (uma aula por curso, `position > 5`, `!completed`, ordenado por `updatedAt`, máx. 8). Sem DOM/estado — carregado antes de `app.js` e `require()`-ável pelos testes.
- `public/app.js` — toda a lógica de UI, roteamento, player e atalhos.
- `public/styles.css` — estilos (tema, layout, gradientes das capas).
- `package.json` / `package-lock.json` — dependência única: Express.
- `docs/DOCUMENTACAO.md` — manual técnico extenso (scan, API, media, persistência, transcoding), mas **anterior ao pipeline de IA**: não cobre legendas por ASR, correção LLM nem `ai-config`. Para o que a doc não cobre, o código e este arquivo são a fonte de verdade.
- `docs/SUBTITLES.md` — referência completa do subsistema de legendas (pipeline, editor, API).
- `docs/VALIDACAO.md` — checklist completo de validação.
- `docs/whisper.md` — guia independente de instalação/configuração do whisper.cpp (binário + modelo + envs + validação + solução de problemas), com os comandos reais testados.
- `docs/TOPICOS-MARCADORES.md` — relatório final da feature de tópicos por marcador explícito (`.topic` e `(TP)`; alterações, compatibilidade, migração, riscos, limitações).
- `docs/AUDITORIA-PROGRESSO.md` — auditoria do sistema de progresso pós-tópicos/bibliotecas (identidade `libId\0rel`, casos de colisão, backup/corrupção, shutdown, veredito).
- `test/topics.test.js` — testes estruturais da regra de tópicos por marcador (`node:test` + `node:assert`, stdlib). Rodar: `node --test test/topics.test.js`.
- `test/libraries.test.js` — testes das bibliotecas externas (validação de path, escopo de progresso/caches, `scanLibrary`). Rodar: `node --test test/libraries.test.js`.
- `test/progress.test.js` — testes de **integridade do progresso** (auditoria pós-tópicos/bibliotecas): chave `libId\0rel` (sem colisão entre bibliotecas/cursos/tópicos), clear delimitado e escopado, migração de chaves legadas, recuperação de backup em cascata, dreno no shutdown. Sobe o servidor real num diretório temporário (`LP_DATA_DIR`). Rodar: `node --test test/progress.test.js`.
- `test/scope.test.js` — testes do **escopo contextual** (Home/tópicos) sobre `public/scope.js`: segmentação de path (`TI` ≠ `TI2`, `Curso` ≠ `Curso2`), coleção por escopo (raiz = todos; tópico = subárvore; aninhado refina), cursos diretos da Home, "Continuar assistindo" global vs filtrado, regras de progresso preservadas (<=5s/concluído/updatedAt/limite 8). Puros, sem DOM. Rodar: `node --test test/scope.test.js`.
- `test/sidebar.test.js` — testes da **sidebar vs materiais** sobre `public/scope.js`: `isSidebarNavigableNode` aceita folder/topic/video e rejeita file; `flattenVideos` (lista do player) tem só vídeos (PDF/ZIP fora); próxima/anterior/avanço pós-`ended` ignoram materiais; material não vira item de progresso/"Continuar assistindo"; materiais continuam na árvore para "Materiais da aula". Puros, sem DOM. Rodar: `node --test test/sidebar.test.js`.
- `test/sidebar-runtime-smoke.js` — validação **runtime** da regra sidebar-vs-materiais sobre um scan REAL (sobe o servidor com `LP_DATA_DIR` e cria biblioteca externa sandbox): lista de navegação só com vídeos, próxima aula de Aula 01 = Aula 02, nenhum material navegável, "Materiais da aula" com os arquivos da pasta, capa preservada. Rodar: `node --test test/sidebar-runtime-smoke.js`.
- `data/` — runtime: `progress.json`, `progress.json.bak`, `*.corrupt-<ts>` (auto), `*.tmp` (órfãos auto-limpados), `transcoded/` (cache), `ai-config.json` (config de IA; chaves só aqui), `subtitles/` (`raw/`, `processed/`, `work/`, `edited/` (edição manual JSON), `backup/` (edição preservada antes de regenerar), `jobs.json`, `<hash>.vtt`). **Atenção**: `data/server.log` e backups históricos tipo `progress.json.wiped-1701.bak`/`wrecked.bak` são artefatos manuais de sessões anteriores — o servidor **não** escreve log em arquivo (só stdout) nem os gera. Não dependa deles.
- `bin/` + `models/` — infra para instalação **manual** de binários/modelos de IA (`whisper-cli*`, `ggml-*.bin`); nada é baixado pelo app. READMEs pt-BR explicam a instalação. **Nota**: pendrives FAT/vfat não executam binários — instale o `whisper-cli` num filesystem com exec (a localização é livre; ex.: `~/.local/opt/whisper.cpp/`) e aponte `WHISPER_BIN` para ele; os modelos (`ggml-*.bin`, ~465 MB o `small`) ficam em `models/` e são localizados via `WHISPER_MODEL_DIR`.
- `.gitignore` — `node_modules/`, `data/` (runtime completo: progresso, backups, logs, cache, config de IA), `models/` + `bin/` (grandes, baixados manualmente), `*.tmp`/`*.temp`, `*.log`, `.env*`, arquivos de sistema e configs locais de editor (`.claude/settings.local.json`, `.vscode/`, `.idea/`).

## Fluxo de dados (resumo)

1. `init()` (frontend) → `GET /api/tree` + `GET /api/progress` → `state`.
2. Navegação por hash → `renderHome`/`renderCourse` (delega a `renderTopic` quando `type==="topic"`)/`renderSettings`.
3. `renderCourse` escolhe a aula (regra de retomada) → `renderPlayerAndLesson` monta o `<video>` com `src = /media/<path>`.
4. `setupVideoTracking` → `timeupdate`/`pause`/`ended` → `POST /api/progress` (path, position, duration, completed).
5. `error` no `<video>` → `prepareTranscoded` → `GET /api/video/fallback?path=` → `src = /transcoded/<hash>.mp4` (cresce enquanto o ffmpeg converte).
6. Na montagem do player, `setupPlayerSubtitles` → `GET /api/subtitles/status?path=<rel>` → overlay customizado `.subtitle-overlay` (via `GET /api/subtitles/editor`, edited > processed > vtt) + badge + botão manual. Aula sem legenda ⇒ `POST /api/subtitles/generate?priority=0` (**P0 demanda**); quando a aula atual tem legenda e `pregenNextLesson`, o frontend enfileira a próxima em P1 (`?priority=1&skipIfReady=1`). Pós-scan, o servidor enfileira a primeira aula de cada curso em P2 (`pregenFirstLesson`) e, com `background`, lotes em P3 só quando a fila P0–P2 está vazia. Pipeline: extração ffmpeg → whisper (`-t`/`-pp`; VAD só se `capabilities.vad` um dia voltar a ser true) → pós-processamento → LLM opcional → WebVTT em `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (canônico) + espelho `data/subtitles/` → player pega em nova montagem. Nunca bloqueia o `play()`. Detalhes: `docs/SUBTITLES.md`.
7. `beforeunload` → flush final da posição.
8. `POST /api/progress` → `updateProgress` (fila serializada) → `readProgress` + mutação → `writeFileAtomic` (com backup prévio).
9. Editor (`&editSubtitles=1`): fluxo completo em `docs/SUBTITLES.md` — desativado no frontend.

## Invariantes (não quebrar sem justificativa forte)

- **ROOT deriva da localização do app** (`path.resolve(__dirname, "..")`); nunca hardcode nem troque a base.
- **Todo path de cliente passa por `resolveSafeRelPath()`** em qualquer endpoint novo que aceite path (e por `resolveLibraryRel`/`requestLibrary` quando a operação é por biblioteca — id desconhecido → 400, nunca degrada silenciosamente para a padrão).
- **Remoção de biblioteca é config-only**: `DELETE /api/libraries/:id` nunca executa `rm`/`fs.rm`/`fs.rmdir` em arquivos da biblioteca; jobs ativos bloqueiam (409) e enfileirados são descartados.
- **Chaves/caches escopados por biblioteca**: progresso `libId\0rel`, transcode/legendas `sha1(libId\0rel)[0:24]`, favoritos `libId\0path` — nunca reintroduzir chave global sem prefixo nem resolver mídia fora do path canônico do registro.
- **Rel paths usam sempre `/`** (árvore, chaves de progresso, URLs); nunca introduza `\` — no Windows `path.normalize` produziria separador nativo e quebraria a correspondência.
- **Originais compatíveis são servidos direto** — zero envolvimento do ffmpeg no caminho feliz. O fallback só entra após `error` do `<video>`.
- **O caminho do arquivo em crescimento deve permanecer intacto**: `fd.stat()` (não existe `fs.fstat` em `fs/promises`), copiar buffers antes de `res.write` (subarrays aliasam o buffer reutilizado), tratar a corrida de rename (job terminou no meio da requisição → abrir o final), e nunca servir `.tmp` parcial como cache final.
- **Cache de transcode**: nome hash determinístico, invalidação por mtime, `.tmp` só vira final via `rename` após exit 0.
- **Persistência**: escrita atômica + fila serializada + backup; nunca deixar de preservar o arquivo corrompido (`.corrupt-<ts>`).
- **Roteamento por hash** e a troca de `src` no MESMO `<video>` (preserva Web Audio) são contratos do frontend.
- **Range requests preservados** no serviço de media (`sendFile`/`express.static` já tratam).
- **Sem build step, sem framework** no frontend; sem novas dependências sem motivo.
- **Porta em uso (`EADDRINUSE`) → exit(1) com mensagem clara**; `unhandledRejection`/`uncaughtException` são logados, não derrubam o servidor (protege o progresso).
- **`POST /api/transcode/clear` nunca toca `progress.json`**.
- **Legenda nunca é dependência do player**: nenhum `await` de geração antes de `video.play()`; sem binário/modelo/LLM/chave/internet o app funciona normal (badge "Legenda indisponível").
- **Registry é a fonte de verdade** dos providers ASR/LLM — nada de `if (provider === X)` espalhado no fluxo; adicionar provider = nova entrada no registry.
- **Chaves de API só no backend** (`data/ai-config.json`); `GET /api/ai/*` retorna só `hasApiKey`; logs `[SUBTITLE]`/`[AI]` nunca imprimem chave/token/prompt completo.
- **Correção LLM é guardada**: guardrail rejeita ids faltando/duplicados/inventados e conteúdo <40% ou >4x; falha/timeout/off ⇒ original preservado, legenda concluída.
- **Transcrição bruta sempre preservada** em `data/subtitles/raw/<hash>.json` — nunca sobrescrita pelo pós-processamento ou LLM; e só é reutilizada quando `source.mtime+size` batem com o arquivo atual (vídeo tocado ⇒ re-extração).
- **VTT canônico em `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt`** (o `.courseplayer` começa com `.` → ignorado pelo scan); `data/subtitles/` mantém só o espelho e os temporários (`raw/`/`processed/`/`work/`). `clear` por vídeo apaga ambos; global varre `.courseplayer`.
- **Nunca gerar a biblioteca inteira de uma vez**: geração é orientada à demanda (P0 aula aberta), com P1 (próxima aula), P2 (primeira aula de cada curso, pós-scan) e P3 (background, só com a fila prioritária vazia). Preempção só de jobs baratos (`extracting` ou `transcribing` dentro de `PREEMPT_GRACE_MS`); o preemptado volta à fila em P3.
- **Transcode e whisper compartilham `heavySlots`** (nunca simultâneos por padrão); LLM não consome slot.
- **Cache de legendas** chaveado por `sha1(rel).slice(0,24)` e invalidado por `mtime + size` — nunca por nome de vídeo/curso.
- **Edição manual nunca sobrescreve o raw** nem o processed: o JSON editado vive em `data/subtitles/edited/<hash>.json` e o VTT derivado sempre parte dele (`renderVtt`). `loadEditableDoc` = edited > processed (mtime+size válido) > vtt. `backupEditedSubtitle` preserva a edição antes de qualquer regeneração.
- **Concorrência do editor por `version`**: o save manda o `version` carregado; divergente do persistido = **409** (diálogo "alterada em outra aba"); nunca sobrescreve silenciosamente.
- **Overlay customizado substitui `<track>`** como camada de exibição (uma única `.subtitle-overlay`); o WebVTT permanece apenas como fonte de dados/serialização. Geometria sempre pela área REAL do vídeo renderizado (letterbox incluso).
- **Sidebar = navegação de aulas, não catálogo de arquivos**: a sidebar renderiza só `isSidebarNavigableNode` (módulos/pastas e vídeos); `type === "file"` NUNCA vira item de sidebar, aula, item de anterior/próxima, avanço pós-`ended`, "current lesson" nem contagem de aulas — materiais vivem só em "Materiais da aula" (`filter(c => c.type === "file")` da pasta da aula) e na busca. Decisão por `type` do scan, nunca por extensão no frontend. Capas (imagens promovidas a capa) continuam excluídas dos materiais.

## Gotchas

- `npm install --no-bin-links` é intencional para cenários de drive externo — `npm install` puro pode quebrar em pendrives FAT/exFAT.
- **Transcoding é fallback, não padrão.** Qualquer mudança que faça o servidor analisar/converter vídeos compatíveis é regressão.
- Duas instâncias simultâneas corrompem `progress.json`; por isso o `EADDRINUSE` sai com mensagem clara.
- Os níveis de título (`title`) são calculados **no servidor** (`normalizeDisplayTitle`). Se o frontend precisar de novo comportamento de título, mude no servidor — o fallback no frontend é mínimo.
- `expandedFolders` não é persistido — se quiser persistir expansão entre sessões, use localStorage (padrão do projeto), mas não presuma que já exista.
- O painel/árvore re-renderizam com frequência (`updateProgressUI` re-renderiza a árvore); mudanças de DOM no player devem preservar listeners/estado do `<video>`.
- **Whisper em drive FAT/vfat não executa** (sem permissão de execução). Se o app estiver num pendrive, aponte `WHISPER_BIN` para um filesystem com exec (ex.: copiar para `/tmp/whisper-cli` e setar a env) — `bin/` só resolve no Linux/NTFS com exec habilitado.
- Como transcode e whisper compartilham `heavySlots`, uma geração de legenda pode esperar uma conversão de vídeo em andamento (e vice-versa) — é por design, não deadlock (fila FIFO de waiters).
- A config de IA só é gravada em disco quando há mudança (`POST /api/ai/config`/`reset`); o servidor serve defaults em memória se `data/ai-config.json` não existir.

## Como validar alterações (resumo)

1. `node --check server.js public/app.js public/scope.js` (sintaxe); `node --test test/progress.test.js test/topics.test.js test/libraries.test.js test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js` (integridade do progresso + tópicos por marcador + bibliotecas externas + escopo contextual + sidebar/materiais).
2. Rode o servidor (`npm start`) e exercite: scan, navegação, player (originais compatíveis sem transcode), busca, favoritos, progresso (recarregar preserva posição), atalhos, Configurações. Tópicos: `docs/VALIDACAO.md` item 12.
3. Fallback de transcode: toque formato incompatível (`.mkv`/`.avi`) e confirme badge → reprodução em segundos → `[TRANSCODE] progresso` no log → final em `data/transcoded/`; seek além do convertido aguarda/416.
4. Persistência: escreva progresso, derrube o servidor no meio da gravação (ou simule `progress.json` corrompido) e confirme recuperação do backup.
5. Path traversal: `/media/../../etc/passwd`, `/api/video/fallback?path=../../etc/passwd`, e variantes Windows (`\`, `..\..\`, absolutos) → 404/400, nunca conteúdo fora de `ROOT`.
6. Duas instâncias na mesma porta → mensagem clara + exit.
7. IA sem nada instalado: `GET /api/ai/status` → `available:false` honesto; Central de IA renderiza as 6 abas.
8–11. Geração/LLM/concorrência/editor: **`docs/VALIDACAO.md`** (checklist completo).
