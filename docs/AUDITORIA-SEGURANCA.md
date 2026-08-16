# Auditoria de Segurança

**Projeto:** Local Player — player local/offline (Node.js + Express + SPA JS puro)
**Data:** 2026-08-16
**Escopo:** aplicação, rede, filesystem, dados, IA/LLM, Git/GitHub, dependências, frontend.
**Fonte de verdade:** código real (`server.js`, `public/`, testes) + probes práticos em sandbox.
**Método:** threat model, leitura de código, testes funcionais controlados (servidor real em `LP_DATA_DIR` + biblioteca externa de teste em `/tmp/opencode/`), `npm audit`, varredura de histórico Git.

> Nenhuma chave/segredo real foi encontrada. O único valor de chave citado abaixo é **fictício**, criado em sandbox para validar a máscara de saída.

---

## 1. Resumo executivo

O Local Player é uma aplicação **local single-user** com bind em todas as interfaces por decisão documentada (`HOST` default = todas, sem autenticação). O maior risco autêntico encontrado — e **corrigido nesta auditoria** — foi o **escape de biblioteca por symlink/junction**: um link dentro de uma biblioteca registrada era seguido por `/media`, ffprobe/ffmpeg e pelo pipeline de legendas, permitindo servir/processar arquivos fora da biblioteca (confirmado lendo `/etc/passwd` e o `progress.json` real de outro diretório via link). Também foi corrigida a **execução de materiais com conteúdo ativo** (`.html`/`.svg`/`.xml`/`.js`/`.json`) no origin da app, que configurava XSS armazenado, e a ausência de headers de segurança básicos.

Path traversal (incluindo dupla codificação, barras invertidas, bytes nulos, caminhos absolutos), a pasta do app (BUG-001), dotfiles, nomes de cache (`/transcoded`, `/subtitles`), validação de bibliotecas, máscara da `apiKey` de IA e injeção de comando em ffmpeg/whisper foram **testados e estão protegidos**. Execução da LLM em `npm audit`: **0 vulnerabilidades** (Express 4.22.2). Git: 1 único commit, **sem secrets no histórico**; repositório **pronto com ressalvas** para publicação (faltam commitar arquivos novos: `public/scope.js`, `test/`, docs recentes — e revisar screenshots).

Riscos restantes relevantes são **do modelo de ameaça local**: ausência de autenticação quando exposto à LAN (um dispositivo na rede pode ler progresso/caminhos, enfileirar jobs pesados, limpar progresso/transcode) e SSRF restrito do teste de conexão LLM. São limitações de projeto (app local, sem arquitetura de auth) — documentados e com mitigação recomendada, sem mudança forçada de arquitetura.

---

## 2. Threat model

### Ativos

| Ativo | Onde | Crítico (local) | Exposto à LAN |
|---|---|---|---|
| `ai-config.json` (`apiKey` de LLM) | `data/` | Alto | Não via API (mascarado); sim se link escapasse (corrigido) |
| `progress.json` (+ bak/corrupt) | `data/` | Médio (preferências) | Sim via `GET /api/progress` (nomes/paths de cursos) |
| Conteúdo da biblioteca (vídeos/materiais) | ROOT/libs externas | Alto (privacidade) | Sim via `/media` |
| Nomes/caminhos de cursos | árvore + progresso | Médio | Sim (árvore, progresso, logs) |
| Legendas (texto transcrito) | `data/subtitles` + `.courseplayer` | Médio | Parcial (`/subtitles/<hash>.vtt`) |
| Cache de transcode | `data/transcoded` | Baixo | Sim (`/transcoded/<hash>`) |
| Workspace (WAV temporário) | `os.tmpdir` / dir custom | Baixo | Ando (escrita) |
| `libraries.json` | `data/` | Baixo | Sim (paths absolutos via API) |
| Código-fonte | repo | Alto (integridade) | Git/GitHub |
| Binários/modelos Whisper | `bin/`,`models/` | Não (gitignored) | Não servidos |

### Entradas não confiáveis

- URL/query/body JSON de qualquer origem **na mesma rede** (sem auth).
- Paths e nomes de arquivos/diretórios do disco (dentro e fora da biblioteca — via symlink, corrigido).
- Conteúdo de materiais (HTML ativo — corrigido), texto de legendas, mensagens de erro.
- Config de IA (URLs de provedores LLM, workspace custom, `apiKey`).
- Prompts/`baseUrl` no teste de conexão LLM.

### Superfícies

HTTP: `/media/*`, `/api/*` (progress, libraries, video/fallback, transcode, subtitles, ai, logs, storage, system), `/transcoded/*`, `/subtitles/*`, SPA. Processos: ffmpeg, ffprobe, whisper.cpp. Filesystem: bibliotecas, `data/`, workspace. Externos: provedores LLM (opcional, demanda do usuário). Não há SSE.

### Trust boundaries

- **T1 — Rede → app**: `HOST` todas as interfaces, sem auth. Tudo abaixo deste ponto é atingível por qualquer IP da rede (leitura e escrita).
- **T2 — App → filesystem da biblioteca**: o único guard é lexical (`resolveSafeRelPath`) + realpath (novo `fileWithinLibrary`). Rompido por symlink antes da correção.
- **T3 — App → processos externos**: `spawn` sem shell, args fixos. Seguro (verificado).
- **T4 — App → LLM externo**: `baseUrl` arbitrário (configurado pelo usuário) recebe chave `Authorization` e texto de legenda (opcional, correção). Reconhecido e documentado.
- **T5 — máquina host → disco da biblioteca**: dono do usuário; symlink pode intencionalmente apontar fora — agora bloqueado no serve/processo.

