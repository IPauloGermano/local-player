# Auditoria — Múltiplas Bibliotecas

> Relatório de viabilidade e arquitetura para a feature **"Bibliotecas externas configuráveis pelo frontend"**.
> **Nenhuma linha de código foi alterada nesta etapa** — apenas auditoria, arquitetura, riscos, API, modelo de dados, migração e plano.

---

## 1. Estado atual

O Local Player usa **uma única raiz de biblioteca**, derivada da localização do app:

```js
// server.js:15
const ROOT = path.resolve(__dirname, ".."); // pasta-pai do app (raiz da biblioteca)
```

- O app vive em `ROOT/_LocalPlayer/`; `ROOT` é a pasta-pai que contém as pastas de curso.
- `ROOT` nunca é hardcoded: deriva de `__dirname`, então o app pode ser copiado para qualquer drive.
- `APP_DIR_NAME = path.basename(__dirname)` (a pasta `_LocalPlayer`) é **excluída do scan** e **bloqueada no serviço de mídia** (BUG-001 já fechado).

Toda a stack — scan, mídia, progresso, transcode, legendas, frontend — assume implicitamente **exatamente uma raiz**.

## 2. Dependências atuais de ROOT

Inventário completo de usos de `ROOT` em `server.js` (auditado por grep, com linhas reais):

| # | Subsystem | Local | O que faz com `ROOT` |
| --- | --- | --- | --- |
| 1 | **Definição** | `server.js:15` | `ROOT = path.resolve(__dirname, "..")` |
| 2 | **Scan** | `server.js:645` (`getTree`) | `scanDir(ROOT, "")` — monta a árvore da biblioteca; cache em `treeCache` (uma árvore global, linha 150). |
| 3 | **Path resolution** | `server.js:655–666` (`resolveSafeRelPath`) | **Ponto central**: `path.resolve(ROOT, normalized)` + checagem de contenção `abs.startsWith(ROOT + path.sep)`. Fecha o escopo da raiz no closure. |
| 4 | **App-dir guard** | `server.js:673–681` (`isAppDirRel`) | Bloqueia o primeiro segmento do rel = `APP_DIR_NAME` (case-exato Linux, case-insensitive Windows). |
| 5 | **Media** | `server.js:4733–4744` (middleware `/media`) | `resolveSafeRelPath(rel)` + `isAppDirRel` antes de servir. |
| 6 | **Media (vídeo)** | `server.js:4751–4768` | `res.sendFile(safe.abs)` — Range completo, origem direta. |
| 7 | **Media (materiais)** | `server.js:4770–4773` | `express.static(ROOT, { dotfiles: "ignore", index: false })` — materiais não-vídeo. |
| 8 | **Progresso** | `server.js:4061–4081` (`POST /api/progress`) | Chave = `safe.rel` (path relativo **sem** escopo de biblioteca). `POST /api/progress/clear` (4083+) usa prefixo de `coursePath`. |
| 9 | **Transcode (hash)** | `server.js:935–939` (`transcodeCacheName`) | `sha1(rel).slice(0,24) + ".mp4"` — **colisão lógica entre bibliotecas com o mesmo rel**. |
| 10 | **Transcode (jobs/cache)** | `server.js:1037,1042–1276` | `transcodeJobs` Map keyed por `cacheName`; `TRANSCODE_DIR/data/transcoded`; rota `/transcoded/*` (4780+) serve por hash (não resolve path). |
| 11 | **Legendas (hash)** | `server.js:2188–2190` (`subtitleCacheName`) | `sha1(rel).slice(0,24)` — **mesma colisão**. |
| 12 | **Legendas (VTT canônico)** | `server.js:2196–2201` (`courseSubtitlePath`) | `path.join(ROOT, courseName, ".courseplayer/subtitles", hash+".vtt")` — vive **dentro da biblioteca**; ignorado pelo scan (dotfile). |
| 13 | **Legendas (espelho/temporários)** | `data/subtitles/raw|processed|edited|backup|work` + `jobs.json` | Tudo keyed por `subtitleCacheName(rel)`. |
| 14 | **Legendas (rotas)** | `status/generate/generate-course/editor/save/export/ai-corrections/cancel/clear` (`3905,3948,3984,4427,4615,4634,4704`) | Recebem `path` (rel) → hash; servem/salvam a partir de `data/subtitles` e do `.courseplayer` da biblioteca. |
| 15 | **Pré-geração P2/P3** | `maybePregenFirstLessons` (course roots do scan) → `scheduleSubtitlePregen` (`4047,4053`) | Itinerante sobre a árvore consolidada. |
| 16 | **Sonda de disponibilidade** | `server.js:4178–4230` (`getSystemStatus`) | `probe(ROOT)` detecta pendrive ausente (`ENOENT`/`device`/`timeout`). |
| 17 | **Boot/log** | `server.js:5061` | `console.log("Biblioteca: ROOT")`. |

**Frontend** (`public/app.js`) — assunções de raiz única:

- `state.tree` = árvore única; `loadAll()` faz `fetch("/api/tree")` + `fetch("/api/progress")` (`346–383`).
- `mediaUrl(relPath)` = `"/media/" + encodeURIComponent-por-segmento` (`324–325`) — sem escopo de biblioteca.
- Rotas por hash: `#/course/<path>`, `#/topic/<path>`, `#/settings` (`route()`, `5618+`).
- Progresso keyed por `video.path` (rel) em `state.progress[path]` (vários pontos: `396,444,2276,2471,2507,2520,2686,2745`).
- Favoritos keyed por `course.path` em localStorage (`course-favorites`, linhas 16–29).
- `collectAllCourses`/`collectAllFolders`/`findNodeByPath`/`flattenVideos`/`flattenMaterials` operam sobre a **única** árvore.
- Settings: `SETTINGS_CATS` (`743–750`) data-driven com abas (`geral/reproducao/atalhos/ia/dados/diagnostico`) — **adicionar "Bibliotecas" é um item na lista**.

