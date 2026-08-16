# Bibliotecas externas configuráveis — relatório final

## Contexto

Originalmente o Local Player tinha **uma única biblioteca**: a pasta ao lado do
app (`ROOT`, derivada de `path.resolve(__dirname, "..")`). Cursos de HDs
externos precisavam ser copiados para essa pasta, e o progresso/favoritos eram
chaveados pelo path relativo — sem separação por origem.

Esta feature permite registrar **bibliotecas externas configuráveis pelo
frontend** (Configurações → **Bibliotecas**): cada uma tem nome, path absoluto,
estado habilitada/desabilitada e árvore própria. O app passa a navegar, buscar,
tocar, transcode e gerar legendas **em qualquer biblioteca registrada**, sem
copiar nada. A **biblioteca padrão** (pasta ao lado do app) continua sendo a
raiz da arquitetura original — o recurso é aditivo.

## O que mudou (antes → depois)

| Antes | Depois |
| --- | --- |
| Uma biblioteca fixa em `ROOT` | N bibliotecas: padrão + externas em `data/libraries.json` |
| `GET /api/tree` retornava `{tree}` | `GET /api/tree` retorna `{libraries: [summary...]}` (summary inclui `tree`) |
| Progresso keyed por `rel` | `libId\0rel` (migração automática das chaves legadas para `default\0rel`) |
| Caches (transcode/legendas) por `sha1(rel)` | `sha1(libId\0rel)` — mesmo rel em bibliotecas distintas não colide |
| Media só em `ROOT` | `/media/<rel>` (padrão) ou `/media/<libId>/<rel>` (externa) |
| Favoritos keyed por path | `libId\0path` (migração automática no load) |
| Remoção inexistente | `DELETE /api/libraries/:id` **config-only** (arquivos jamais tocados) |

## Registry (`data/libraries.json`)

- Forma: `{ libraries: [{id, name, path, enabled, isDefault, createdAt}], updatedAt }`.
- **Lazy, memoizado** (`loadLibraries`). Arquivo ausente → semeia a biblioteca
  padrão; corrompido → preservado como `.corrupt-<ts>` e re-semeado.
- Entradas sem `id`/`path` string são filtradas ao carregar.
- A **padrão** (`id = "default"`) tem `path` **imutável** (sempre `ROOT`) e
  `isDefault: true`; pode ser renomeada e desativada, nunca removida nem
  movida.
- Ids de externas são `randomUUID` — **estáveis**, imunes a rename de nome/path.

## Validação de path (`validateLibraryPath`)

Regras (auditoria §6/§13, testadas): string obrigatória, sem trim vazio, sem
NUL, **absoluto obrigatório**, `fs.realpath` (resolve symlinks/junctions →
canônico), e rejeição de:
- diretórios proibidos: pasta do app (`__dirname`), `public/`, `node_modules/`
  e `data/`;
- **aninhamento** com biblioteca existente (igual, ancestral ou descendente) —
  evita raízes ambíguas e double-scan.

O path validado é usado **uma única vez** (na criação/edição) para o registro;
operações de mídia nunca reutilizam path de cliente — sempre resolvem contra o
path canônico da biblioteca do registro (`resolveLibraryRel`).

## API

| Rota | Propósito |
| --- | --- |
| `GET /api/tree?rescan=1` | Árvores consolidadas `{libraries:[summary...]}` (scan sequencial das habilitadas) |
| `POST /api/rescan` | Força scan de todas + P2/P3 de legendas |
| `GET /api/libraries` | Summary das bibliotecas (sem cache → status `unknown`) |
| `POST /api/libraries` | Cria `{name?, path}` → 201 + summary (400 path inválido) |
| `PATCH /api/libraries/:id` | `{name?, enabled?, path?}`; path da padrão → 403; 404 desconhecida |
| `DELETE /api/libraries/:id` | Remove da **configuração**; padrão → 403; jobs ativos → 409; enfileirados são descartados; 404 desconhecida |
| `POST /api/libraries/:id/rescan` | Scan de UMA biblioteca; já em andamento → 409; dir sumiu → 200 `status:"unavailable"` |
| `POST /api/progress` | `{path: <rel>, position, duration, completed}` + `libraryId` opcional (query/body) |
| `POST /api/progress/clear` | `{coursePath: <rel>}` + `libraryId` opcional (sem path = limpa tudo) |

- `requestLibrary(req)`: `libraryId` da query → body → **padrão**. Id
  desconhecido → **400** (nunca degrada silenciosamente para a padrão).
- `librarySummary(lib, cached)`: `status` = `cached ? cached.status : "unknown"`
  (o frontend lê summaries do `/api/tree` cacheado, então badges de Configurações
  refletem o último scan); `courseCount` = nº de pastas (`type:"folder"`,
  recursivo).
- **Media**: `/media/*` resolvido por biblioteca — primeiro segmento que casa
  um id de biblioteca externa vira o prefixo (`parseMediaRequest`); senão,
  padrão. `sendFile` com Range (206) preservado. **BUG-001 corrigido**: o
  `express.static(ROOT)` foi substituído por resolução por-biblioteca +
  `sendFile`; a pasta do app é bloqueada **só na biblioteca padrão**
  (`isAppDirRel`) e segmentos dotfile → 404 (`hasDotSegment`).

## Escopo por biblioteca

- **Progresso**: chave `${libId}\0${rel}`. `migrateProgressKeys` converte as
  chaves legadas (sem `\0`) para `default\0<rel>` no boot (idempotente, nada
  perdido, backup preserva o estado pré-migração).