---

## 3. Superfície de ataque

Inventário testado (probes reais em servidor sandbox, porta 41892, biblioteca externa controlada):

| Superfície | Tipos de operação | Proteções aplicadas |
|---|---|---|
| `GET /media/*` | Leitura de bytes (Range) | lexical + app-dir + dotfiles + **realpath** + nosniff/attachment |
| `GET /api/tree`, `/api/rescan`, `/api/libraries*` | Leitura de estrutura; CRUD + scan | paths de biblioteca validados; padrão imutável |
| `GET/POST /api/progress`, `clear` | Leitura/gravação/limpeza | lexical + `requestLibrary`; sem validação de dono (LAN) |
| `/api/video/fallback`, `/transcoded/*` | Probe ffprobe + spawn ffmpeg + cache | lexical + app-dir + **realpath** + hash estrito no cache |
| `/api/subtitles/*` | Jobs whisper, status, editor, clear/cancel | lexical + app-dir + **realpath** + hash estrito |
| `/api/ai/config|status|reset|llm/test` | Config IA, teste de conexão | `maskAiConfig` (chave nunca sai); sem sandbox de URL |
| `/api/logs`, `/api/storage/status`, `/api/system/status` | Leitura | sem path de cliente; expõe paths via logs |
| SPA (`express.static`) | HTML/CSS/JS | CSP + nosniff + referrer + frame |

---

## 4. Vulnerabilidades confirmadas

| # | Cat | Sev | Confirmado | Corrigido |
|---|---|---|---|---|
| V1 | Symlink/junction escape de biblioteca | **HIGH** | Sim (probe) | **Sim** |
| V2 | XSS armazenado via material HTML/SVG/XML/JS/JSON no origin | MEDIUM | Sim (probe de header) | **Sim** |
| V3 | Falta de headers de segurança (nosniff/referrer/frame/CSP) | LOW | Sim | **Sim** |
| V4 | `initials()` insere 1–2 chars crus do nome em markup | INFO | Sim (código) | **Sim** |
| V5 | SSRF restrito no teste de conexão LLM (loopback alcançável) | MEDIUM | Sim (probe) | Não (avaliado) |
| V6 | Sem autenticação + bind LAN (leitura/escrita de dados e jobs) | MEDIUM | Sim (probe) | Não (decisão de arquitetura) |
| V7 | Sem limite de enfileiramento de jobs (DoS por flood da LAN) | LOW | Sim (código) | Não (documentado) |
| V8 | `/api/logs` expõe paths (rel/abs) de cursos | LOW | Sim (probe) | Não (documentado) |
| V9 | Workspace custom configurável remotamente (escrita em dir arbitrário) | LOW | Sim (código) | Não (documentado) |

Detalhes na Matriz de Risco (§36).

---

## 5. Riscos prováveis (não confirmados por falta de cenário, ou contexto)

- **TOCTOU em transcode/whisper**: arquivo validado → trocado por symlink antes do spawn. Mitigado em profundidade: o guard é reavaliado em cada ponto de abertura (fallback oculta do job, pipeline revalida antes da extração). Residual: janela mínima entre validação e spawn de um job já iniciado; aplica-se apenas a quem já escreve no disco da biblioteca.
- **DNS rebinding**: um site malicioso que rebind o domínio para `127.0.0.1` consegue disparar `POST` simples (form/link) contra o app sem CORS (requests simples). Não consegue LER respostas (falta `Access-Control-Allow-Origin`). Risco real de "injeção de requisição" em apps LAN sem auth. Não mitigado (sem cookie de origem, sem Origin check).
- **Downloads de PDFs inline**: PDFs servidos via `/media` continuam inline (types não-ativos). Execução de JS em PDFs fica a cargo do viewer (sandboxed nos browsers modernos); risco residual baixo.
- **`POST /api/progress` aceita qualquer `position/duration` numérico** (incluindo `1e15` — aceito no probe). Não corrompe nada além da própria entrada; sem validação de "limite plausível". Aceito pelo modelo (sem invasão).
- **Falsificação do estado "assistido"**: qualquer cliente da LAN pode marcar concluído qualquer aula. São preferências locais; impacto baixo (só confusão do usuário).

---

## 6. Path traversal

Endpoints com path testados (foque em `/media`, `/api/video/fallback`, `/api/progress`, `/api/progress/clear`, `/api/subtitles/*`, `/api/libraries`):

| Vetor | `/media` | `?path=` (fallback/subtitles) | `/api/progress` |
|---|---|---|---|
| `../..` cru | 404 | 400 invalid path | 400 |
| `..%2F..%2F` | 404 | 400 | 400 |
| `%252e%252e` (2×) | 404 | 400 | 400 |
| Barras invertidas `..%5c..%5c` | 404 | 400 | 400 |
| Absoluto `/etc/passwd` | 404 | 400 | 400 |
| Null byte · unicode | 404 | 400 | 400 |
| `data/`, `models/`, `bin/`, `public/`, `node_modules/` | 404 (app-dir/dotfile) | 404/400 | 400 |