## 3. Problemas arquiteturais

1. **`resolveSafeRelPath` captura `ROOT` no closure** (linha 15→659). É o chokepoint único de segurança de path — precisa ganhar escopo de biblioteca sem perder o guard atual.
2. **Identidade de path não é mais suficiente**: duas bibliotecas podem ter `Curso/Aula1.mp4` idêntico. Progresso, favoritos, hashes de transcode/legendas e rotas de mídia precisam de `libraryId`.
3. **Hash `sha1(rel)` colide logicamente** entre bibliotecas → caches de transcode e legendas misturados (Fases 9–10).
4. **Contrato da árvore**: o frontend espera uma árvore; com N raízes precisa decidir entre árvore consolidada ou lista de árvores (Fase 7).
5. **`express.static(ROOT)`** serve a biblioteca padrão; com múltiplas raízes precisa virar N static escopados (um por biblioteca), preservando o bloqueio do `_LocalPlayer`.
6. **Sonda de disponibilidade** (`getSystemStatus`) é de ROOT; com bibliotecas externas, cada biblioteca tem seu próprio status (pendrive removível).
7. **Pré-geração de legendas** e **clear de progresso/transcode/legendas** precisam ser por-biblioteca.

## 4. Modelo de dados

Campos **necessários** (nada além disso):

```ts
interface Library {
  id: string;        // ID estável e opaco, NUNCA derivado de nome nem de path
  name: string;      // nome de exibição (editável pelo usuário)
  path: string;      // path absoluto canônico (armazenado no backend; validado na criação)
  enabled: boolean;  // ativa/inativa — desativada não é escaneada nem servida
  isDefault: boolean;// biblioteca derivada de ROOT; imutável; não removível no MVP
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  lastScanAt: number | null; // epoch ms do último scan bem-sucedido
}
```

- **`status`/`error` NÃO são persistidos**: são **derivados por scan/probe** (a disponibilidade física de um pendrive muda; persistir status seria mentira no boot). `status` computado: `disabled` | `ok` | `unavailable` (+ `error` mensagem).
- **ID estável**: `crypto.randomUUID()` gerado na criação. Sobrevive a rename (de nome **e** de path). Nenhum ID derivado de `name`/`path` — renomear nunca muda a identidade, e o ID não vaza nada do filesystem.
- **`isDefault`**: persistido `true` apenas na biblioteca semeada de ROOT. MVP: não pode ser removida nem ter o path alterado (ver §17). Não é "derivável por path" porque edição de path a quebraria silenciosamente.

## 5. Persistência

- **Local**: `data/libraries.json` (dentro de `data/`, já gitignored) — padrão do projeto (config de IA vive em `data/ai-config.json`; progresso em `data/progress.json`). **Não** em localStorage (fonte de verdade é o backend).
- **Schema**: `{ version: 1, libraries: Library[] }`.
- **Primeira execução** (`initLibraries()` no boot): se o arquivo não existir → semeia a **biblioteca padrão**:
  ```js
  { id: uuid(), name: "Biblioteca principal", path: ROOT, enabled: true, isDefault: true, ... }
  ```
  → **o usuário atual não precisa configurar nada**; o app continua idêntico.
- **Escrita**: mesmo padrão do progresso — `writeFileAtomic` + backup `libraries.json.bak` + corrompido → `libraries.json.corrupt-<ts>` (reusa `readJsonFile`, linhas 685+).
- **Diretório inexistente**: biblioteca **permanece cadastrada** (regra de pendrive removível) com `status:"unavailable"` — só não é escaneada/servida. (Necessário: o usuário precisa poder registrar um mount que hoje está desmontado.)
- **Biblioteca removida**: registro removido do array; **nada no disco é tocado** (§ REQUISITO OBRIGATÓRIO).

## 6. Path resolution

O ponto mais crítico. Três níveis de confiança, **explicitamente separados**:

| Nível | Origem | Uso |
| --- | --- | --- |
| **Config confiável** | `data/libraries.json` (backend) | `path` canônico da biblioteca, validado na criação; **única fonte** de raízes permitidas |
| **Proposta do frontend** | body de `POST/PATCH /api/libraries` | Apenas um **path proposto**, validado/canonicalizado uma vez na criação; nunca reutilizado em operações de mídia |
| **Path de mídia** | query/path de rotas de mídia/progresso/subtitles | **Sempre** `libraryId + relPath`; nunca absolute path enviado pelo navegador |

Regras de validação na criação (canonicalização):

1. Deve ser **absoluto** (após `path.resolve`). Relativos → rejeitados.
2. `path.resolve` → se o diretório **existe**, `fs.realpath` (resolve symlinks/junctions; no Windows resolve junction também) → guarda o **canônico resolvido**.
3. Rejeitar: vazio, `..` (traversal), NUL, string não-string.
4. Se o diretório **não existe**: permite cadastrar (regra de pendrive), valida só sintaxe; status `unavailable` até reaparecer.
5. Regras de segurança da Fase 13 (rejeição de app-dir/data/public/node_modules/nesting).

**Operações posteriores**: `LibraryId + relativePath` **sempre**. O relativo passa por um `resolveLibraryRel(lib, rel)` análogo ao `resolveSafeRelPath` (contenção contra `lib.canonicalPath`, rel canônico com `/`). O `resolveSafeRelPath` atual vira um caso particular (biblioteca padrão) ou é substituído por um wrapper — mantendo o contrato de rel com `/` e o guard do `_LocalPlayer`.

## 7. Scan

