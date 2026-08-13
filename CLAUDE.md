# CLAUDE.md

Este arquivo orienta Claude Code (claude.ai/code) no trabalho com este repositório. Foi reescrito a partir de auditoria do código real (`server.js`, `public/`, `package.json`) — o código é a fonte de verdade.

> Documentação profunda (detalhe de implementação) foi movida para `docs/` — **leia o ponteiro antes de mexer no subsistema**: `docs/DOCUMENTACAO.md` (scan, API, media, persistência, transcoding), `docs/SUBTITLES.md` (pipeline de legendas + editor), `docs/VALIDACAO.md` (checklist de validação), `docs/whisper.md` (instalação do whisper.cpp).

## Projeto

O **Local Player** é um player local/offline para organizar e reproduzir conteúdo de mídia armazenado em disco (HDs externos / pendrives). Ele pode estruturar qualquer biblioteca de conteúdo em pastas — cursos, aulas, treinamentos, vídeos educacionais, coleções de vídeo. Escaneia a árvore de pastas, serve vídeos/materiais diretamente do disco, persiste progresso por aula e oferece busca, favoritos e atalhos de teclado. Um **fallback de transcoding** (ffmpeg) converte apenas os formatos que o navegador não reproduz; originais compatíveis nunca tocam o ffmpeg. Gera também **legendas automáticas por vídeo** (ASR local Whisper + correção LLM opcional) — recurso adicional, nunca dependência do player.

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
- **Sem testes, sem linter, sem build step**. Verificação rápida de sintaxe: `node --check server.js public/app.js`. Para validar comportamento, rode o servidor e exercite a UI (ou `curl` as rotas da API). Checklist completo: `docs/VALIDACAO.md`.
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
- A pasta do próprio app (`_LocalPlayer`, via `APP_DIR_NAME = path.basename(__dirname)`) é excluída do scan, assim como entradas com prefixo `.` e arquivos com `IGNORED_EXT` (`.ini`, `.db`, `.lnk`). Imagens de capa são excluídas dos materiais e da busca.
- `scanDir()` monta a árvore recursivamente. Tipos de nó: `folder`, `video`, `file` (material não-vídeo). Ordenação natural por `localeCompare(..., "pt-BR", { numeric: true, sensitivity: "base" })`.
- A árvore é cacheada em `treeCache` (com `scannedAt`); `GET /api/tree?rescan=1` ou `POST /api/rescan` força novo scan.
- **Capas**: cada pasta escolhe uma capa das próprias imagens por nome (dicas: `cover`, `thumbnail`, `poster`, `banner`, `image`, `img`) ou herda de pasta filha. Capa direta pontua 200, capa de filho 50. Sem imagem, o frontend renderiza um gradiente determinístico com as iniciais do curso.

### Normalização de títulos

- Todo nó da árvore carrega um `title` de exibição calculado no servidor por `normalizeDisplayTitle()` (cursos, módulos e aulas). O `name` original do arquivo/pasta **nunca** é alterado — ele continua dirigindo ordenação e indexação de busca.
- Pipeline: remove prefixos simbólicos (`==`, `###`, `--`, `**`, `>`, `_`, `=`), rótulos (`Aula 03 - `, `Módulo 1 - `), sufixos de autoria (` - By @canal`), numeração inicial, truncamentos (`Arq...` → `Arq`), artefato `~1` (8.3), tags `[PROJETO]`, sublinhados entre palavras, separadores soltos; aplica capitalização de sentença pt-BR preservando nomes próprios/siglas (`TITLE_KEEP_CASE`: SQL, Python, PostgreSQL, Node.js, NumPy, etc.).
- Remoção de numeração é conservadora: números de conteúdo sobrevivem (`3D Modelagem`, `4K Vídeos`, `9.5 título`). Módulos/tópicos mantêm o número de exibição (`keepNumber` → `"01 - Título"`); aulas não.
- O frontend também valida títulos em `validateDisplayTitle` (só avisa no console — não oculta nada).

### API (`server.js`)

Rotas principais. Rotas de legendas/IA → `docs/SUBTITLES.md`.

