# Guia de implementação — Tradução automática de legendas (EN → PT)

> Instruções de aplicação (a implementar em momento oportuno). Análise/contexto em `docs/TRADUCAO.md`.
> **Requisito de UI**: a interface do player **não pode ficar poluída** — o seletor de idioma vive dentro do popover do botão CC (que já existe), sem botão novo na barra, sem badge sobre o vídeo, textos curtos no menu e detalhes só em tooltip/aria (mesmo padrão já usado pelo player). Regra: **nenhum elemento novo permanente na barra do player**.
> **Requisito mobile**: **não pode quebrar a UI mobile** — no layout ≤600px o seletor de idioma só existe no grupo "Legendas" do menu ⋮ (`pc-more-cc-group`); popover CC da barra nunca abre em telas estreitas; itens com alvo de toque adequado, sem estouro horizontal e sem quebrar o cabeçalho/drawer existentes. Ver §2.1.1.

---

## 0. Escopo

1. Config global `translation` (idioma-alvo padrão, `enabled`, `keepTerms`) na Central de IA, reusando o LLM da Correção.
2. Cache de tradução por idioma: chave `baseHash-<lang>` (espelho + `.courseplayer`), sem tocar raw/processed/original.
3. Tradução **sob demanda** (P0, dedup por `hash+lang`), via LLM, com prompt dedicado + guardrail.
4. Player: menu CC vira seletor **Original (en) / Português / Desativado** — dentro do popover existente.
5. Docs + testes + checklist de validação.

---

## 1. Backend — `server.js`

### 1.1 Config (`defaultAiConfig`, ~L2076)

Adicionar ao objeto retornado:

```js
translation: {
  enabled: false,          // liga o seletor de idioma no player e a geração sob demanda
  targetLanguage: "pt",    // idioma-alvo padrão (tradução)
  keepTerms: true,         // preservar termos técnicos/marcas/siglas/código na tradução
},
```

- Lista de idiomas-alvo: reaproveitar as `languages` do provider whisper do registry (`AI_TRANSCRIPTION_PROVIDERS`, L2029) — servem tanto para transcrição quanto para tradução.
- Aplicar em **`sanitizeAiConfig`** (L2113), **`applyAiPatch`** (L2229) e **`maskAiConfig`** (L2312). Regra do `CLAUDE.md`: campo novo sem `applyAiPatch`+`maskAiConfig` vira bug de persistência.
- Validação: `targetLanguage` deve existir na lista de idiomas (clamp/fallback para `"pt"`); `keepTerms` booleano; `enabled` booleano.

### 1.2 Prompt + guardrail de tradução (novos, junto de `runLlmCorrection`, ~L4306)

- `SUBTITLE_LLM_TRANSLATE_PROMPT`: instrui **tradução fiel** EN→PT-BR fluente; preservar termos técnicos, código, marcas, siglas, números, nomes próprios e unidades; **não** resumir, explicar, reordenar, alterar ids nem devolver timestamps; retornar JSON `[{id,text}]`.
- `runLlmTranslation({ providerId, model, segments, targetLanguage, keepTerms, timeoutMs })`: clone da estrutura de `runLlmCorrection` (mesma montagem de URL, mesmas regras de timeout/abort e "nunca bloqueia"). Envia o prompt de tradução + `{id,text}` apenas; chave resolvida no backend.
- `applyLlmTranslationGuardrail(original, translated)`: mesmo contrato de ids (faltando/duplicado/inventado ⇒ rejeita tudo) + reordenação controlada pelo app + heurística de tamanho **ajustada para idioma** (limites mais folgados que os da correção, ex. 0.25×–6×, pois EN→PT pode alongar; documentar). Falha/timeout ⇒ retorna `null` → legenda original permanece.

### 1.3 Artefatos de tradução

- Chaves:
  - Original: `hash = subtitleCacheName(libId, rel)` (inalterado).
  - Tradução: `translationCacheName(hash, lang)` = `hash + "-" + lang` (ex. `<24-hex>-pt`). Helper junto de `subtitleCacheName` (L2697).
- Caminhos:
  - Processado/traduzido: `data/subtitles/translations/<hash>-<lang>.json` (novo dir `SUBTITLE_TRANSLATION_DIR`, adicionar no `ensureSubtitleDirs`, L2905).
  - VTT: espelho `data/subtitles/<hash>-<lang>.vtt` + canônico `.courseplayer/subtitles/<hash>-<lang>.vtt`.
  - Estrutura do JSON: `{ version, source, language, targetLanguage, provider, model, correctedByLlm, segments }`.
- Validação de cache idêntica à de processed: `mtimeMs+size` do vídeo + `version` (espelhar `loadValidProcessed`, L3341).

### 1.4 Rotas