Conclusão: `resolveSafeRelPath()` (lexical, ancorado no path da biblioteca) + `isAppDirRel` + `hasDotSegment` + `requestLibrary` cobrem todas as codificações testadas. Nenhuma rota escapa da biblioteca autorizada **lexicalmente**; o escape real (V1) era via symlink, resolvido por realpath.

---

## 7. SSRF

**Alcance atual:** apenas o endpoint de **teste de conexão LLM** cria HTTP do backend para URL configurada (`POST /api/ai/llm/test` aceita `baseUrl` arbitrária do body e usa `fetch`; `runLlmCorrection` também, mas só com `baseUrl` salva por `/api/ai/config`). O pipeline de legendas não consome URLs além do LLM configurado.

- **Probe loopback:** `baseUrl=http://127.0.0.1:41891` → o servidor executou o fetch (resposta refletida); `http://localhost:41891/...` idem; `169.254.169.254` sem rota na sandbox (timeout).
- **Impacto real em app local:** com bind 0.0.0.0, um cliente LAN pode usar o teste para sondar serviços internos (loopback/hosts da rede) e refletir mensagens de erro dos alvos (`error.message` de `resp.json()` volta ao atacante). Não lê o corpo de respostas em geral; é SSRF **restrito/cega-parcial**.
- **Funcionalidade legítima exige URLs arbitrárias de provedores LLM** (OpenAI-compatible, gateways locais). Corrigir banindo privado/loopback quebraria o caso de uso de gateways locais.
- **Decisão (alinhada ao briefing):** NÃO corrigir indiscriminadamente. Mitigação recomendada (opcional): no **teste** de conexão com `baseUrl` ad-hoc, bloquear hosts de loopback/private quando não corresponderem a um provider salvo; ou exigir confirmação visual do URL. Ver §27.

---

## 8. Command injection

Inventário de subprocessos:

- `ffmpeg`/`ffprobe` (transcode, probe, extração de áudio, detectTool) — `spawn` com **array de args**, `shell:false` por padrão, **sem quoting manual**, sem `-f`/`-c` vindos do usuário.
- `whisper-cli` — `spawn` com array; flags fixas (`-m`, `-f`, `-l`, `-oj`, `-otxt`, opcional `-vad`/`-t`/`-pp`). `model`/`language` vêm de enum validado no config; `threads` numérico. `-l` recebe `language` validado pelo registry.
- Único dado derivado de cliente que entra em argv: o **caminho** do arquivo (`abs`) — array separado, jamais concatenação; caminho com espaços/aspas é seguro por construção.

**Conclusão:** sem shell injection possível a partir de nome de arquivo, caminho, provider, modelo, URL ou opções de IA. `execFileAsync` usa `spawn`. Nenhum `exec`/`execFile` com string única. Confirmado por revisão de todos os call sites.

---

## 9. Filesystem / symlink / TOCTOU

### V1 — Escape por symlink/junction (confirmado e corrigido)

**Problema:** `resolveSafeRelPath` é puramente lexical. Na biblioteca de teste:

```
Curso/link.mp4       → /etc/passwd          → /media/<lib>/Curso/link.mp4 devolveu 200 com o conteúdo
Curso/data-link/     → <outro>/data/        → /media/<lib>/Curso/data-link/progress.json devolveu progresso real
```

Além do serve, **ffprobe/ffmpeg** os processavam (`/api/video/fallback` retornava plano de transcode para `/etc/passwd` e para `ai-config.json` via link) e o **pipeline de legendas** extrairia áudio do alvo. O scan indexava links (como arquivo) e `/media` os seguia.

**Correção aplicada (mínima e multiplataforma):**
1. Novo guard `fileWithinLibrary(lib, abs)` — `realpath(abs)` deve estar dentro de `realpath(lib.path)`. Chamado em: rota `/media/*`, `getTranscodePlan` (fallback/ffmpeg), `POST /api/subtitles/generate` e `runSubtitlePipeline` (defesa em profundidade — cobre jobs reidratados/persistidos).
2. `scanDir` ignora entradas `entry.isSymbolicLink()` (diretórios linkados já não entravam; agora nenhum link vira nó). Barrinho: nenhum symlink no ROOT real.
3. Resultado dos probes pós-fix: `link.mp4` → 404, `data-link/progress.json` → 404, arquivos normais → 200/206 intactos, `secret.txt` → 200.

### TOCTOU

- `probe`/`stat` depois atualização de `mtime` (cache invalidação) e leitura: janela mínima; não introduz privilégio adicional que o atacante já não tenha (precisa escrever no disco da biblioteca).
- Corrida de rename transcode (`serveGrowingFile`): tratada (job completed → serve final). Já documentada e preservada.
- `.tmp` só vira final via `rename` após exit 0 — intacto.

---

## 10. API / input validation

- `express.json({ limit:"100kb" })` limita body.
- Strings truncadas via `clampStr` em todos os campos de config de IA (nome/baseUrl/model/apiKey/workspace.dir) e segundos numeric limits (`maxConcurrent*` ∈ [1,8], threads ∈ [0,16], `llmTimeoutMs` ∈ [1000,120000]).
- `/api/progress`: valida tipos (`position`/`duration` numéricos) e negativo → clamped a 0; **não** limita magnitude (`1e15` aceito) — baixo impacto, documentado.
- `/api/progress/clear`: `coursePath` valido + prefixo por lib; sem argumento limpa global (confirmado — intencional, com `openConfirmDialog` no front).
- Paths absolutamente longos (`50 000` chars) no body → 400 (limite 100kb) ou truncados; sem hash trashing (chaves vão para `sha1`).
- Enum de provider/modelo/idioma validados contra o registry; `correction.providerId` deve existir.
- **Limitação:** sem rate limit por IP sob auth nada (ver DoS), sem `Origin` check.