- **Caches de transcode/legendas**: `sha1(libId\0rel)[0:24]` — mesmo rel em
  bibliotecas distintas não colide. Caches antigos (namespace anterior) ficam
  órfãos e são descartáveis (regeneram sob demanda; nada é apagado).
- **Legendas**: VTT canônico em `<lib.path>/<curso>/.courseplayer/subtitles/
  <hash>.vtt` (não mais em `ROOT`) via `courseSubtitlePath`.
- **Favoritos**: `libId\0path` (migração automática no load: chave sem `\0` →
  `default\0path`).

## Remoção (REQUISITO OBRIGATÓRIO — config-only)

`DELETE /api/libraries/:id` **nunca toca o filesystem**: nenhum `rm`/`fs.rm`/
`fs.rmdir` em arquivos ou pastas da biblioteca. A remoção tira a entrada do
registry e limpa o cache de árvore; **progresso e caches permanecem intactos**
(uma readição pela mesma rota reusa tudo). Bloqueios:
- biblioteca **padrão** → 403;
- **jobs ativos** (transcode `processing`, legenda em `extracting/transcribing/
  processing/correcting/formatting`, scan em andamento) → **409**;
- jobs apenas **enfileirados** não bloqueiam — são descartados (nunca deixa job
  apontando para biblioteca inexistente).
- a rota **não aceita path** (nem `?path=` nem body com path) — a decisão é por id.

## Frontend

- **Helpers** (`public/app.js`): `DEFAULT_LIB_ID = "default"`, `getLibById`,
  `isExternalLib`, `progKey(path, libId) = libId + "\0" + path`, `progFor(node)`,
  `libQuery(node)` (`?libraryId=<id>` só para externa), `courseRoute`/`topicRoute`
  (`#/course/[<libId>/]<rel>`), `libTree(libId)`.
- **`annotateLibId`**: a cada load, cada nó de cada árvore recebe `libId` —
  os walkers (`collectAllCourses`, `collectAllFolders`, `flattenVideos`,
  `flattenMaterials`) não mudam de assinatura; os nós se autodescrevem.
- **Roteamento**: `#/course/<libId>/<rel>` e `#/topic/<libId>/<rel>` (legado sem
  prefixo → padrão). O primeiro segmento é tratado como id só se casar uma
  biblioteca externa conhecida.
- **Home**: mistura cursos/tópicos de todas as bibliotecas habilitadas (grid
  único ou agrupado por biblioteca); "Continuar assistindo" e "Seu progresso"
  usam todos os cursos (nós anotados) e continuam com `#/course/<libId>/<nested>
  ?lesson=...`.
- **Busca**: `buildSearchResults` caminha as árvores de todas as bibliotecas;
  resultados carregam `libraryId`; Enter roteia respeitando tipo **e** biblioteca.
- **Configurações → Bibliotecas**: lista (nome, path, badge de status, nº
  cursos) com `[Reescanear][Editar][Ativar/Desativar][Remover]` (Remover
  desabilitado na padrão) e `[Adicionar]` global. Remoção usa `openConfirmDialog`
  (nunca `confirm()` nativo). O card mostra status real do summary.

## Compatibilidade & migração

- Links antigos `#/course/<rel>` continuam funcionando (sem prefixo → padrão).
- Progresso e favoritos legados migram automaticamente para `default\0`.
- Caches antigos ficam órfãos mas regeneram; nada é apagado na migração.
- Nenhuma dependência nova; sem build step; sem framework.

## Riscos e limitações

- Scan é **sequencial** (deliberado: paralelo martela o barramento/USB em
  pendrives) — muitas bibliotecas lentas somam tempo de load.
- Uma biblioteca com path sumido (drive desmontado) reporta
  `status:"unavailable"` e árvore vazia; recarregar após remontar restaura.
- Aninhamento de bibliotecas é rejeitado por construção; cada biblioteca precisa
  de raiz própria não contida em outra.
- Desabilitar não apaga nada — só exclui do scan e das rotas de navegação.

## Como adicionar uma biblioteca

1. Pasta com cursos em qualquer disco (ex.: `D:\Cursos` ou `/media/hd/Cursos`).
2. No app: **Configurações → Bibliotecas → Adicionar** → informe nome e path
   absoluto.
3. O path é validado (absoluto, realpath, sem conflito/aninhamento) e a
   biblioteca aparece na Home.

## Testes

`test/libraries.test.js` (17 testes, `node:test` + `node:assert`, stdlib):
`validateLibraryPath` (relativo/vazio/NUL/não-string/dirs proibidos/válido/
realpath/symlink/aninhamento), `resolveLibraryRel` (ancoragem, rejeição de
traversal `..`, re-ancoragem de absolutos, `\` do Windows, rel sempre com `/`),
`scanLibrary` (tópicos e cursos aninhados; path inexistente → `unavailable`),
nomes de cache escopados por biblioteca, `courseSubtitlePath` e `scanDir`
básico. Rodar:

```bash
node --test test/libraries.test.js
node --test test/topics.test.js   # regra de tópicos (deve continuar verde)
```

## VEREDITO

**CONCLUÍDO** — bibliotecas externas configuráveis pelo frontend: registry em
`data/libraries.json`, validação de path completa (realpath, dirs proibidos,
anti-aninhamento), API de CRUD + rescan, `/api/tree` consolidado por biblioteca,
media/transcode/legendas/progresso/favoritos escopados por biblioteca, remoção
**config-only** com bloqueio por jobs ativos (409), migração automática de
chaves legadas, testes 17/17 verdes + tópicos 17/17 verdes, documentação
atualizada. Nenhuma dependência nova.
