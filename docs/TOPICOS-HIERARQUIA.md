# Tópicos hierárquicos na Home — relatório final

## Contexto

Antes desta mudança, **toda pasta da raiz da biblioteca** era tratada como
**curso** (`#/course/<path>` → player com módulos/aulas). Pastas que apenas
**organizam** outras pastas (ex.: `TI/`, `Python/`) não tinham identidade
própria — ou abriam como curso vazio, ou não faziam sentido na interface.

Com esta feature, pastas organizadoras viram **tópicos navegáveis**: um card que
abre a lista de filhos com breadcrumb (`Home › TI › Python`), em profundidade
arbitrária. Só quando se chega num **curso** (pasta com conteúdo direto) a
experiência atual do player abre. A estrutura física de diretórios continua
sendo a fonte de verdade — sem taxonomia paralela, sem config manual.

## Estrutura anterior vs. nova

```
ANTES                                            AGORA
ROOT/                                            ROOT/
├── Curso Python/            (curso)             ├── TI/                      (TÓPICO)
│   └── Aula 01.mp4                              │   ├── Python/              (TÓPICO)
├── TI/                      (curso vazio!)      │   │   └── Curso Python/    (curso)
│   └── Python/                                  │   │       └── Aula 01.mp4
│       └── Curso Python/                        │   └── Curso Linux/         (curso)
│           └── Aula 01.mp4                      │       └── aula.mp4
└── Curso X/                 (curso vazio!)      └── Curso X/                 (TÓPICO)
    └── Módulo 1/                                 │   └── Módulo 1/           (curso)
        └── aula.mp4                              │       └── aula.mp4
                                                  └── Curso Marcado/          (curso, via marcador)
                                                      └── Módulo 1/
                                                          └── aula.mp4
```

## Regra tópico-vs-curso (definitiva)

> Uma pasta é **tópico** se **não contém nenhum vídeo/material diretamente nela**
> (só subpastas). É **curso** se contém qualquer arquivo direto **ou** existir o
> marcador `.courseplayer/course` dentro dela.

- "Conteúdo direto" = os `candidates` do scan (excluem capas e `IGNORED_EXT`).
  **Capas não contam.**
- O marcador é checado **só** para pastas sem conteúdo direto (custo extra ≈ zero
  em bibliotecas típicas).
- `.courseplayer` já é ignorado no scan (dotfile) e no static
  (`dotfiles: "ignore"`) — o marcador nunca aparece na árvore nem é servido.

| Caso | Resultado |
| --- | --- |
| `Curso Python/Aula 01.mp4` | **curso** (arquivo direto) |
| `TI/Python/Curso Python/Aula.mp4` | `TI` **tópico**, `Python` **tópico**, `Curso Python` **curso** |
| `TI/Curso Linux/Aula.mp4` | `TI` **tópico**, `Curso Linux` **curso** |
| `Curso X/Módulo 1/Aula.mp4` | `Curso X` **tópico**, `Módulo 1` **curso** |
| `Curso X/.courseplayer/course` + `Módulo 1/Aula.mp4` | marcador força `Curso X` **curso** (módulos preservados) |
| Pasta vazia | **tópico** (empty state) |

## Alterações por arquivo

### Backend — `server.js`

- **`scanDir()`**: cada nó pasta agora carrega `role` (`"topic"`/`"course"`),
  `childCount` (nº de filhos diretos) e `courseCount` (nº de cursos descendentes,
  calculado bottom-up). A role é decidida por conteúdo direto (`candidates`)
  + marcador `.courseplayer/course`. `type` continua `"folder"` — nada quebra.
- **`maybePregenFirstLessons()`** (P2 de legendas): agora itera as **raízes de
  curso** em toda a árvore (`collectCourseRoots`: pasta `role==="course"` cujo
  pai não é curso) — as primeiras-aula de cursos dentro de tópicos também
  recebem prioridade P2. P3 (background) já caminhava recursivamente.
- **Boot testável**: o boot real (porta + `data/`) foi envolvido em
  `if (require.main === module) { ... }`; no `else`,
  `module.exports = { scanDir, resolveSafeRelPath, normalizeDisplayTitle }`.
  Sem mudança de comportamento em `npm start`; permite testes unitários sem
  bindar porta nem tocar `data/`.