---

## 11. AI / secrets

- **Armazenamento:** `apiKey` em texto claro em `data/ai-config.json` (modo 644, dentro da pasta do app). Sem cifragem — chave de cifragem teria que ficar no mesmo processo; não compensa num app local single-user. **Documentado; não cifrado por decisão** (§27).
- **Saída:** `maskAiConfig()` troca `apiKey` por `hasApiKey`; `GET /api/ai/config`, `/api/ai/status` e a resposta do `POST /api/ai/config` **nunca** incluem a chave (verificado no probe: `apiKey` ausente, `sk-` ausente no JSON). `reset` (`fs.rm(force)`) apaga o arquivo — funcionou na sandbox.
- **Não servível via web:** `data/` fica na pasta do app, bloqueada por `isAppDirRel` na biblioteca padrão + dotfile/realpath (probes: `/media/_LocalPlayer/data/ai-config.json` → 404). O único vazamento histórico era o symlink (V1, corrigido).
- **Logs/erros:** `sanitizeTestError` (≤160 chars, sem quebras) para todas as mensagens expostas; logs `[SUBTITLE]`/`[AI]` não imprimem chave/prompt; teste LLM loga só `model` + latência. Sem secret em arquivos de log da sandbox (verificado).
- **Backups:** `ai-config.json` não tem backup automático; `.corrupt-<ts>` nunca é gerado para ele nas rotas atuais (só em read). `progress.json` backups não contêm chaves (não há keys lá).
- **Fictício:** o único "key" em disco foi `sk-TEST-KEY-123` criado em sandbox — **nenhum secret real encontrado** na árvore nem no histórico.

---

## 12. Logs

- **Backend:** só stdout + anel em memória (`/api/logs`, máx. 800). Conteúdo: rel paths (`[TRANSCODE] iniciado: Curso/link.mp4`), criação de biblioteca **com path absoluto** (`[LIBRARIES] criada: … → /tmp/...`). Sem chaves/prompts (auditado).
- **Exposição:** `/api/logs` sem auth na LAN entrega rel/abs paths de cursos — baixo impacto (mesmo dado sai em `/api/tree`/`/api/progress`), documentado como V8.
- **Stack traces:** `unhandledRejection`/`uncaughtException` imprimem o objeto de erro no stdout (não no `/api/logs` — o espelho só categoriza `[TAG]`); podem conter caminhos em exceções de fs; aceito para app local (sem arquivo de log persistido).
- Frontend: nenhum dado sensível logado; `validateDisplayTitle` só console.warn.

---

## 13. SSE

**Não existe** nenhum endpoint SSE/EventSource/websocket no projeto (verificado por grep). Não há superfície de conexões persistentes para vazar ou vazar memória.

---

## 14. Frontend

- **Sinks:** múltiplos `innerHTML` — todos com dados do usuário passando por `escapeHtml()` (títulos, nomes, paths, erros) ou `encodeURIComponent()` (atributos data-*). Sinalizador positivo: overlay de legenda usa `textContent` (nunca injeta cue por innerHTML).
- **Vetor real corrigido (V2):** materiais `.html/.svg/.xml/.js/.json` do disco eram servidos com `Content-Type` adequado; se abertos no origin da app, executariam scripts com acesso a `fetch('/api/…')` (sem auth). Prova: `xss.html` respondia `<html><script>…` como `text/html`. **Agora**: `/media` adiciona `X-Content-Type-Options: nosniff` e, para `ACTIVE_EXT`, `Content-Disposition: attachment` (verificado nos headers). CSP da SPA (`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`) limita qualquer falha futura.
- **`initials()`** (V4): retornava 1–2 chars crus do nome do curso em markup; agora escapa (evita abertura de tag tipo `<b`).
- `mediaUrl` (front) e `mediaUrlFromRel` (servidor) codificam por segmento — sem inconsistência.
- Ícones/gradientes por CSS/inline style — sem vetor de injeção {courseColor é hash→hsl, numérico}.

---

## 15. Git

- 1 commit único (`2234070 first commit`), branch `main`, **remote** configurado: `https://github.com/IPauloGermano/local-player.git`. Sem tags.
- **Tracked:** `.gitignore`, `CLAUDE.md`, `README.md`, `docs/DOCUMENTACAO.md|RELATORIO_PIPELINE_LEGENDAS.md|SUBTITLES.md|VALIDACAO.md|whisper.md|images/*`, `package.json`, `package-lock.json`, `public/{app.js,index.html,styles.css}`, `server.js`.
- **Existentes mas NÃO commitados:** `public/scope.js`, `test/*` (6 testes), `docs/{BIBLIOTECAS.md, TOPICOS-MARCADORES.md, AUDITORIA-PROGRESSO.md, AUDITORIA_MULTIPLAS_BIBLIOTECAS.md}`. São código/doc do projeto e deveriam entrar no commit antes de publicar (senão o repo publicado fica sem os testes e sem o helper de escopo referido pelo CLAUDE.md).

## 16. Git history