- **`scanLibrary(lib)`**: roda `scanDir(lib.root, "")` com `try/catch` próprio. Falha → retorna `{ status:"unavailable", error }` **sem lançar** — uma biblioteca indisponível **não derruba as demais**.
- **`scanAllLibraries()`**: itera as bibliotecas **sequencialmente** (sem `Promise.all`). Pendrives/discos externos lentos: paralelismo indiscriminado martela o barramento/USB e causa seeks concorrentes. Sequencial é o default seguro; paralelizar (por device físico) fica como otimização futura.
- **Cache individual**: `treeCache` vira `Map<libraryId, { tree, scannedAt }>` (ou objeto keyed por id). `GET /api/tree?rescan=1` / `POST /api/rescan` forçam re-scan; `POST /api/libraries/:id/rescan` força **só** uma biblioteca.
- **Biblioteca desativada**: não é escaneada; árvore ausente.
- **Biblioteca removível ausente**: `status:"unavailable"`; árvore ausente; as outras seguem.
- **Erro de uma biblioteca**: status/error próprios; cache individual não corrompe o das outras.
- **`scheduleSubtitlePregen`** (P2/P3): itera **todas** as árvores de curso-roots de todas as bibliotecas escaneadas com sucesso.

## 8. Árvore consolidada

**Opção A — lista de `{ library, tree }`** (recomendada):

```json
{
  "libraries": [
    { "id": "…", "name": "Cursos SSD", "status": "ok", "lastScanAt": 123, "tree": { … } },
    { "id": "…", "name": "Pendrive", "status": "unavailable", "error": "…", "tree": null }
  ]
}
```

**Opção B — árvore única com `libraryId` em cada nó**: um nó `Curso/Python` em A e em B teriam o mesmo `path` — `findNodeByPath`, `flattenVideos`, `collectAllCourses` (recém-construídos para tópicos) e o roteamento por path **quebrariam ou exigiriam `(libraryId, path)` em todo canto**, com risco permanente de ambigüidade.

**Por que A**: (1) preserva a semântica atual de "`path` relativo é único **dentro de uma raiz**" — cada biblioteca é uma raiz; (2) a identidade `libraryId + relPath` é explícita e trivial; (3) distinção "Python da biblioteca A" vs "Python da biblioteca B" é natural (cada um vive na sua árvore); (4) menos regressão nos walkers de tópicos. O frontend itera `state.libraries`, agrupa a Home por biblioteca e usa rota `#/course/<libraryId>/<relPath>` (idem `#/topic/`).

**Trade-off aceito de A**: mudança de contrato do frontend (rota com `libraryId`) e da Home (agrupada por biblioteca). Links legados `#/course/<relPath>` e `/media/<relPath>` degradam para a **biblioteca padrão** (§17).

## 9. Progresso

**Crítico.** Hoje a chave é só o rel (`progress[safe.rel]`). Com N bibliotecas, `Curso/Aula1.mp4` em A e B colidiriam.

**Nova chave lógica**: `libraryId + "\0" + relPath` (separador `\0` — NUL é impossível em nomes de arquivo, então é inequívoco; em JSON vira `\u0000`).

**Migração segura e reversível** (no boot, `migrateProgressKeys()`):

1. Lê `data/progress.json`.
2. Chaves **sem** `\0` (formato legado) → remap para `<defaultId>\0<key>`.
3. Escreve o novo objeto com `writeFileAtomic` — o backup `progress.json.bak` (mecanismo existente, linhas ~770) preserva o estado pré-migração.
4. Chaves que já contêm `\0` → intocadas (idempotente entre boots).

**API**: `POST /api/progress` aceita `{ libraryId?, path, position, duration, completed }` (sem `libraryId` → biblioteca padrão, back-compat). `POST /api/progress/clear` aceita `{ libraryId?, coursePath }` (clear por prefixo dentro da biblioteca). Validação via `resolveLibraryRel`. **Progresso existente não é perdido nem zerado.**

## 10. Transcoding

**Análise da colisão**: `transcodeCacheName(rel)` = `sha1(rel)[0:24]`. Com bibliotecas A e B ambas com `Curso/Aula1.mkv`, o hash seria **idêntico** → o segundo sobrescreveria/atenderia o cache do primeiro. **Confirma-se colisão lógica.**

**Fix**: `transcodeCacheName(libraryId, rel)` = `sha1(libraryId + "\0" + rel)[0:24] + ".mp4"`.

**Todos os consumidores do hash** (devem usar a MESMA derivação):
- `transcodeCacheName` (935–939) — único ponto de derivação.
- `startTranscodeJob` (1042–1063) — Map keyed por `cacheName`; job guarda `rel` e, agora, `libraryId` (para mensagens de erro/progresso).
- `fallback` (1236–1276) — `POST /api/video/fallback?libraryId=&path=` → cacheName derivado da dupla.
- `/transcoded/*` (4780+) — **servidor serve por hash opaco; nenhuma mudança** (o nome do arquivo é o hash; não resolve path). URL continua `/transcoded/<24hex>.mp4`.
- `POST /api/transcode/clear` — limpa `TRANSCODE_DIR` inteiro; inalterado.

**Efeito da mudança de hash**: cache antigo fica órfão (hashes velhos não re-deriváveis). Cache de transcode é **descartável** (re-deriva sob demanda) — aceitável; documentar. **Não** fazer lookup duplo no MVP.

## 11. Subtitles

**Mesma análise**: `subtitleCacheName(rel)` = `sha1(rel)[0:24]` (2188–2190) — colisão entre bibliotecas.

**Fix**: `subtitleCacheName(libraryId, rel)` = `sha1(libraryId + "\0" + rel)[0:24]`.

**Impacto completo** (todos os consumidores):