- **`GET /api/subtitles/status`** (`subtitleStatusFor`, L5181): aceitar `?lang=<lang>`.
  - Sem `lang` ou `lang` == língua-fonte → comportamento atual (reporta a legenda original).
  - Com `lang` != fonte → reportar estado **da tradução**: `ready` (VTT traduzido válido), `status/progress/percent/error` do job de tradução, `canTranslate` (LLM da correção configurado: `correction.enabled && providerId && model`), `needTranscription` (sem processed válido), `sourceReady`.
  - Retornar sempre `language` (fonte real, do processed quando disponível) e `translation: { enabled, targetLanguage, keepTerms }`.
- **`POST /api/subtitles/generate`** (L5229): aceitar `?lang=<lang>`.
  - `lang` ausente/== fonte → fluxo atual.
  - `lang` != fonte → se tradução já válida, `{ ok:true, skipped:true }`; se não há processed válido, **não** criar job de tradução — enfileirar transcrição normal (P0) e responder `{ ok:true, needTranscription:true }` (o frontend encadeia); se processed válido, criar **job de tradução** com chave `hash-lang` (dedup/promoção análogos a `startSubtitleJob`).
- **Job de tradução**: reusar `subtitleJobs` com chave `hash-lang`. Estados: `queued → translating → formatting → completed` (não passa por extração/whisper — consome o processed). `subtitleJobPersistShape` (L2940), `loadSubtitleJobs` (L2970), `updateSubtitleJob`, `scheduleNextSubtitleJob` e `cancelSubtitleJob` precisam aceitar a chave estendida e restaurar `rel/abs` do `libraryId+rel` persistidos (mesma lógica atual).
- **`GET /subtitles/*`** (L5463): estender regex para `^([0-9a-f]{24})(?:-([a-z]{2,10}))?\.vtt$`. Com `-lang`, servir canônico `baseHash-lang` primeiro (quando `rel` bate com o hash-base) e espelho depois.
- **`GET /api/subtitles/editor`** (L4460): aceitar `?lang=<lang>`; quando `lang` != fonte, servir o doc de tradução (segments traduzidos) se existir, senão `source:null/ready:false`.
- **`POST /api/subtitles/clear`** (L5384): limpeza por vídeo/global deve apagar também `data/subtitles/translations/<hash>-*` e os canônicos `.courseplayer/<hash>-<lang>.vtt`; `data/subtitles/<hash>-<lang>.vtt`.

### 1.5 Pipeline original (L3567-3616)

- **Não alterar** a geração do VTT original (a legenda-fonte continua sendo o produto do pipeline atual).
- Após concluir um job de transcrição, não há tradução automática (é sob demanda) — mas se houver `needTranscription` pendente mapeado para `hash-lang` (fila em memória), enfileirar o job de tradução.

---

## 2. Frontend — `public/app.js` + `public/styles.css`

### 2.1 Player (sem poluir a barra)

- **Menu CC** (L3750-3766): o grupo "Idioma" deixa de ser fixo e passa a ser montado dinamicamente por `syncSubtitleCcUi`:
  - Item **Original (<lang>)** — `data-cc="lang-source"`.
  - Item(s) de tradução — ex. **Português** — `data-cc="lang-pt"` (nomes curtos; sem "Brasil" dentro do menu para não alargar).
  - Item **Desativado** — `data-cc="off"`.
  - Nenhum elemento novo na `pc-bottom`; o seletor vive dentro do popover. No mobile, espelhar no grupo do ⋮ (`pc-more-cc-group`), como já é feito.
- **Estado** (`subtitleState`, L4235): adicionar `lang` (idioma ativo: `null` = original, ou `"pt"`). Preferência persistida em `localStorage` (`course-player-subtitles-lang`) como padrão; o status da API fornece o idioma disponível por aula.
- **Delegation** (L4177-4188): `data-cc="lang-source"`/`lang-pt` → `setSubtitleLang(lang)` (seta estado + preferência + dispara `loadSubtitleOverlay`); `off` → `setSubtitleEnabled(false)` (inalterado).
- **`setupPlayerSubtitles`/`check()`** (L4807/L4881): a sondagem envia `&lang=<lang ativo>`; ao selecionar PT sem tradução pronta:
  1. `status?lang=pt` → se `needTranscription`, dispara `generate` normal (P0) e segue sondando;
  2. se `sourceReady` e não `ready`, dispara `generate?lang=pt` (P0, dedup);
  3. quando `ready`, `loadSubtitleOverlay` carrega com `lang=pt`.
  - Manter o encadeamento não-bloqueante (nunca `await` antes de `video.play()`).
- **`loadSubtitleOverlay`** (L4768): passa `&lang=<lang>` para `/api/subtitles/editor` e guarda `subtitleState.lang`.
- **`syncSubtitleCcUi`** (L4293): atualizar `aria-pressed`/`.is-active` dos itens de idioma conforme `subtitleState.lang` + `enabled`; tooltip do botão CC curto (ex. "Legendas: PT"), detalhe só em `aria-label`/`title`.

### 2.1.1 Mobile (≤600px) — não quebrar a UI