- `git rev-list --all` = 1 commit; varredura de padrões de segredo (`sk-`, `AIza`, `AKIA`, `ghp_`, `github_pat_`, `xox*`, chaves privadas, `api_key=…`) **no commit**, nos arquivos de texto: **nenhuma ocorrência**.
- Sem reflog/objetos órfãos com histórico anterior (repo iniciado nesta máquina). `data/` e `models/` nunca foram commitados nenhuma vez (em todos os commits o `.gitignore` já os cobria — `git log --all --diff-filter` semantics: 1 commit só).

## 17. .gitignore

Adequado e específico: `node_modules/`, `data/`, `models/`, `bin/`, `*.tmp`, `*.temp`, `*.log`, `.env`/`.env.*` (com exceção de `.env.example`), arquivos de sistema, `.idea/`, `.vscode/*` (mantendo `extensions.json`/`settings.json`), `.claude/settings.local.json`, `.cache/`.

Checagem inversa (não está amplo demais): `package.json`, `package-lock.json`, `public/*`, `server.js` **não** são ignorados (`git check-ignore` negativo). Pontos de atenção: `data/` cobre tudo (correto); nada crítico sob risco de exclusão. Sem `.env.example` ainda (não existem env obrigatórias hoje).

## 18. GitHub readiness

- **Secrets/tracked:** limpo (single commit, sem segredos).
- **Ressalvas antes de publicar:**
  1. Commitar `public/scope.js`, `test/`, `docs/{BIBLIOTECAS,TOPICOS-MARCADORES,AUDITORIA-PROGRESSO,AUDITORIA_MULTIPLAS_BIBLIOTECAS}.md`.
  2. **Revisar manualmente as screenshots** `docs/images/*.png` (anexam em course/player/settings): podem exibir **nomes reais de cursos, paths do usuário, conteúdo privado** — não pude inspecioná-las (modelo sem visão). Verificar usernames/paths/e-mails antes do push.
  3. README usa paths genéricos de exemplo (`/home/user/Biblioteca`, `C:\Users\João\Meus Cursos`) — ok, mas conferir se nenhum exemplo vaza dados reais.
  4. Verificar visibilidade do repo no GitHub (hoje o remote aponta para `IPauloGermano/local-player`); se pretender público, ligar secret scanning/push protection.
- Se já estiver público: o único commit é seguro (sem segredos), mas aplicar as ressalvas acima.

## 19. Dependências

- `package.json`: **Express ^4.19.2** installado `4.22.2` (regularmente patcheado pela linha 4.x). Só uma dependência direta. Express 4 injeta `X-Powered-By`; cosmético, não tratado.
- `npm audit`: **0 vulnerabilidades** (low/mod/high/critical = 0).
- Sem dependências transitive problemáticas no `package-lock` (express/send/serve-static/finalhandler de linha mantida).
- Recomendação: manter `^4.19.2` (recebe patches de segurança da linha 4.x via `npm update`). Não há necessidade de Express 5 neste app.

## 20. Privacidade

| Dado | Local | Sai da máquina? |
|---|---|---|
| Nomes/caminhos de cursos | árvore/progresso/logs | Só LAN (nunca internet); LLM **não** recebe |
| Progresso por aula | `data/progress.json` | Só LAN |
| Legendas (texto) | `data/subtitles` + `.courseplayer` | Ao LLM **apenas** se `correction.enabled` + provider configurado (opt-in explícito) |
| `apiKey` LLM | `data/ai-config.json` | Vai no header `Authorization` **somente** para a `baseUrl` configurada por aquele provider; lança para o provedor `ai/llm/test` se o usuário testar um URL ad-hoc |
| WAV temporário | workspace local | Não saem, apagados (cleanup) |
| Prompts do LLM | — | Texto de legenda enviado ao provider de correção; log não contém prompt |

Onda: todo o restante é estritamente local. A doc (`README.md`) já descreve armazenamento local; o relatório recomenda um parágrafo explícito em `docs/SUBTITLES.md`/README sobre quando dados vão ao LLM (transparência pedida pelo usuário? — adicionada a §27 como recomendação).

## 21. LLM data flow

```
Vídeo → ffmpeg(WAV) → whisper → raw/{hash}.json   ← nunca sobrescrito
  → postprocess local (capitalize/segment/dict)
  → [se correction.enabled] runLlmCorrection:
        baseUrl.replace(/\/+$/,"")+type.chatEndpoint
        payload = segments.map(s=>({id,text}))     ← SOMENTE {id,text}; sem timestamps/raw/audio/arquivos
        Authorization: Bearer <apiKey-do-provider>
        system prompt fixo + JSON dos segmentos
        guardrail: ids válidos, tamanho <40%/>4x, sem duplicar/faltar → senão usa original
  → WebVTT (canônico .courseplayer + espelho data/subtitles/)
```

- **Dados que podem sair da máquina:** o texto transcrito das legendas + a `apiKey` (para o host da `baseUrl` configurada). Nada mais. Ocorre **somente** quando o usuário habilitou correção LLM (default: `enabled:false`, providers vazios).
- **Teste de conexão LLM** envia apenas `"Responda apenas: OK"` (`max_tokens:5`) — nunca conteúdo do curso.
- **Prompts não aparecem em logs.**

## 22. Backups

