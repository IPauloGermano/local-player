# Relatório — Tradução automática de legendas (EN → PT)

**Status:** análise de viabilidade concluída · **nenhuma alteração feita no código** · decisões de design pendentes de implementação.

---

## 1. Objetivo

Permitir que uma aula **em inglês** tenha legenda em **português**: o Whisper transcreve o áudio (legenda original, offline) e, quando o usuário seleciona PT, a legenda traduzida aparece com **português correto** e **preservando termos da língua original** (jargão, código, marcas, siglas, números).

## 2. Estado atual (fonte de verdade: `server.js`, `public/app.js`, `docs/SUBTITLES.md`)

| Aspecto | Hoje |
|---|---|
| Whisper | Só **transcreve** (`-l <lang>`, `server.js:3761`). `-tr` traduz **apenas para inglês** (token fixo do modelo) — inútil para o caso EN→PT |
| Correção LLM | Existe e é **proibida de traduzir** ("NÃO resuma... nem traduza", `server.js:4313`) |
| Língua configurada | `transcription.language` é a língua **do áudio** (entrada do whisper), não a da legenda exibida |
| Cache | `sha1(libId\0rel)[0:24]` — **sem dimensão de idioma**; 1 legenda por vídeo |
| Pipeline | raw → pós-processamento → correção LLM (opcional) → VTT → espelho + `.courseplayer` |
| Player | Menu CC fixo: "Português (Brasil)" / "Desativado" (`public/app.js:3758`) |

## 3. Viabilidade

**Viável.** O subsistema de LLM genérico já existe (`runLlmCorrection` + guardrail, `server.js:4320-4437`) e pode ser estendido com um estágio de **tradução**. Não há mudança de arquitetura; há **uma dependência nova** (ver §4).

## 4. Restrição fundamental

- **Whisper não traduz para PT** — nem por flag, nem por modelo. O caminho EN→PT é **exclusivamente via LLM** (rede).
- Sem LLM configurado: a legenda **original (EN) funciona normalmente** (offline); a tradução PT simplesmente não aparece (botão indisponível). O recurso é **aditivo**, coerente com a filosofia do projeto (legenda nunca é dependência do player).
- Alternativa offline (Argos/NMT embutido) = dependência pesada nova, **fora do escopo** recomendado.

## 5. Design proposto

### Config (`defaultAiConfig`)
Novo bloco `translation: { enabled, targetLanguage: "pt", keepTerms: true }` + reuso do LLM já configurado na aba **Correção e formatação** (`correction.providerId` + `correction.model` — uma única config de LLM). Aplicar em `sanitizeAiConfig`, `applyAiPatch` e `maskAiConfig` (regra do `CLAUDE.md`).

### Cache por idioma
- Original: mantém chave atual.
- Tradução: chave derivada `baseHash-<lang>` (ex.: `<24-hex>-pt.vtt`), com espelho em `data/subtitles/` e canônico em `.courseplayer/subtitles/`. Regex da rota `/subtitles/*` estendida para `^[0-9a-f]{24}-[a-z]{2,10}\.vtt$`.

### Pipeline
```
raw (EN) → pós-processamento → correção LLM (opcional, EN)
                                        ↓
                    tradução LLM (EN→PT, somente quando solicitado)
                                        ↓
                         VTT traduzido (baseHash-pt)
```
- Tradução **nunca toca** raw/processed/original.
- Guardrail de tradução: ids exatos, ordem controlada pelo app, heurística de tamanho ajustada para transição de idioma; falha/timeout ⇒ legenda original, nunca bloqueia.

### Trigger (sobe demanda)
- **Sob demanda**: só gera tradução quando o usuário seleciona PT naquela aula (P0, dedup por hash+lang).

### Player + padrão global
- Menu CC vira seletor real: **Original (en)** / **Português** / **Desativado**.
- Idioma-alvo padrão configurável na Central de IA; seleção por aula no player.
- Selecionou PT → `status?lang=pt` → enfileira tradução → polling → overlay carrega VTT traduzido. Sem legenda original ainda, dispara transcrição primeiro (encadeamento no frontend).

### Qualidade ("sem erros de PT, respeitando termos originais")
- Prompt dedicado: PT-BR fluente, preservar termos técnicos/código/marcas/siglas/números/nomes próprios; timestamps nunca enviados ao LLM.
- Guardrail rejeita ids faltando/duplicados/inventados e reordenamento.

## 6. Decisões alinhadas com o usuário

1. Seleção: **Player + padrão global** (menu CC + config).
2. Trigger: **Sob demanda** (economiza LLM).
3. Provider: **Reusar o LLM da Correção**.

## 7. Impacto em invariantes (sem violação)

- Chaves de cache continuam escopadas por biblioteca (dimensão `-lang`).
- Rel paths seguem `/`; VTT canônico `.courseplayer` preservado.
- Chaves/LLM só no backend; logs sem prompts completos.
- P0–P3 mantidos; tradução é derivada de artefato existente (sem "gerar biblioteca inteira").
- LLM continua opcional; transcrição offline intocada.

## 8. Riscos / considerações

- **Custo/qualidade do LLM**: PT depende do provider escolhido; guardrail cobre estrutura, não gramática fina.
- **Línguas mistas na biblioteca**: `transcription.language` é global; vídeo PT com config `en` transcreve errado (comportamento pré-existente, fora deste escopo).
- **Migração de cache**: versões antigas do VTT permanecem válidas; novo artefato é aditivo.

## 9. Arquivos afetados (quando implementar)

`server.js`, `public/app.js`, `public/styles.css` (seletor do menu CC), `docs/SUBTITLES.md`, `docs/VALIDACAO.md`, `CLAUDE.md`, + testes (`test/`).

## 10. Próximo passo

Implementar conforme §5–§6, seguindo o checklist de validação do `docs/VALIDACAO.md`.