- **Seletor só no ⋮**: em telas estreitas o grupo "Legendas" do menu ⋮ (`pc-more-cc-group`, L3779-3784) é o **único** ponto de seleção de idioma. O botão CC da barra (`pc-group-cc`) permanece funcional apenas como indicador de estado (dot), e seu popover **não abre** — mesma regra já aplicada a volume/velocidade no mobile (ver CSS `styles.css:3507`); reutilizar o mesmo mecanismo de ocultação, não criar outro.
- **Espelhar itens dinâmicos**: `syncSubtitleCcUi` também popula o `pc-more-cc-group` com **Original (<lang>)** / **Português** / **Desativado** (idênticos aos da barra, mesmos `data-cc`). Os itens do `pc-cc-menu` (barra) continuam existindo no DOM para desktop, mas não devem ser o alvo de toque no mobile.
- **Sem estouro horizontal**: itens do menu ⋮ com texto curto; se o nome do idioma original for longo (ex. "Alemão"), usar o id curto (`de`) no rótulo ou truncar com CSS (`max-width` + `text-overflow: ellipsis`). `overflow-x` do menu nunca muda; `pc-menu-item` mantém `min-height`/`padding` atuais (alvo de toque ≥44px).
- **Não quebrar drawer/cabeçalho**: nenhuma alteração na estrutura do `#lesson-header`, do drawer (`drawer-open`) ou dos breakpoints existentes. Fechar o menu ⋮ via `closePopovers()` ao tocar num item de idioma (padrão atual).
- **Touch**: seleção de idioma dispara o **mesmo** fluxo não-bloqueante do desktop (nunca bloqueia `video.play()`); sem modais/confirmações no caminho do toque.
- **Regressão visual**: verificar que os grupos ⋮ não somem com `closeOtherModules` e que o dot CC continua informando estado (gerando/traduzindo/falha) sem ocupar a barra.

### 2.2 Central de IA

- Aba **Correção e formatação** (`renderAiCorrection`/`bindAiCorrection`, ~L1917): novo grupo **"Tradução de legendas"** com:
  - switch `enabled` (id `ai-tr-translate-enabled`);
  - select de idioma-alvo (id `ai-tr-translate-lang`, lista de idiomas do registry);
  - switch `keepTerms` (id `ai-tr-translate-terms`);
  - nota curta: "Reusa o provedor LLM da correção. Sem LLM configurado, apenas a legenda original é exibida."
  - Salvar no mesmo `POST /api/ai/config` existente (`translation` no payload).

### 2.3 CSS (`styles.css`)

- Sem novos elementos de barra; apenas estilos para os itens de idioma do menu CC (reaproveitar `.pc-menu-item`/`.is-active`). Ajustar largura máxima do popover CC se necessário.

---

## 3. Docs

- **`docs/SUBTITLES.md`**: seção "Tradução de legendas (LLM)" — pipeline, chave de cache `baseHash-lang`, rotas com `lang`, prompt/guardrail, restrição (Whisper não traduz PT; LLM obrigatório), comportamento sem LLM.
- **`docs/VALIDACAO.md`**: checklist — gerar EN, traduzir PT, falha de LLM ⇒ original, dedup/promoção, clear por vídeo/global apaga traduções, path traversal com `lang`, regex do VTT com sufixo.
- **`CLAUDE.md`**: resumo do bloco `translation` na config + invariante "tradução nunca toca raw/processed/original; só sob demanda".

---

## 4. Testes

- `test/`:
  - `translationCacheName` determinístico + escopado por lib (estilo `libraries.test.js:231`).
  - Guardrail de tradução: ids faltando/duplicado/inventado ⇒ null; reordenação corrigida; limites de tamanho.
  - `sanitizeAiConfig`/`applyAiPatch`/`maskAiConfig` com o bloco `translation`.
  - Regex do VTT: `hash.vtt` e `hash-pt.vtt` aceitos; `hash-pt-.vtt`/path traversal rejeitados.
- Rodar a suíte completa do `CLAUDE.md` + `node --check server.js public/app.js public/scope.js`.

---

## 5. Checklist de validação manual

1. Config LLM na aba Correção + `translation.enabled` → selecionar **Português** no menu CC de uma aula EN.
2. Sem LLM: menu CC mostra só **Original (en)** / **Desativado**; tradução indisponível, player normal.
3. Seleção PT → badge/status "Traduzindo…" → overlay em PT; original EN preservado.
4. LLM falha/timeout → legenda original continua; sem bloqueio.
5. `data/subtitles/<hash>-pt.vtt` + `.courseplayer/subtitles/<hash>-pt.vtt` criados; clear por vídeo/global remove ambos.
6. UI: barra do player **sem novos botões**; seletor só dentro do popover CC (desktop) e ⋮ (mobile ≤600px).
7. **Mobile (≤600px)**: seletor de idioma visível **só no ⋮**; popover CC da barra não abre; sem estouro horizontal; drawer/cabeçalho intactos; seleção por toque não bloqueia a reprodução; dot CC informa estado.