- `progress.json.bak`, `.bak.1`, `.corrupt-<ts>`, `.tmp`: dentro de `data/` (gitignored, não servidos). Probes: nenhum deles alcançável via URL após bloqueios de app-dir/dotfile. Podem conter nomes de cursos/posições, **nunca** chaves (progress não guarda keys).
- `data/subtitles/backup/`: edições manuais de legendas (JSON). Sem chaves.
- `ai-config.json`: **sem backup** (reset apaga). Guarda a única chave; recomendação: lembrar ao usuário na Central de IA que reset remove a chave (não há cópia).

## 23. Bibliotecas/topics

- `validateLibraryPath`: path absoluto + realpath + proíbe `__dirname`, `public/`, `node_modules`, `DATA_DIR` e `data/` (probes: 400), rejeita aninhamento; **padrão imutável** (PATCH → 403; DELETE → 403). DELETE externa: config-only, jobs ativos → 409, enfileirados descartados.
- **Anti-aninhamento** cobre prefixo/dura (ancestral e descendente).
- IDs UUID; mídia/progresso/cache escopados por `libId\0rel` e `sha1(libId\0rel)[0:24]`.
- **Topics:** marcador `.topic`/`(TP)` não altera nenhum path; o título é só exibição (nunca chave de segurança); `.topic` é dotfile ignorado pelo scan e bloqueado em `/media` (dotfile). Remover marcador não apaga dados (não toca em nada além da árvore).
- **Symlink/junction em bibliotecas novas:** agora bloqueado no serve/processo e no scan (V1).

---

## 24. Correções realizadas

Todas localizadas, sem mudança de arquitetura, validadas:

1. **[V1-HIGH] `fileWithinLibrary` (realpath containment).** Novo helper em `server.js` (junto a `resolveLibraryRel`). Aplicado em: rota `/media/*` (→404), `getTranscodePlan` (→`error`), `POST /api/subtitles/generate` (→400), `runSubtitlePipeline` (job→failed). `scanDir` agora pula `entry.isSymbolicLink()`.
   - **Validação:** probes sandbox → `link.mp4` (→`/etc/passwd`) = **404**; `data-link/progress.json` = **404**; `Curso/secret.txt` = 200; `aula.mp4` com Range = **206**; `fallback` com linker = `"Arquivo não encontrado"`; `generate` = `invalid path`. Arquivos normais intactos.
2. **[V2-MEDIUM] Materiais ativos nunca renderizados no origin.** `ACTIVE_EXT` (`html/htm/xhtml/svg/xml/js/mjs/json`) + `X-Content-Type-Options: nosniff` para todo `/media` + `Content-Disposition: attachment` para ativos.
   - **Validação:** header de `xss.html` → `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment`; `aula.mp4` → sem attachment, `206` com Range.