| Rota | Propósito |
| --- | --- |
| `GET /api/tree?rescan=1` | Árvore de cursos (cacheada) |
| `POST /api/rescan` | Força novo scan, retorna a árvore |
| `GET /api/progress` | Todo o progresso salvo |
| `POST /api/progress` | Salva `{path, position, duration, completed}` de uma aula |
| `POST /api/progress/clear` | Limpa progresso de um curso (`coursePath`) ou de tudo (body vazio) |
| `GET /media/*` | Serve originais (vídeo via `sendFile`, materiais via `express.static(ROOT)`), com suporte a Range |
| `GET /api/video/fallback?path=<rel>` | Plano de transcoding: `{compatible:true,url}` \| `{compatible:false,status:'transcoding'\|'ready',url}` \| `{error,message}` |
| `GET /transcoded/<24-hex>.mp4` | Serve o cache de transcode: arquivo final (Range completo) ou `.tmp` em crescimento (progressivo) enquanto o job roda |
| `POST /api/transcode/clear` | Apaga `data/transcoded/` e cancela jobs; **nunca toca `progress.json`** |

- `app.use(express.json({ limit: "100kb" }))`.
- **Segurança de path**: todo path vindo do cliente passa por `resolveSafeRelPath()`, que rejeita qualquer coisa que escape de `ROOT`. Aplique a novos endpoints que recebam paths.
- **Media**: vídeos vão por `resolveSafeRelPath()` + `res.sendFile()` (express/send trata `Range` → 206, `Content-Length`, `Content-Type` — o que o `<video>` precisa para seek/buffer); materiais não-vídeo caem em `express.static(ROOT)`. Originais nunca são processados. **Limitação conhecida (BUG-001 da auditoria)**: o static de `ROOT` também serve a pasta do app (`<ROOT>/_LocalPlayer/`, inclusive `data/ai-config.json` e `data/progress.json`) — a exclusão de `APP_DIR_NAME` existe no scan, **não** no serviço estático. Não exponha a porta a outros dispositivos até corrigir (404 para `/media/<APP_DIR_NAME>/*` e/ou bind em `127.0.0.1`).
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

- Roteamento por hash (`route()`): `#/` (home), `#/settings` (configurações), `#/course/<encodedCoursePath>?lesson=<encodedLessonPath>`. `location.hash` dirige a navegação; `init()` carrega árvore + progresso, roteia e registra atalhos.
- Objeto global `state` com árvore, progresso e nós atuais do curso/vídeo.
- **localStorage** (preferências do usuário, nunca no servidor): `course-favorites`, `course-player-progress-mode`, `course-player-settings` (`closeOtherModules` + `shortcuts`), `course-player-volume`, `course-player-gain`, `course-player-muted`, `course-player-speed`.
- **Home** (`renderHome`): cards de curso com capa (ou gradiente + iniciais), busca **accent-insensitive** (token scoring com normalização NFD em `buildSearchResults`, top 18; Enter abre o 1º), favoritos ao topo, painel "Seu progresso" (conclusão, tempo estudado, cursos ativos) e "Continuar assistindo" (até 8, um por curso, `position > 5 && !completed`, por `updatedAt`).
- **Visão do curso** (`renderCourse`): toolbar (favoritar, "Limpar progresso do curso", **"Gerar legendas do curso"** → `POST /api/subtitles/generate-course?path=`), player, cabeçalho da aula (breadcrumb + Anterior/Próxima), materiais da pasta, sidebar colapsável de módulos/aulas + progresso do curso. `expandedFolders` é **em memória** (resetado ao entrar, auto-expandido para ancestrais da aula atual; não persistido). `closeOtherModules` = acordeão (nível 1).
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
- `public/app.js` — toda a lógica de UI, roteamento, player e atalhos.
- `public/styles.css` — estilos (tema, layout, gradientes das capas).
- `package.json` / `package-lock.json` — dependência única: Express.
- `docs/DOCUMENTACAO.md` — manual técnico extenso (scan, API, media, persistência, transcoding), mas **anterior ao pipeline de IA**: não cobre legendas por ASR, correção LLM nem `ai-config`. Para o que a doc não cobre, o código e este arquivo são a fonte de verdade.
- `docs/SUBTITLES.md` — referência completa do subsistema de legendas (pipeline, editor, API).
- `docs/VALIDACAO.md` — checklist completo de validação.
- `docs/whisper.md` — guia independente de instalação/configuração do whisper.cpp (binário + modelo + envs + validação + solução de problemas), com os comandos reais testados.
- `data/` — runtime: `progress.json`, `progress.json.bak`, `*.corrupt-<ts>` (auto), `*.tmp` (órfãos auto-limpados), `transcoded/` (cache), `ai-config.json` (config de IA; chaves só aqui), `subtitles/` (`raw/`, `processed/`, `work/`, `edited/` (edição manual JSON), `backup/` (edição preservada antes de regenerar), `jobs.json`, `<hash>.vtt`). **Atenção**: `data/server.log` e backups históricos tipo `progress.json.wiped-1701.bak`/`wrecked.bak` são artefatos manuais de sessões anteriores — o servidor **não** escreve log em arquivo (só stdout) nem os gera. Não dependa deles.
- `bin/` + `models/` — infra para instalação **manual** de binários/modelos de IA (`whisper-cli*`, `ggml-*.bin`); nada é baixado pelo app. READMEs pt-BR explicam a instalação. **Nota**: pendrives FAT/vfat não executam binários — instale o `whisper-cli` num filesystem com exec (a localização é livre; ex.: `~/.local/opt/whisper.cpp/`) e aponte `WHISPER_BIN` para ele; os modelos (`ggml-*.bin`, ~465 MB o `small`) ficam em `models/` e são localizados via `WHISPER_MODEL_DIR`.
- `.gitignore` — `node_modules/`, `data/` (runtime completo: progresso, backups, logs, cache, config de IA), `models/` + `bin/` (grandes, baixados manualmente), `*.tmp`/`*.temp`, `*.log`, `.env*`, arquivos de sistema e configs locais de editor (`.claude/settings.local.json`, `.vscode/`, `.idea/`).