| Artefato | Hoje | Com bibliotecas |
| --- | --- | --- |
| `raw/processed/edited/backup` em `data/subtitles/` | keyed por `subtitleCacheName(rel)` | keyed por `subtitleCacheName(libId, rel)` — sem colisão |
| `jobs.json` | keyed por hash | idem |
| **VTT canônico** | `path.join(ROOT, curso, ".courseplayer/subtitles", hash+".vtt")` (`courseSubtitlePath`, 2196) | `path.join(lib.canonicalPath, curso, ".courseplayer/subtitles", hash+".vtt")` — **move com a biblioteca**; `.courseplayer` continua invisível no scan (dotfile) |
| Rotas `status/generate/generate-course/editor/save/export/ai-corrections/cancel/clear` (3905,3948,3984,4427,4615,4634) | `path` (rel) → hash | + `libraryId` → hash; resolução via `resolveLibraryRel` |
| Rota `/subtitles/<hash>.vtt` (4704) | valida `subtitleCacheName(safe.rel) === hash` | valida `subtitleCacheName(libId, safe.rel) === hash`; busca o VTT na biblioteca correta |

- **Espelho** `data/subtitles/<hash>.vtt` continua servindo de fallback (via `readSubtitleArtifacts`), agora keyed por hash com `libraryId`.
- **Sem `libraryId`** nas rotas legadas → biblioteca padrão (back-compat).
- **Efeito da mudança de hash**: raws antigos órfãos; re-derivação sob demanda (pipeline regenera). Aceitável; **raw nunca é sobrescrito** — só se torna órfão. Documentar.
- **`.courseplayer`** (legendas) permanece com propósito distinto e intocado pela classificação de tópicos; a única mudança é o root da biblioteca na derivação do caminho canônico.

## 12. Frontend

Nova área **Configurações → Bibliotecas** (aba em `SETTINGS_CATS`, linha 743):

- **Lista** por biblioteca: nome, path, badge de status (`✓ Disponível` / `⚠ indisponível` / `Desativada`), nº de cursos (do cache da árvore), ações **por biblioteca**:
  `[Reescanear]` `[Editar]` `[Ativar/Desativar]` `[Remover]` — e `[Adicionar]` global.
- **Adicionar/Editar**: diálogo com campo de **path** (paste/typed, ver §12-seleção) + nome + switch "ativa".
- **Remover**: diálogo de confirmação (`openConfirmDialog` existente, sem `confirm()` nativo) com texto explícito — ver § REQUISITO OBRIGATÓRIO. Botão **desabilitado na biblioteca padrão**.
- **Home**: agrupa por biblioteca (cabeçalho com nome) ou num grid único com selo de biblioteca no card — MVP: agrupado com cabeçalho simples. Cards de curso/tópico reutilizam `renderNodeCard`.
- **Roteamento**: `#/course/<libraryId>/<relPath>` e `#/topic/<libraryId>/<relPath>`; legado sem `libraryId` → padrão.
- **`mediaUrl(rel)`** → `mediaUrl(libId, rel)` = `/media/<libId>/<rel>…`; legado `/media/<rel>` → padrão.
- **Progresso**: `state.progress["<libId>\u0000<rel>"]`; favorites keyed por `libId + "\0" + path`.
- **Busca**: itera `state.libraries` (resultado leva `libraryId`); Enter roteia com o `libraryId`.
- **Continue-watching / Seu progresso**: `collectAllCourses` por biblioteca.
- **Tópicos**: comportamento inalterado dentro de cada biblioteca (classificação por marcador é do scan, já multi-raiz uma vez que `scanDir` recebe o root da biblioteca).

## 13. Seleção de diretório

**Limitação real do navegador**: um navegador web **não** consegue abrir um seletor nativo de diretório do **servidor**.
- `<input type="file" webkitdirectory>` devolve apenas arquivos do **cliente** (a máquina do usuário), com **nomes relativos e sem path absoluto** — inútil para cadastrar um diretório da máquina onde o backend roda (e o cliente raramente é o servidor).
- Seletor nativo de filesystem (Electron/Tauri) exige shell desktop — fora do escopo (projeto sem framework).
- **Conclusão explícita**: a UX tecnicamente viável é **digitação/colagem do path absoluto** no formulário. Complemento opcional (nice-to-have, não MVP): endpoint `GET /api/libraries/browse?path=` que **lista subdiretórios** de um path do servidor (read-only, validado) para facilitar a digitação — no Linux sugere `/mnt`, `/media`, `/run/media/$USER`; no Windows, letras de unidade `C:\`… `Z:\`. A UX continua sendo paste/typed; o browse só autocompleta.

## 14. Segurança

Regras de **rejeição de registro** (na criação/PATCH de path):

1. **Traversal / relativos / vazios / NUL**: rejeitados (`path.resolve` + checagem explícita de `..`).
2. **Symlinks/junctions**: canonicalizar com `fs.realpath` (quando o dir existe) e validar o **alvo resolvido** — um symlink apontando para dentro de `_LocalPlayer/data` é rejeitado mesmo que o link literal pareça inofensivo.
3. **Diretórios proibidos** (rejeitados — reapresentam o BUG-001):
   - `ROOT/_LocalPlayer` (o próprio app)
   - `ROOT/_LocalPlayer/data` (progresso, ai-config, caches)
   - `ROOT/_LocalPlayer/public` (SPA)
   - `ROOT/_LocalPlayer/node_modules`
   - qualquer ancestral ou descendente desses.
4. **Biblioteca dentro da biblioteca** (nested): rejeitado — nova biblioteca **não** pode ser ancestral nem descendente do root de uma biblioteca já cadastrada (exceto o caso em que é exatamente o ROOT padrão). Impacto de permitir: a mesma pasta seria servida por duas raízes, o relPath ficaria ambíguo e progresso/hashes duplicariam. **Decisão documentada: rejeitar com erro claro.**
5. **Própria ROOT**: permitido (é a biblioteca padrão). Registrar explicitamente ROOT como não-padrão → vira duplicata de root → rejeitado (já é o default).
6. **Caso sensitivity**: guard de app-dir existente (`isAppDirRel`) é case-exato no Linux e case-insensitive no Windows — manter; estender aos diretórios proibidos.
7. **Mídia**: a resolução **sempre** parte de `libraryId → registry → canonicalPath → rel contido`; o absolute path do cliente **nunca** chega ao serving. `/media//etc/passwd` → rel vazio → 404. `/media/<libId>/../../etc` → contenção rejeita.
8. **`express.static`**: um static **por biblioteca**, escopado ao root dela (dotfiles ignore + index false). Para a biblioteca padrão, mantém o bloqueio do `_LocalPlayer`. Bibliotecas externas não podem conter o app-dir (rejeitado na criação), logo não há nova exposição.