### Frontend — `public/app.js`

- **Roteamento** (`route()`): `#/course/<path>` e `#/topic/<path>` caem no mesmo
  parse; `renderCourse` resolve o nó por path na árvore inteira
  (`findNodeByPath`) e, se `role==="topic"`, delega a `renderTopic`. Links
  velhos `#/course/<tópico>` degradam bem.
- **Home** (`renderHome`): mista — cards de curso e de tópico no mesmo grid.
  Card de tópico: `href = #/topic/<path>`, sem favorito, meta "N cursos" (ou
  "N itens"), tag "Tópico". **"Seu progresso"** e **"Continuar assistindo"**
  usam todos os cursos (`collectAllCourses` recursivo) — aulas dentro de
  tópicos aparecem e navegam com `#/course/<nested>?lesson=...`.
- **`renderTopic`** (novo): breadcrumb clicável (`Home › TI › Python`, ancestrais
  → `#/topic/`), título do tópico, grid dos filhos reutilizando `renderNodeCard`,
  empty state "Tópico vazio". Não abre player, não mostra favoritos/progresso
  (v1 só contagens).
- **`renderNodeCard(node)`** (extraído): card reutilizado por Home e `renderTopic`.
- **Busca** (`buildSearchResults`): caminha a árvore inteira (`collectAllFolders`)
  — tópicos viram resultados próprios (`#/topic/`), cursos/aulas/materiais
  aninhados também aparecem. Enter abre o 1º resultado respeitando o tipo.

### Frontend — `public/styles.css`

- `.topic-card-tag` (tag discreta "Tópico" no card) e `.topic-view`/
  `.topic-breadcrumb`/`.breadcrumb-link`/`.topic-title` (visão de tópico). Reusa
  `.course-grid`/`.course-card` — nenhuma mudança estrutural.

### Testes — `test/topics.test.js` (novo)

`node:test` + `node:assert` (stdlib — **nenhuma dependência nova**), fixtures
montadas em `fs.mkdtemp`. Cobre as 11 regras estruturais do §19 + export de
`normalizeDisplayTitle`. Rodar: `node --test test/topics.test.js`.

## Compatibilidade e invariantes preservados

- `renderCourse` resolve por path (não só top-level) — destrava cursos em
  tópicos **sem** quebrar nenhum link existente (`#/course/<path>`).
- Progresso intacto (chave = path relativo do vídeo); favoritos continuam **só
  para cursos** (§12); "Continuar assistindo" continua keyed por vídeo (§14).
- Transcode, legendas, atalhos, Configurações e a Central de IA inalterados.
- Segurança de path (`resolveSafeRelPath`) intacta; o marcador é um dotfile e
  nunca é servido.
- Linux e Windows: rel paths com `/`, `path` APIs, encoding por segmento.

## Riscos / limitações

- **Mudança de comportamento documentada**: curso com pasta raiz vazia (sem
  marcador) vira tópico navegável — os módulos passam a ser os cursos. O
  marcador `.courseplayer/course` restaura o comportamento de curso.
- **Agregação de progresso em tópicos** não é exibida (v1 mostra só contagens —
  §13); fica para fase posterior.
- **Multi-biblioteca** não foi implementada (§16) — paths continuam sendo o
  identificador; nada bloqueia a adição futura de `libraryId`.
- Nenhuma dependência nova; sem build step; sem framework.

## Como criar tópicos

Basta criar pastas dentro da raiz da biblioteca. Uma pasta com subpastas e
**sem** arquivos diretos (exceto capas) vira tópico automaticamente. Para forçar
uma pasta vazia (conteúdo só em módulos) a ser **curso**, crie o arquivo
vazio `ROOT/<pasta>/.courseplayer/course`.

## VEREDITO

Regra híbrida (estrutura + marcador) implementada em backend e frontend com a
experiência de curso intacta; roteamento, Home, busca e testes cobrindo tópicos
e cursos aninhados; documentação atualizada. Feito sem dependências novas, sem
build step e sem quebrar progresso/favoritos/transcode/legendas.
