# Auditoria do sistema de progresso (pós-tópicos / bibliotecas externas)

Relatório da auditoria do **sistema de progresso** do Local Player após as mudanças de
navegação por tópicos e de bibliotecas externas. Pergunta central da auditoria:

> **Duas aulas fisicamente diferentes podem acabar usando a mesma chave de progresso?**

A resposta é **não** (comprovada por código e por testes de integração). Detalhes abaixo.

## 1. Estado antes

Antes das bibliotecas externas, o progresso era chaveado apenas pelo path relativo da aula
(`progress.json` com chaves como `"Curso X/Aula 01.mp4"`). As features de tópicos (`.topic`
e `(TP)`) **não alteraram a identidade das aulas** — eram só uma classificação de
exibição/navegação. A feature de bibliotecas externas introduziu o **prefixo `libId`**
(`default` para a raiz, `randomUUID` para externas) separado por `\0` (`NUL`), que não pode
aparecer em nomes de arquivo em Linux/Windows — logo é um separador seguro.

## 2. Como o progresso é identificado

- **Chave**: `<libraryId>\0<rel>`, onde `rel` é o **path físico real** da aula relativo à
  biblioteca, com `/` (canônico, nunca separador nativo). Produzida no backend em
  `POST /api/progress` (`server.js:4552`) como `` `${lib.id}\0${safe.rel}` `` e no frontend
  em `progKey` (`public/app.js:37`).
- **Identidade determinística**: o `rel` vem do scan (`scanDir` → `entryRel`), ou seja, do
  **arquivo em disco**, nunca do `title` de exibição nem de `normalizeDisplayTitle`.
  Renomear a pasta/aula muda o path físico → muda a chave (comportamento determinístico,
  documentado; sem auto-migração por nome — proibida na regra §19).
- **Estabilidade**: uma aula não muda de chave sozinha; a chave só muda se o path físico
  mudar. `libId` é estável para externas (`randomUUID` persistido em `libraries.json`);
  a padrão é sempre `default`.
- **Multiplataforma**: `rel` usa `/`; `resolveSafeRelPath` (`server.js:721`) re-ancora
  absolutos dentro da biblioteca e rejeita `..` que escape; `resolveLibraryRel` ancoriza
  por biblioteca. Funciona igual em Linux/Windows.
- **Frontend**: `progFor(node)` (`app.js:41`) resolve a chave do nó; `annotateLibId`
  carrega `libId` em cada nó da árvore; links de curso/tópico/aula de bibliotecas externas
  carregam `libId` no path da URL (`courseRoute`/`courseHref`).

## 3. Impacto dos tópicos

Tópico é só um tipo de nó de exibição (`type === "topic"`). A identidade do progresso é o
path físico do vídeo: `TI/Python/Curso X/Aula 01.mp4` tem a chave
`default\0TI/Python/Curso X/Aula 01.mp4` — o fato de `TI`/`Python` serem tópicos não
aparece na chave. Curso aninhado em tópico e curso na raiz com o **mesmo path relativo**
são necessariamente o mesmo arquivo (impossível duplicar o mesmo rel dentro de uma
biblioteca), então não há colisão possível nesse eixo.

## 4. Impacto do `.topic`

O `.topic` é um **dotfile** ignorado pelo scan (nunca vira material/resultado de busca) e
não é servido pelo static (`dotfiles: "ignore"`). Ele **nunca aparece no path** das aulas:
a chave de `TI/Python/...` não contém o marcador. Um `.topic` adicionado/removido não
altera nenhuma chave existente.

## 5. Impacto do `(TP)`

`(TP)` é removido **apenas do título de exibição** (`normalizeDisplayTitle`). O **nome
real** da pasta permanece no disco e no path relativo → na chave. Logo, renomear
`1 Linguas (TP)` para `1 Linguas` muda o path físico e cria uma chave nova (comportamento
determinístico de rename, documentado; sem auto-migração). O `(TP)` em si nunca é parte
da identidade; a identidade é o path físico.

## 6. Compatibilidade com progresso antigo

- Chaves legadas (sem `\0`, pré-bibliotecas) migram automaticamente no boot:
  `migrateProgressKeys` (`server.js:1148`) reescreve `"Curso X/Aula 01.mp4"` →
  `"default\0Curso X/Aula 01.mp4"`, **preservando posição/duration/completed**. O backup
  pré-migração é preservado (`progress.json.bak`).
- O caminho feliz atual (padrão) usa `default\0rel` — não há mudança de comportamento
  visível para bibliotecas só-raiz.
- Links legados `#/course/<rel>` sem `libId` continuam resolvendo para a biblioteca padrão.

## 7. Colisões encontradas

**Nenhuma.** Casos testados (§9 do prompt):

- **Caso A** — `Curso A/Aula 01.mp4` vs `Curso B/Aula 01.mp4` → chaves distintas
  (`default\0Curso A/...` vs `default\0Curso B/...`). ✔ (teste T1)
- **Caso B** — `TI/Python/Curso X/Aula 01.mp4` vs `TI/Java/Curso X/Aula 01.mp4` → chaves
  distintas (path físico difere). ✔ (teste T1)
- **Caso C** — mesma aula na biblioteca padrão, na libA e na libB → **três** chaves
  independentes (`default\0`, `libA\0`, `libB\0`). ✔ (teste T2)
- **Caso D** — mesmo título de exibição em paths distintos (o título nunca é chave) →
  chaves distintas por construção. ✔ (coberto por A/B/C)

## 8. Problemas encontrados

1. **Falta de cobertura automatizada** (não é bug de runtime): o sistema estava correto por
   leitura, mas não havia testes de integração do progresso pós-mudanças. Mitigado com
   `test/progress.test.js`.