## 15. Linux

- Paths absolutos `/mnt/…`, `/media/…`, `/run/media/<user>/…` — **SUPPORTED** (path APIs + sendFile + static).
- Spaces/acentos/parênteses/unicode — **SUPPORTED** (encoding por segmento; testes de tópicos já cobrem unicode).
- Pendrive removível — **SUPPORTED** com status `unavailable` (sonda por `fs.access` + `isDeviceUnavailableCode`, padrão de `getSystemStatus`, 4184–4204).
- Case-sensitive — respeitado (guard por case-exato).

## 16. Windows

Classificação:

| Caso | Classificação | Observações |
| --- | --- | --- |
| `C:\Cursos`, `D:\Biblioteca`, `E:\Conteudo` | **SUPPORTED** | `path.resolve`/`sendFile`/`express.static` lidam com drive letters; `path.join` já usado em todo o código |
| Caminhos com espaço/acentos/parênteses/unicode | **SUPPORTED** | encoding por segmento + APIs de path |
| Paths relativos | **NOT_SUPPORTED** (rejeitados por regra) | precisa de absoluto |
| UNC `\\server\share\Cursos` | **PARTIALLY_SUPPORTED** | Node path APIs e sendFile costumam funcionar sobre SMB; riscos: permissões, latência, comportamento de `realpath`/probe e Range em share lento. **Não bloqueado**, mas fora do alvo principal do MVP |
| Junctions | **SUPPORTED** (com canonicalização) | `fs.realpath` resolve junction; validar o alvo |
| Case-insensitive | **SUPPORTED** | guard de app-dir já trata (`first.toLowerCase()`) |

## 17. API

Endpoints (método/path/input/erros/segurança):

### `GET /api/libraries`
- **Output**: `{ libraries: [{ id, name, path, enabled, isDefault, status, error, lastScanAt, courseCount }] }`. `status` computado por probe/último scan; `courseCount` do cache da árvore.
- **Erros**: 500 (registry ilegível). Sem body.
- **Segurança**: read-only.

### `POST /api/libraries`
- **Input**: `{ name?, path, enabled? }`.
- **Output**: `201 { library }` (biblioteca criada, já escaneada) ou `{ libraries }` atualizado.
- **Erros**: `400` path inválido/vazio/relativo/traversal; `409` já cadastrada / aninhada / aponta para diretório proibido; `413`? (não). 
- **Segurança**: path validado/canonicalizado uma única vez; nunca reutilizado como confiável depois.

### `PATCH /api/libraries/:id`
- **Input**: `{ name?, enabled?, path? }` (qualquer combinação; `path` revalidado como no POST).
- **Output**: `{ library }` atualizado + `{ libraries }`.
- **Erros**: `404` id inexistente; `400` path inválido; `409` conflitos; `403` **biblioteca padrão: path imutável no MVP** (name/enabled permitidos).
- **Segurança**: validação de path idêntica ao POST.

### `DELETE /api/libraries/:id`
- **Input**: só `:id`. **Não aceita** `?path=` nem body com path absoluto.
- **Output**: `{ libraries }` atualizado (sem a removida).
- **Erros**: `404` id inexistente; `403` biblioteca padrão (MVP: não removível); `409` **jobs ativos** para a biblioteca (política de bloqueio — ver REQUISITO OBRIGATÓRIO).
- **Segurança / política de remoção**: **somente configuração**. `NENHUM` `rm`/`fs.rm`/`fs.rmdir`; nenhum arquivo da biblioteca tocado; progresso e caches **não** apagados. Ver § REQUISITO OBRIGATÓRIO.

### `POST /api/libraries/:id/rescan`
- **Input**: `:id`.
- **Output**: `{ library }` com `status/lastScanAt/error` atualizados (e cache da árvore daquela biblioteca).
- **Erros**: `404`; `409` scan já em andamento para essa biblioteca (deduplicado); `200` com `status:"unavailable"` se o diretório sumiu (não é erro de rota).
- **Segurança**: só biblioteca cadastrada.

### Endpoints adicionais
- `GET /api/libraries/browse?path=<dir>` — **opcional** (auxílio à seleção): lista subdiretórios de um path absoluto do servidor; sem path → raízes (drives no Windows, `/mnt`+`/media`+`/run/media` no Linux). Read-only, valida path (fora de app-dir), nunca segue para conteúdo de arquivo.

**Os 5 endpoints-base são suficientes para o MVP.** `browse` é o único extra recomendado (melhora a UX de seleção sem mudar a arquitetura).