## Fluxo de dados (resumo)

1. `init()` (frontend) → `GET /api/tree` + `GET /api/progress` → `state`.
2. Navegação por hash → `renderHome`/`renderCourse`/`renderSettings`.
3. `renderCourse` escolhe a aula (regra de retomada) → `renderPlayerAndLesson` monta o `<video>` com `src = /media/<path>`.
4. `setupVideoTracking` → `timeupdate`/`pause`/`ended` → `POST /api/progress` (path, position, duration, completed).
5. `error` no `<video>` → `prepareTranscoded` → `GET /api/video/fallback?path=` → `src = /transcoded/<hash>.mp4` (cresce enquanto o ffmpeg converte).
6. Na montagem do player, `setupPlayerSubtitles` → `GET /api/subtitles/status?path=<rel>` → overlay customizado `.subtitle-overlay` (via `GET /api/subtitles/editor`, edited > processed > vtt) + badge + botão manual. Aula sem legenda ⇒ `POST /api/subtitles/generate?priority=0` (**P0 demanda**); quando a aula atual tem legenda e `pregenNextLesson`, o frontend enfileira a próxima em P1 (`?priority=1&skipIfReady=1`). Pós-scan, o servidor enfileira a primeira aula de cada curso em P2 (`pregenFirstLesson`) e, com `background`, lotes em P3 só quando a fila P0–P2 está vazia. Pipeline: extração ffmpeg → whisper (`-t`/`-pp`; VAD só se `capabilities.vad` um dia voltar a ser true) → pós-processamento → LLM opcional → WebVTT em `ROOT/<curso>/.courseplayer/subtitles/<hash>.vtt` (canônico) + espelho `data/subtitles/` → player pega em nova montagem. Nunca bloqueia o `play()`. Detalhes: `docs/SUBTITLES.md`.
7. `beforeunload` → flush final da posição.
8. `POST /api/progress` → `updateProgress` (fila serializada) → `readProgress` + mutação → `writeFileAtomic` (com backup prévio).
9. Editor (`&editSubtitles=1`): fluxo completo em `docs/SUBTITLES.md` — desativado no frontend.

## Invariantes (não quebrar sem justificativa forte)

- **ROOT deriva da localização do app** (`path.resolve(__dirname, "..")`); nunca hardcode nem troque a base.
- **Todo path de cliente passa por `resolveSafeRelPath()`** em qualquer endpoint novo que aceite path.
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

1. `node --check server.js public/app.js` (sintaxe).
2. Rode o servidor (`npm start`) e exercite: scan, navegação, player (originais compatíveis sem transcode), busca, favoritos, progresso (recarregar preserva posição), atalhos, Configurações.
3. Fallback de transcode: toque formato incompatível (`.mkv`/`.avi`) e confirme badge → reprodução em segundos → `[TRANSCODE] progresso` no log → final em `data/transcoded/`; seek além do convertido aguarda/416.
4. Persistência: escreva progresso, derrube o servidor no meio da gravação (ou simule `progress.json` corrompido) e confirme recuperação do backup.
5. Path traversal: `/media/../../etc/passwd`, `/api/video/fallback?path=../../etc/passwd`, e variantes Windows (`\`, `..\..\`, absolutos) → 404/400, nunca conteúdo fora de `ROOT`.
6. Duas instâncias na mesma porta → mensagem clara + exit.
7. IA sem nada instalado: `GET /api/ai/status` → `available:false` honesto; Central de IA renderiza as 6 abas.
8–11. Geração/LLM/concorrência/editor: **`docs/VALIDACAO.md`** (checklist completo).