3. **[V3-LOW] Headers de segurança.** Middleware global: `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (verificado em SPA/API/media). CSP no `express.static(public)`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Página de indisponibilidade (memória, script inline) fica fora do CSP.
4. **[V4-INFO] `initials()`** escapa a saída.

**Não alterados**: `package.json`, formato de dados (`progress.json`, `ai-config.json`, jobs, VTT), rotas/contratos, `HOST` default, editor (desativado por outro pedido).

---

## 25. Problemas que NÃO foram corrigidos (e por quê)

| # | Item | Motivo da não-correção |
|---|---|---|
| V5 | SSRF no teste de conexão LLM | Funcionalidade legítima exige `baseUrl` arbitrária (gateways locais/OpenAI-compat). Mitigação opcional proposta (§27) |
| V6 | Ausência de auth / bind LAN | Decisão de arquitetura documentada (app local single-user). Introduzir auth/cookie mudaria o modelo de uso e exigiria decisão do usuário |
| V7 | Sem rate limit de jobs (DoS leve) | App local; limite por IP seria arbitrário. Recomendações: `MAX_CONCURRENT_*` já limitam concorrência; filas são deduplicadas por hash |
| V8 | `/api/logs` expõe paths | Mesmo dado já exposto por tree/progress; corrigir exigiria mascarar logs |
| V9 | Workspace custom configurável remotamente | Parcialmente mitigado (só grava nas subpastas `audio/`/`work/`; exige pipeline ativo com whisper instalado) |

---

## 26. Riscos restantes

1. **Rede sem auth (MEDIUM no contexto LAN):** qualquer host da rede pode ler (tree/progress/logs/vídeos non-secretos?) e **escrever**: marcar aulas concluídas, limpar progresso global, limpar transcode, disparar scans contínuos, enfileirar transcodes/legendas (uso de CPU/disco), alterar config de IA (incl. `apiKey`/`workspace.dir`). Não consegue ler a `apiKey` (mascarada) — só sobrescrevê-la.
2. **SSRF limitado (V5):** sondagem de loopback/redes internas + reflexo de mensagens de erro dos alvos.
3. **DNS rebinding** para POSTs simples (sem Origin check).
4. **Downloads/PDF inline** (viewer-dependente).
5. **Exposição de metadados** (nomes de cursos, paths, posições de progresso) a qualquer cliente LAN; mesma rede = confiança implícita.
6. **Extensão do processo Whisper/ffmpeg** consome CPU/energía de processo sem auth — pode ser explorada por hosts da LAN (dos leve).
7. **TOCTOU residual mínimo** na janela validação→spawn.

Quem executa o app localmente e NÃO compartilha a rede com desconhecidos tem exposição perto de nula nas práticas: os fix eliminam os vetores que prescindiam de acesso de escrita ao disco.

---

## 27. Recomendações

1. **Rodar o app só no host ou com `HOST=127.0.0.1`** quando não for preciso acessar de outro dispositivo (comportamento já suportado e documentado). Única mitigação de fato para V6/V7/V8/Auth.
2. **Auth opcional futura (arquitetura):** token/bearer em header ou sessão de cookie + `SameSite`; sem isso, não expor à internet.
3. **SSRF (V5, opcional):** no `POST /api/ai/llm/test` com `baseUrl` ad-hoc, resolver o host e bloquear ranges privadas/loopback/link-local **exceto** quando o `host`/`baseUrl` casa com um provider salvo (gateway local continua funcionando). Não bloquear `runLlmCorrection` (só usa providers salvos).
4. **Check de Origin em rotas mutáveis** (defesa contra rebinding): rejeitar POST com `Origin` não esperada quando presente — barato, sem quebrar usuário local.
5. **Antes de publicar no GitHub:** commitar `scope.js`/`test/`/docs novos; **rever screenshots** (`docs/images/*`) e README para dados pessoais; habilitar secret scanning + push protection; considerar Dependabot para a linha Express (ativa em repo público).
6. **Documentação de transparência de IA:** parágrafo em `README.md` e `docs/SUBTITLES.md` "quando seus dados vão ao provedor LLM" (correção habilitada → texto transcrito + chave vão ao host configurado; teste só envia "OK").
7. **`ai-config.json`:** reforçar na Central de IA que "Reset" remove a chave definitivamente (sem backup).
8. **Sem novas dependências** para segurança (stdlib cobre). Manter `npm audit` no workflow.
9. **CI mínima (recomendado, não configurado):** `node --check` + `node --test <6 arquivos>` em GitHub Actions para garantir que os testes (sidebar/scope/library/topics) rodam no repo público.
10. **Revisão periódica:** re-rodar esta auditoria ao adicionar endpoints que abram arquivos ou façam HTTP.

---

## 28. Checklist final

- [x] Todos os endpoints que recebem paths auditados (media, fallback, progress, clear, libraries, subtitles/*, ai)
- [x] Path traversal testado (todas as codificações) — protegido
- [x] Pasta do app (BUG-001) testada (server.js, data/, public/, models/, case mix, dotfiles) — protegido
- [x] SSRF auditado — V5 restrito, documentado
- [x] Subprocessos auditados (ffmpeg/ffprobe/whisper) — sem shell, args fixos
- [x] Symlinks/junctions avaliados — V1 confirmado e corrigido
- [x] API keys auditadas — mascaradas na API; única em disco é `ai-config.json` (não servível)
- [x] Logs auditados — sem chaves/prompts; paths expostos (V8)
- [x] Payloads auditados — limites 100kb + clamps; magnitude de position sem teto (baixo)
- [x] DoS/resource exhaustion avaliado — V7 documentado; concorrência limitada
- [x] SSE auditado — inexistente
- [x] Headers/CORS auditados — V3 corrigido; CORS não presente (sem origem cruzada)
- [x] Frontend XSS auditado — escapeHtml/textContent; V2 e V4 corrigidos
- [x] `.gitignore` auditado — adequado
- [x] Tracked vs ignored verificado — tabela §33; faltam commitar arquivos novos
- [x] Histórico Git pesquisado — 1 commit, sem secrets
- [x] GitHub readiness avaliado — pronto com ressalvas
- [x] Dependências auditadas — npm audit 0
- [x] Privacidade auditada — local; LLM opt-in (§20)
- [x] LLM data flow documentado (§21)
- [x] Backups auditados — sem chaves, não servidos, gitignored
- [x] Bibliotecas/topics auditados (§23) — protegidos; symlink agora bloqueado
- [x] Correções seguras aplicadas e validadas (§24)
- [x] Testes pós-correção: `node --test …` = **55 pass / 0 fail**; probes pós-fix re-executados

---

## 29–35. (Seções intermediárias do briefing cobertas acima)

As seções 1–28 do roteiro estão contempladas; detalhes adicionais pedidos (matriz completa de exposição de rede da seção 2 e 3, teste por endpoint) estão na planilha abaixo (§36) e na seção §3.

---

## 36. Matriz de exposição de rede (endpoints sem auth)

| Endpoint | Métodos | Lê dados | Modifica dados | Executa processo | Risco |
|---|---|---|---|---|---|
| `GET /` , `express.static` | GET | SPA (assets) | — | — | INFO |
| `GET /api/tree[?rescan=1]`, `POST /api/rescan` | GET/POST | Estrutura (nomes/paths) | — (cache) | Scan de disco | BAIXO (vaza metadados; scan repetido = I/O) |
| `GET/POST /api/libraries`, `PATCH/DELETE /:id`, `/:id/rescan` | CRUD | Paths absolutos, nomes | **Config das bibliotecas** | Scan | MÉDIO (pode registrar lib apontando p/ dir lido; não lê fora via API) |
| `GET /api/progress` | GET | **Progresso global (cursos/paths/posições)** | — | — | MÉDIO (privacidade do catálogo) |
| `POST /api/progress`, `clear` | POST | — | **Progresso/limpeza global** | — | MÉDIO (destrutivo: clear global) |
| `GET /api/video/fallback?path=` | GET | — | — | **ffprobe + ffmpeg (cache/CPU/disco)** | MÉDIO/ALTO local — agora realpath-guarded |
| `POST /api/transcode/clear` | POST | — | **Apaga cache + mata jobs** | — | MÉDIO-BAIXO |
| `GET /transcoded/<hash>` | GET | Arquivos de cache | — | — | BAIXO |
| `POST /api/subtitles/generate[_course]`, `status/list/cancel/clear` | POST/GET | Metadados das legendas | **Jobs/fila/legendas** | **whisper (CPU)** | MÉDIO |
| `POST /api/subtitles/save` | POST | — | **Editoria editada** (VTT em .courseplayer) | — | MÉDIO-BAIXO (editor desativado na UI) |
| `GET /subtitles/<hash>.<vtt>` | GET | VTTs por hash (casa com rel) | — | — | BAIXO |
| `GET /api/ai/status|config` | GET | Config (chave mascarada) | — | Detecta tool/arquivos | BAIXO |
| `POST /api/ai/config|reset` | POST | — | **Config de IA (`apiKey`, workspace, limites)** | — | MÉDIO (destrutivo: reset) |
| `POST /api/ai/llm/test` | POST | Reflexo de msg de erro de alvo | — | **Fetch arbitrário (`baseUrl`)** | MÉDIO (SSRF restrito) |
| `GET /api/logs` | GET | Anel de logs (paths) | — | — | BAIXO |
| `GET /api/storage/status` | GET | Espaço do cache | — | dirSize (I/O) | BAIXO |
| `GET /api/system/status` | GET | Estado de disponibilidade | — | fs.access | INFO |

---

## 37. GitHub — antes de tornar público

- [x] Sem secrets no working tree
- [x] Sem secrets no histórico (1 commit verificado)
- [x] `.env*` / `data/` / `models/` / `bin/` / logs / tmp ignorados
- [ ] `public/scope.js`, `test/`, `docs/BIBLIOTECAS.md`, `docs/TOPICOS-MARCADORES.md`, `docs/AUDITORIA-PROGRESSO.md`, `docs/AUDITORIA_MULTIPLAS_BIBLIOTECAS.md` **commitados**
- [ ] Screenshots `docs/images/*` revisadas manualmente (verificar nomes de cursos, paths, e-mails)
- [x] README sem dados privados (paths são exemplos genéricos — conferir)
- [x] `package-lock.json` presente e auditado (npm audit = 0)
- [ ] Branch/proteção e visibilidade do repo decididas
- [ ] (Recomendado) Dependabot + secret scanning + push protection (GitHub) e CI mínimo (`node --check` + testes)

Não habilitei nada automaticamente.

---

## 38. Resultado final

| Dimensão | Classificação |
|---|---|
| **SEGURANÇA** | **BOA** (após as 4 correções; restam riscos de arquitetura LAN) |
| **GIT/GITHUB** | **PRONTO COM RESSALVAS** (commitar arquivos novos + revisar screenshots) |
| **PRIVACIDADE** | **ADEQUADA** (dados locais; LLM opt-in explícito) |
| **DADOS** | **ADEQUADOS** (persistência atômica + backup; sem vazamento p/ web após os fixes) |
| **RECOMENDAÇÃO** | **PODE PUBLICAR COM RESSALVAS** |

### TOP 10 problemas (mais importantes)

1. Symlink/junction dentro da biblioteca expõe/processa arquivos fora dela — **corrigido** (era HIGH).
2. Ausência de autenticação com bind LAN (leitura do progresso/catálogo + escrita destrutiva + jobs) — decisão de arquitetura.
3. SSRF restrito do teste de conexão LLM (loopback) — mitigação opcional em aberto.
4. Mataria XSS armazenado via material HTML/SVG/XML/JS/JSON no origin — **corrigido**.
5. Falsa de scripts ativos em PDFs via viewer (baixo, residual).
6. `/api/progress` e `/api/tree` sem auth expõem metadados do catálogo na LAN.
7. `/api/logs` expõe rel/abs paths de cursos.
8. Sem limite de enfileiramento de jobs (DoS leve por host da LAN) — concorrência limitada em `MAX_CONCURRENT_*`.
9. DNS rebinding para POSTs simples (sem Origin check).
10. `ai-config.json` em texto claro (sem cifragem — aceito para app local; documentado).

### TOP 10 ações recomendadas

1. Rodar com `HOST=127.0.0.1` a menos que precise acessar de outro dispositivo.
2. Commitar `public/scope.js`, `test/` e docs novos antes de publicar no GitHub.
3. Revisar manualmente `docs/images/*.png` antes do push.
4. (Opcional) Bloquear ranges privadas/loopback no teste de conexão LLM ad-hoc (mantendo providers salvos).
5. (Opcional) Validar `Origin` em rotas mutáveis (anti-rebinding).
6. Habilitar secret scanning + push protection + Dependabot no repo público.
7. Adicionar CI mínimo (`node --check` + `npm test` com os 6 arquivos).
8. Documentar no README/SUBTITLES quando os dados vão ao provedor LLM.
9. Reforçar na Central de IA que "Reset de IA" remove a chave sem backup.
10. Regerar a chave LLM se ela já tiver sido digitado em algum app/URL injection; nunca commitá-la.

---

*Fim da auditoria. Probes reutilizáveis estão em `/tmp/opencode/probe.sh` (sandbox em `/tmp/opencode/audit-lib`, servidor de teste na porta 41892 — não chega ao repositório).*