### Contrato dos endpoints existentes (atualização)
- `GET /api/tree` → `{ libraries: [...] }` (Fase 7, opção A). `POST /api/rescan` → re-scan de todas.
- `POST /api/progress` e `/api/progress/clear` → + `libraryId` (default quando ausente).
- `POST /api/video/fallback` → + `libraryId`; URL `/transcoded/<hash>` inalterada.
- `POST /api/subtitles/*` e `GET /api/subtitles/*` → + `libraryId` (default quando ausente).
- `/media/<rel>` → `libraryId` no 1º segmento quando casa com um id cadastrado; senão biblioteca padrão (back-compat).

## 18. Migração

**Sem ação do usuário.** Sequência no boot (`initLibraries()` + `migrateProgressKeys()`):

1. `data/libraries.json` ausente → semeia a **biblioteca padrão** com `path: ROOT` (compatibilidade total: o usuário atual não configura nada).
2. Progresso legado (chaves sem `\0`) → remap para `<defaultId>\0<rel>` em escrita atômica (backup preserva o estado pré-migração — reversível).
3. Links legados (`#/course/<rel>`, `/media/<rel>`, `/api/subtitles/*?path=`, `/api/video/fallback?path=`) → **biblioteca padrão**.
4. Hashes de transcode/legendas mudam de namespace → caches antigos ficam órfãos (descartáveis; regeneram sob demanda). Documentado; **nada é apagado**.
5. `libraries.json` escrita atômica + `.bak` + `.corrupt-<ts>` — mesmo contrato de durabilidade do progresso.

Estado antes → depois:

```
ROOT
└── cursos            ──►  libraries.json
└── _LocalPlayer            ├─ default      → ROOT (isDefault, imutável)
                            ├─ external-1   → /mnt/hd/Treinamentos
                            └─ external-2   → /run/media/user/KINGSTON/Aulas
```

## 19. Arquitetura proposta

Mínima, sem refatoração geral do `server.js`. **Não classes por padrão** — objetos/módulos-função:

- **`LibraryRegistry`** — carrega/salva `data/libraries.json`; mantém o array em memória; `get(id)`, `getDefault()`, `all()`, `create()`, `update()`, `remove()`. **Validação/canonicalização de path** (regras da Fase 13) mora aqui. Invariantes: fonte única de verdade; IDs imutáveis; default imutável; paths sempre canônicos.
- **`LibraryScanner`** — `scanLibrary(lib)` + `scanAllLibraries()` sequencial + **cache por biblioteca** (`Map<libraryId,…>`); `getTree(force)` consolida a resposta da opção A. Invariantes: isolamento de erro (uma biblioteca não derruba as outras); scans sequenciais; cache keyed por id.
- **`LibraryPathResolver`** — `resolveLibraryRel(lib, rel) → { abs, rel }` com contenção contra `lib.canonicalPath`; mantém o contrato de rel canônico com `/` e o guard do `_LocalPlayer` para a biblioteca padrão. Invariantes: nada escapa do root da biblioteca; client nunca envia absolute path para servir.
- **`probeLibrary(lib)`** — reusa o padrão de `getSystemStatus` (fs.access + timeout 750ms + `isDeviceUnavailableCode`) para status `ok/unavailable` por biblioteca.

Cada abstração existe porque: **Registry** centraliza segurança de path (o risco nº1); **Scanner** garante isolamento/seqüência (risco de pendrive lento); **Resolver** protege o invariante de contenção em **todo** endpoint que recebe path (o contrato atual). Sem nova dependência; sem build step.

## 20. Compatibilidade

- **Biblioteca padrão derivada de ROOT continua automática** (sem configuração) — §17/18.
- **Links legados** (`#/course/…`, `#/topic/…`, `/media/…`, `/api/video/fallback?path=`, `/api/subtitles/*?path=`, `POST /api/progress` sem libraryId) → biblioteca padrão.
- **Progresso**: não perdido (remap idempotente); backup preservado.
- **Tópicos**: regra de marcador explícito inalterada; agora roda por biblioteca.
- **Transcode/legendas**: pipeline inalterado; só a chave de hash ganha `libraryId`; caches regeneram.
- **`resolveSafeRelPath`/`isAppDirRel`/proteção de traversal**: preservados (Resolver) — contratos de segurança continuam valendo.
- **Linux/Windows**: regras de path/encoding/separadores mantidas.
- **`POST /api/transcode/clear`** continua **nunca** tocando `progress.json`.

## 21. Plano de implementação

Fases (sequenciais, cada uma validável):

1. **Registry + persistência**: `data/libraries.json`, seed da biblioteca padrão, CRUD em memória, validação/canonicalização de path, migração. Testes.
2. **Resolver + media**: `resolveLibraryRel`; rotas `/media/<libraryId>/<rel>` com back-compat; `express.static` por biblioteca; guards de segurança. Testes de traversal.
3. **Scan + árvore**: `LibraryScanner` sequencial, cache por biblioteca, `GET /api/tree` → opção A, `POST /api/rescan`, `POST /api/libraries/:id/rescan`, `GET /api/libraries`.
4. **Progresso**: chave `libraryId\0rel` + migração; `/api/progress` e `/clear` com libraryId.
5. **Transcode**: hash com libraryId; `fallback?libraryId=`. **Legendas**: hash com libraryId; VTT canônico por biblioteca; rotas com libraryId.
6. **Frontend**: `state.libraries`, roteamento com libraryId, Home agrupada, `mediaUrl(libId,rel)`, busca, favoritos/progresso.
7. **Settings → Bibliotecas**: lista, adicionar, editar, ativar/desativar, reescanear, **remover** (com diálogo explícito e política de jobs), status/disponibilidade.
8. **Docs**: CLAUDE.md, README.md, DOCUMENTACAO.md, VALIDACAO.md + este relatório.

## 22. Testes necessários

