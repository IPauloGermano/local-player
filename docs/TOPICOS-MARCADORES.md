# Tópicos por marcador explícito — relatório final

## Contexto

Uma primeira implementação de tópicos usou **classificação híbrida**
(heurística estrutural: pasta sem conteúdo direto ⇒ tópico; marcador
`.courseplayer/course` ⇒ curso). Ela **não funcionou como esperado**: tentar
adivinhar a intenção do usuário a partir da estrutura de arquivos produz
resultados imprevisíveis — uma pasta organizadora vira tópico por acaso,
cursos cuja raiz está vazia mudam de comportamento sem aviso, e não há como
declarar intenção de forma confiável.

Este relatório documenta a **substituição** dessa abordagem por uma regra
**explícita, previsível e simples**: uma pasta é tópico **somente** quando o
usuário declarou isso explicitamente. Nenhuma inferência sobre conteúdo,
profundidade, contagens ou nomes de módulo classifica nada.

## Regra final

> **SE** existir o arquivo `.topic` dentro da pasta → `type = "topic"`
>
> **SENÃO SE** o nome real da pasta terminar com `(TP)` → `type = "topic"`
>
> **SENÃO** → `type = "folder"` (curso/módulo — comportamento normal)

- A regex do sufixo é `\(TP\)\s*$` com flag `i` (case-insensitive) — vale
  `(TP)`, `(tp)`, `(Tp)`, com ou sem espaço antes, **só no final do nome**.
- `Aula TP avançado`, `Projeto TP`, `Curso TP` → **não** são tópicos (TP sem
  parênteses). `(TP) Curso` → **não** é tópico (marcador fora do final).
- O `(TP)` é removido **apenas** do título de exibição (`normalizeDisplayTitle`);
  a **numeração inicial também é removida** e a primeira letra vem sempre
  maiúscula (`1 Linguas (TP)` → `Linguas`, `1. Language` → `Language`). O
  `name` real da pasta nunca muda — a estrutura física segue sendo a fonte de
  verdade.
- O marcador `.topic` é um **dotfile** (arquivo vazio): ignorado pelo scan e
  pelo static (`dotfiles: "ignore"`) — **não** aparece na árvore, na busca,
  nos materiais nem nas contagens. É propósito diferente do `.courseplayer`
  (pasta de artefatos de legenda, que permanece intocada).

| Caso | Resultado |
| --- | --- |
| `1 Linguas (TP)/{Inglês/, Espanhol/}` | `1 Linguas` **tópico** (título `Linguas`), filhos cursos |
| `TI/{.topic, Python/, Redes/}` | `TI` **tópico** (por `.topic`) |
| `TI/{.topic, Python/.topic, ...}` | `TI` e `TI/Python` **tópicos** (aninhamento arbitrário) |
| `Curso Python/{Módulo1/Aula01.mp4}` | **curso** (sem marcador — modular) |
| `Curso Java/Aula01.mp4` | **curso** (sem marcador) |
| `Curso X/{Módulo1/aula.mp4}` | **curso** (raiz vazia NÃO vira tópico) |
| `Híbrido/{.topic, aula.mp4}` | **tópico** — o marcador VENCE o conteúdo direto (o vídeo continua como filho) |
| `Projeto TP/`, `(TP) Curso/`, `Aula TP avançado/` | **folder** (marcadores inválidos) |

## Roteamento

- `#/` home, `#/settings` configurações, `#/topic/<encodedPath>` tópico,
  `#/course/<encodedPath>?lesson=<encodedLessonPath>` curso/player.
- Ambos os caminhos de pasta caem no mesmo parse; `renderCourse` resolve o nó
  por path na árvore inteira (`findNodeByPath`) e, se `type === "topic"`,
  delega a `renderTopic` — links velhos `#/course/<tópico>` degradam bem.
- `renderTopic` renderiza breadcrumb clicável (`Home › Linguas`), título e
  grid dos filhos (`renderNodeCard`); não abre player. Back/forward do
  navegador funcionam via `hashchange`.

## Home, busca, progresso

- Home mista: pastas da raiz com `type === "topic"` viram cards de tópico
  (tag "Tópico", meta "N itens", sem favorito); demais viram cards de curso.
- Busca caminha a árvore inteira (`collectAllFolders`, inclui tópicos): tópico
  → resultado `#/topic/`; cursos/aulas/materiais aninhados também aparecem.
  `.topic` nunca é resultado.
- "Continuar assistindo" e "Seu progresso" usam `collectAllCourses` (pasta
  `folder` cujo pai não é outra pasta de curso — raiz ou tópico), então aulas
  dentro de tópicos aparecem e navegam com `#/course/<nested>?lesson=...`.
- Favoritos continuam **só em cursos**; progresso continua keyed por
  vídeo/curso (tópico não agrega progresso).

## Alterações por arquivo

### Backend — `server.js`