2. **Testabilidade**: para testar progresso/backup/corrupção sem tocar o `data/` real, não
   havia como apontar os dados para um sandbox. Mitigado com a env `LP_DATA_DIR`.

Não foi encontrado nenhum defeito de integridade em produção (colisão de chave, perda de
progresso, progresso na aula errada, clear incorreto, shutdown sem dreno, ou corrupção).

## 9. Correções realizadas

- **`server.js:19`** — `DATA_DIR` agora é sobrescrevível via env **`LP_DATA_DIR`** (default
  `path.join(__dirname, "data")`). Apenas para testes em sandbox; uso normal não define a
  env e o comportamento é idêntico ao anterior. Zero impacto em produção.
- **`test/progress.test.js`** (novo) — 6 testes de integração (ver §10).

Nenhuma correção de lógica de progresso foi necessária: a implementação (fila serializada,
escrita atômica, backup em cascata, clear por prefixo escopado, migração de chaves, dreno
no shutdown) já estava correta.

## 10. Testes executados

`node --check server.js` ✔ · `node --check public/app.js` ✔ · `git diff --check` ✔

`node --test test/progress.test.js test/topics.test.js test/libraries.test.js` → **40/40 ✔**
(sendo 6 do progresso). Os testes de progresso sobem o **servidor real** com `LP_DATA_DIR`
em `fs.mkdtempSync` (sandbox — **nenhum dado real da biblioteca é tocado**) e exercitam via
HTTP:

- **T1** — save/reload; aulas de mesmo nome em cursos/tópicos diferentes → chaves
  distintas; conclusão.
- **T2** — mesmo `rel` na padrão + libA + libB → 3 chaves independentes; biblioteca
  desconhecida → 400 (nunca degrada para a padrão); traversal (`../../etc/passwd`) → 400;
  absoluto re-ancorado dentro da biblioteca.
- **T3** — clear de curso **delimitado** (`Curso A` não apaga `Curso A2`) e **escopado**
  por biblioteca; clear global zera tudo (inclusive externas).
- **T4** — primeiro save semeia o backup; chaves legadas (sem `\0`) migram para
  `default\0` preservando valores.
- **T5** — corrupção: main → recupera do bak; main+bak → recupera do bak.1; arquivos
  corrompidos preservados como `.corrupt-*`.
- **T6** — SIGTERM drena a fila: o último save chega ao disco antes do exit(0).

## 11. Testes não executados

- **Corrida de troca rápida A→B no frontend** (persist do vídeo antigo misturando no
  novo): verificada por **leitura de código** (a persist captura o `video` no closure;
  cada aula monta um `<video>` novo, destruindo listeners antigos; `route()` dá o flush do
  `currentVideoPersist` **antes** do swap do DOM; o beacon usa `currentVideoPersist`, que
  aponta sempre para a aula atual) — **sem navegador disponível** para teste E2E.
- `beforeunload`/`visibilitychange` (sendBeacon): mesmo caso — verificado por leitura.
- Windows real (backup com `fs.copyFile`, rename sobrescrevendo): coberto por invariantes
  do código, não executado nesta sessão (ambiente Linux).

## 12. Riscos restantes

- **Rename/move físico** de pasta/aula cria chave nova (progresso do path antigo fica
  órfão). É comportamento **determinístico e documentado** — sem auto-migração por nome
  (proibida pela regra §19). O progresso órfão não corrompe nada; pode ser limpo pelo
  "Limpar progresso" do curso ou pelo clear global.
- **Dois clientes simultâneos** escrevendo a mesma aula: a fila serializa as escritas
  (last-write-wins por posição); sem locking distribuído — limitação conhecida e aceita
  (player local, single-user).
- **Tempo entre `timeupdate` e o flush** (`beforeunload`/`visibilitychange`): janela
  pequena de perda na troca de aula abrupta — mitigada pelo flush pré-swap em `route()`.

## 13. Alterações de documentação

- `CLAUDE.md` — comando de teste agora inclui `test/progress.test.js`; seção sobre
  `LP_DATA_DIR`; entrada do arquivo de teste na estrutura.
- `docs/DOCUMENTACAO.md`, `docs/BIBLIOTECAS.md`, `README.md` e `docs/VALIDACAO.md` — **já
  documentavam** o formato `libId\0rel`, a migração de chaves legadas e o escopo por
  biblioteca (adicionados na feature de bibliotecas); nenhuma alteração adicional
  necessária nesta auditoria. A regra tópico-vs-curso e a não-influência de `.topic`/`(TP)`
  na identidade estão em `docs/TOPICOS-MARCADORES.md`.

## 14. Veredito

O sistema de progresso é **estruturalmente correto** após as mudanças de tópicos e
bibliotecas externas:

- A identidade é o **path físico** (`libId\0rel`), nunca o título, `.topic` ou `(TP)`.
- Todas as combinações do cenário de colisão (§9 A–D) produzem chaves distintas.
- Clear é delimitado por prefixo e escopado por biblioteca; global limpa tudo.
- Chaves legadas migram sem perda; corrupção recupera em cascata (main→bak→bak.1)
  preservando os arquivos danificados.
- Shutdown drena a fila; escrita é atômica e serializada.
- A única mudança de produção foi **testabilidade** (`LP_DATA_DIR`), sem alteração de
  comportamento em uso normal.

As 6 regras de prioridade (§20: colisão, perda, aula errada, clear, shutdown, corrupção)
foram todas verificadas como **sem defeito**.

**STATUS: OK** — auditoria concluída sem alterações de correção necessárias (cobertura de
testes de integração adicionada e env de sandbox `LP_DATA_DIR` introduzida para viabilizá-la).