- **Registry/validação** (`node:test`): path relativo/vazio/traversal/NUL rejeitados; symlink para app-dir rejeitado; dir proibido (app/data/public/node_modules) rejeitado; biblioteca aninhada (ancestral/descendente) rejeitada; dir inexistente aceito com `unavailable`; ID estável após rename.
- **Remoção** (obrigatório): `DELETE /api/libraries/:id` remove só o registro; **arquivos reais permanecem** (asserção de `fs.existsSync` nos arquivos da biblioteca após o delete); default → 403; id inexistente → 404; jobs ativos → 409; biblioteca removida some da árvore e `/media/<libId>/…` → 404.
- **Path resolution**: `resolveLibraryRel` rejeita `../` e absolutos dentro de biblioteca externa; `/media/<libId>/../../etc/passwd` → 404.
- **Progresso**: migração de chaves legadas → `<defaultId>\0…` idempotente; sem perda; clear por biblioteca.
- **Hashes**: `Curso/Aula1.mkv` em A e B geram caches/hashes distintos.
- **Scan**: biblioteca `unavailable` não derruba as demais; desativada não é escaneada; scan sequencial.
- **Frontend** (checklist manual em VALIDACAO): adicionar/renomear/desativar/reescanear/remover pela UI; duas bibliotecas com cursos de mesmo nome distintas; back/forward; busca.

## 23. Riscos

| Risco | Severidade | Mitigação |
| --- | --- | --- |
| Escapada de path por endpoint novo (o risco nº1 da feature) | **Alta** | Registry canonicaliza; Resolver contém; testes de traversal em toda rota que recebe path |
| Colisão de hashes transcode/legendas entre bibliotecas | **Média** | `sha1(libraryId+"\0"+rel)`; testes dedicados |
| Perda/duplicação de progresso na migração | **Média** | Remap idempotente + escrita atômica + backup (reversível) |
| Pendrive removível some no meio de scan/job | **Média** | Scan por biblioteca com isolamento; status `unavailable`; probe com timeout |
| Regressão nos walkers/roteamento de tópicos | **Média** | Opção A (árvore por biblioteca); testes existentes de tópicos seguem verdes |
| Remoção de biblioteca com jobs ativos deixando job órfão | **Média** | Política: **bloquear** remoção com 409 enquanto houver job ativo; descartar jobs **enfileirados** |
| Biblioteca apontando para app/data/public reabre BUG-001 | **Alta** | Rejeição na criação + realpath + testes |
| UNC/network share lento | **Baixa** | PARTIALLY_SUPPORTED; fora do alvo do MVP |

## 24. Critérios de aceite

- [ ] Usuário adiciona uma biblioteca externa pela UI (path digitado/paste).
- [ ] Biblioteca padrão (ROOT) funciona **sem nenhuma configuração** após a atualização.
- [ ] Renomear, ativar/desativar, reescanear por biblioteca.
- [ ] Status `✓ Disponível / ⚠ indisponível / Desativada` + contagem de cursos.
- [ ] Diretório inexistente/removível ausente: biblioteca permanece cadastrada, status `unavailable`, sem derrubar as outras.
- [ ] Curso "Python" da biblioteca A e da B são distintos (navegação, progresso, favoritos).
- [ ] Progresso existente migrado sem perda; transcode/legendas sem colisão de cache.
- [ ] Traversal/symlink/dir-proibido/aninhamento rejeitados; `/media/<libId>/../…` → 404.
- [ ] **Remoção**: só configuração; nenhum arquivo apagado; diálogo explícito; default protegida; jobs tratados; mídia da biblioteca removida deixa de ser servida; demais bibliotecas intactas.
- [ ] `DELETE /api/libraries/:id` validado (404/403/409); nunca `?path=`.
- [ ] Linux + Windows (drive letters; paths com espaço/acentos/unicode).
- [ ] Sem dependência nova; sem build step.

## 25. Veredito

Feature é **viável** sem mudar a arquitetura fundamental: o chokepoint único de path (`resolveSafeRelPath`) e os dois pontos de hash (`transcodeCacheName`/`subtitleCacheName`) concentram a maior parte da mudança; o resto é escopar rotas e adicionar o Registry. O maior risco (segurança de path) é gerenciável com canonicalização + contenção por biblioteca + testes, e a compatibilidade (biblioteca padrão automática, links legados, migração de progresso) mantém usuários atuais intactos.

**Escopo recomendado do MVP** (para conter risco):
- Seleção de diretório por **digitação/paste** (browse opcional).
- Scan **sequencial**; árvore por biblioteca (opção A).
- Biblioteca padrão: **não removível**, path imutável, apenas desativável.
- Remoção: **bloqueada com 409** enquanto houver job ativo (transcode/legenda/scan); jobs enfileirados descartados; **só configuração** é removida; progresso/caches intactos.
- UNC: **PARTIALLY_SUPPORTED** (não bloqueado, não priorizado).

### VIABILIDADE: **ALTA**

### COMPLEXIDADE: **ALTA** (toca todos os subsistemas: paths, scan, contrato da árvore, chaves de progresso, dois namespaces de hash, roteamento do frontend — na área mais sensível a segurança do projeto)

### RISCO: **MÉDIO** (segurança de path é o risco dominante; mitigado por Registry + Resolver + testes; migração de progresso/hashes é o risco operacional; back-compat mantida)

### RECOMENDAÇÃO: **IMPLEMENTAR COM RESSALVAS** (MVP escopado como acima; implementar em fases 1→8 com testes por fase; não paralelizar scan; não permitir remoção com jobs ativos; proteger a biblioteca padrão)

---

## REQUISITO OBRIGATÓRIO — Remoção de bibliotecas

### Duas operações distintas, nunca confundidas

1. **Remover da configuração** (esta feature): remove o registro de `libraries`.
2. **Apagar fisicamente** (operação futura, explícita e destrutiva): **fora do MVP**.