- **`scanDir()`**: durante a leitura da pasta, o dotfile `.topic` (arquivo)
  seta `hasTopicMarker` (é checado **no mesmo scan**, sem segunda varredura).
  A pasta termina em `type = hasTopicMarker || /\(TP\)\s*$/i.test(basename)
  ? "topic" : "folder"`. Removidos `role`, `childCount`, `courseCount` e a
  checagem do antigo `.courseplayer/course`. Retorno do nó:
  `{ children, videoCount, coverImage, type }`.
- **`normalizeDisplayTitle()`**: remove `(TP)` final do título de exibição de
  pastas (`!isVideo`) e a **numeração inicial** de todos os tipos
  (`1 Linguas (TP)` → `Linguas`, `1. Language` → `Language`); a primeira letra
  vem sempre maiúscula (`toDisplayCase`). Opção `preserveLeading` removida
  (era o que mantinha o número nos tópicos). Adicionado `"ti": "TI"` em
  `TITLE_KEEP_CASE` (sigla comum — exibição correta de `TI`).
- **`maybePregenFirstLessons()`** (P2 de legendas): "primeira aula de cada
  curso" agora é pasta `type === "folder"` cujo pai não é outra pasta de curso
  (pai é raiz ou tópico) — módulos e tópicos ficam de fora.
- Boot testável (`require.main === module`) e exports
  `{ scanDir, resolveSafeRelPath, normalizeDisplayTitle }` inalterados.

### Frontend — `public/app.js`

- Walkers descem em `folder` **e** `topic`: `flattenVideos`, `flattenMaterials`,
  `findParentFolder`, `findAncestorFolders`, `collectAllFolders`.
- `collectAllCourses` → course roots (pai não é `folder`); sem duplicar módulos.
- `renderNodeCard`: `type === "topic"` → card de tópico (meta `N itens`).
- `renderHome`: filtra `type` (`folder`/`topic`), label "Biblioteca" quando há
  tópicos, comentários atualizados.
- `renderTopic`/`renderCourse`: guard por `type === "topic"`; `renderTopic`
  renderiza sub-tópicos e cursos como cards (não só `folder`).
- `buildSearchResults`: `type === "topic"` → resultado próprio `#/topic/`.
- Enter da busca e roteamento já respeitavam o tipo (sem mudança estrutural).

### Testes — `test/topics.test.js`

`node:test` + `node:assert` (stdlib), fixtures em `fs.mkdtemp`. 17 testes
cobrindo: `.topic`; `(TP)` com/sem espaço e case-insensitive; `Projeto TP`,
`(TP) Curso`, `Curso TP`, `Aula TP avançado` **não** tópicos; curso modular e
curso direto **não** tópicos; tópicos aninhados; curso dentro de tópico;
`.topic` invisível na árvore/contagens; marcador vence conteúdo direto;
unicodes; `normalizeDisplayTitle` remove `(TP)` de pasta (e não de vídeo);
`resolveSafeRelPath` bloqueia traversal. Rodar: `node --test test/topics.test.js`.

## Compatibilidade e invariantes preservados

- `renderCourse` resolve por path — cursos em tópicos e links existentes
  (`#/course/<path>`) intactos.
- Progresso (chave = path do vídeo), favoritos (só cursos), "Continuar
  assistindo" (keyed por vídeo), transcode, legendas, atalhos, Configurações e
  Central de IA inalterados.
- `resolveSafeRelPath()` intacto; `.topic` é dotfile e nunca é servido;
  `.courseplayer` (legendas) permanece intacto e com propósito distinto.
- Linux/Windows: rel paths com `/`, `path` APIs, encoding por segmento.

## Migração

- Quem usou a regra híbrida anterior: pastas que eram tópicos por "estarem
  vazias" **deixam** de ser tópicos (voltam a cursos/módulos normais). Para
  marcá-las de novo, crie o arquivo vazio `ROOT/<pasta>/.topic` ou renomeie
  para `... (TP)`.
- O antigo marcador `.courseplayer/course` **deixa** de influenciar a
  classificação (cursos modulares voltam a ser cursos normais — sem precisar
  de marcador). Nada é apagado do disco.

## Riscos / limitações

- Regra é declarativa: pastas organizadoras **precisam** do marcador para
  virar tópico (uma pasta "só com subpastas" sem marcador é um curso vazio —
  comportamento normal). Este é o trade-off aceito da regra explícita.
- O título de um tópico com `(TP)` segue a capitalização padrão do app
  (ex.: `(TP) Curso` exibe `Tp) curso`) — comportamento de normalização
  preexistente, não relacionado à classificação.
- Agregação de progresso em tópicos não é exibida (v1 mostra só "N itens").
- Nenhuma dependência nova; sem build step; sem framework.

## Como criar tópicos

1. **`.topic`**: crie um arquivo vazio `ROOT/<pasta>/.topic`.
2. **`(TP)`**: basta renomear a pasta com o sufixo no final (ex.: `Linguas (TP)`).

## VEREDITO

**CONCLUÍDO** — a classificação híbrida foi **removida** (sem resquícios de
`role`/`childCount`/`courseCount`/`.courseplayer/course` no scan); o marcador
`.topic` e o sufixo `(TP)` classificam pastas como tópico; cursos modulares
sem marcador continuam cursos normais; testes (17/17) passam; documentação
atualizada.