**O MVP implementa SOMENTE a operação 1.** No código da remoção: **proibido** `rm`, `fs.rm`, `fs.rmdir` ou equivalente; **nenhum arquivo da biblioteca é tocado**; `DELETE /api/libraries/:id` **não aceita** `?path=` nem body com absolute path (a decisão de "o quê apagar" é por `id`, nunca por path vindo do cliente).

### UX

Diálogo de confirmação via `openConfirmDialog` (padrão existente, sem `confirm()` nativo) com texto explícito:

> **Remover biblioteca?**
> Esta biblioteca será removida do Local Player, mas **nenhum arquivo será apagado do disco**.
> Caminho: `/mnt/ssd/Cursos`
> `[Cancelar]` `[Remover biblioteca]`

Confirmação deixa explícito: *"Isso remove apenas a biblioteca da configuração. Seus arquivos permanecerão no disco."*

### Biblioteca padrão

- **MVP: NÃO pode ser removida** (`403` no DELETE) e seu **path é imutável** (`PATCH path` → `403`). Pode ser **renomeada e desativada**.
- Justificativa: remover a padrão pode deixar o app sem biblioteca principal e quebrar a compatibilidade legada (links/progresso/mídia sem `libraryId` caem na padrão). Futuramente, se houver eleição de nova padrão, é feature separada.
- UI: botão "Remover" **desabilitado** na linha da padrão (com tooltip).

### Biblioteca indisponível

- Pendrive removido → biblioteca **continua cadastrada**, `status:"unavailable"`, badge `⚠ indisponível`, botão "Remover" **habilitado** (é exatamente o cenário em que o usuário quer desvincular um diretório que sumiu).
- Remoção de uma `unavailable` segue as mesmas regras (só configuração; sem jobs ativos → ok).

### Jobs ativos

**Política escolhida (a mais segura): bloquear remoção enquanto houver job ativo.**

- **Job ativo** = transcode `processing` (ffmpeg rodando) OU subtítulo em `extracting`/`transcribing`/`generating` OU scan em andamento daquela biblioteca → `DELETE` responde **`409 { error: "há jobs ativos para esta biblioteca" }`**. O usuário vê mensagem clara e pode repetir depois.
- **Jobs enfileirados** (não iniciados) daquela biblioteca → **descartados das filas** no momento da remoção (são seguros de dropar: não escreveram nada).
- Justificativa: cancelar um ffmpeg/whisper no meio é mais arriscado que esperar; o transcode compartilha `heavySlots` e a fila é curta — o bloqueio raramente atrasa o usuário. **Nunca** deixa job apontando para biblioteca inexistente.

### Progresso e caches

**Nada é apagado automaticamente.** `data/progress.json`, caches de transcode e legendas **permanecem** (chaves com `libraryId` ficam órfãs mas inofensivas — uma eventual "limpeza de dados da biblioteca" é operação **separada e explicitamente destrutiva**, fora do MVP). A remoção não apaga progresso nem caches sem política explícita.

### Comportamento pós-remoção

- Biblioteca some da árvore (`GET /api/tree` e cache); UI da Home atualizada.
- `/media/<libraryId>/…`, `/api/video/fallback?libraryId=…`, `/api/subtitles/*?libraryId=…`, `POST /api/progress?libraryId=…` → **`404`** (registry não resolve o id).
- Outras bibliotecas e a padrão seguem **intactas**.

### Critérios de aceite da remoção

- [x] Usuário remove uma biblioteca pela UI (diálogo de confirmação explícito).
- [x] Somente o registro é removido; **nenhum arquivo do diretório é apagado** (coberto por teste: `fs.existsSync` dos arquivos após `DELETE`).
- [x] Outras bibliotecas permanecem intactas.
- [x] Biblioteca removida deixa de aparecer na árvore; mídia dela deixa de ser servida (`404`).
- [x] Jobs ativos tratados (bloqueio `409`); enfileirados descartados.
- [x] Biblioteca padrão tem política explícita (não removível; path imutável; renomeável/desativável).
- [x] Progresso/caches **não** apagados silenciosamente.
- [x] `DELETE /api/libraries/:id` validado (`404`/`403`/`409`); nunca aceita `?path=`.

---

## Arquivos a modificar numa futura implementação

- **`server.js`** — Registry (`libraries.json` + seed + validação), `resolveLibraryRel`, scan por biblioteca + cache, `/api/libraries` (CRUD+rescan+browse), rotas `/media/<libId>/`, `/api/tree` (opção A), `/api/progress`, `transcodeCacheName`/`subtitleCacheName` com libraryId, VTT canônico por biblioteca, jobs/queues, migração de progresso, política de remoção.
- **`public/app.js`** — `state.libraries`, roteamento com `libraryId`, Home agrupada, `mediaUrl(libId,rel)`, progresso/favoritos keyed por `libId\0…`, busca, aba **Bibliotecas** em `SETTINGS_CATS` + diálogos de adicionar/editar/remover/reescanear.
- **`public/styles.css`** — estilos mínimos: cabeçalho de biblioteca na Home, badge de status, diálogo de remoção (reuso da maior parte).
- **`test/libraries.test.js`** (novo) — registry/validação, remoção preserva arquivos, traversal, migração de progresso, hashes distintos, isolamento de scan.
- **Docs** — `CLAUDE.md`, `README.md`, `docs/DOCUMENTACAO.md`, `docs/VALIDACAO.md` + **`docs/AUDITORIA_MULTIPLAS_BIBLIOTECAS.md`** (este relatório).
- **Não** tocar: `public/index.html` (casca; tabs são data-driven), `package.json` (sem dependências novas), o contrato de `.courseplayer`/tópicos (inalterado).
