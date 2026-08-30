# Como validar alterações

Checklist operacional. Rode os passos que se aplicarem à sua mudança. A base é
a suíte automatizada; o restante é exercício manual do fluxo real.

## 1. Suíte automatizada

```bash
node --check server.js public/app.js public/scope.js
git diff --check
node --test test/progress.test.js test/topics.test.js test/libraries.test.js \
  test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js \
  test/progress-invariance.test.js test/progress-persistence.test.js \
  test/progress-forensic.test.js test/translation.test.js
```

`progress`, `sidebar-runtime-smoke`, `progress-invariance`,
`progress-persistence` e `progress-forensic` sobem servidor real com
`LP_DATA_DIR` em diretório temporário; os demais são puros.

## 2. Exercício manual da UI

Suba com `npm start` e verifique:

- **Scan/navegação**: Home com cards; abrir curso e tópico; busca
  (accent-insensitive) achando curso, aula, tópico e material.
- **Player**: reprodução de original compatível sem transcode; progresso salvo
  (recarregar preserva a posição); favoritos; atalhos; Configurações.
- **Materiais**: arquivos de apoio abaixo do player; sidebar só com aulas.

## 3. Fallback de transcoding

Use um `.mkv`/`.avi` (ou formato que o navegador não reproduza):

1. o player tenta o original → badge não-bloqueante de preparação;
2. `[TRANSCODE] progresso` no log do servidor;
3. arquivo final em `data/transcoded/` (`.tmp` só vira final após exit 0);
4. seek além do trecho convertido aguarda ou responde 416;
5. `POST /api/transcode/clear` limpa o cache e cancela jobs **sem tocar**
   `progress.json`.

## 4. Persistência de progresso

- Escreva progresso, derrube o servidor (inclusive no meio de gravação) e
  reinicie → posição preservada (restauração do backup).
- Corrompa `progress.json` (ou remova) → no boot o arquivo danificado é
  preservado como `.corrupt-<ts>` e o main é restaurado do melhor backup.
- Rescan (`⟳ Atualizar`/`POST /api/rescan`) **não** remove chaves de progresso.
- Clear explícito é o único caminho que remove entradas.

## 5. Path traversal e bibliotecas

- `/media/../../etc/passwd`, `/api/video/fallback?path=../../etc/passwd` e
  variantes Windows (`\`, `..\..\`, absolutos `C:\`/`D:\`) → 404/400, nunca
  conteúdo fora da biblioteca.
- Duas instâncias na mesma porta → mensagem clara + exit.
- Biblioteca externa: adicionar (path inválido/aninhado/proibido → erro),
  navegar/tocar/persistir com chave `libId\0rel`, remover é config-only (jobs
  ativos → 409; padrão não remove).

## 6. IA e legendas

- **Sem nada instalado**: `GET /api/ai/status` → `available:false` honesto;
  `GET /api/ai/config` sem chaves; Central de IA renderiza as 6 abas.
- **Geração** (com whisper em `WHISPER_BIN`): `POST /api/subtitles/generate` →
  log por etapa → raw criado → VTT canônico no `.courseplayer/subtitles/` e
  espelho em `data/subtitles/`. Re-POST dedup (`alreadyRunning`/cache); `force=1`
  regenera; `touch` no vídeo invalida o raw antigo.
- **Fila P0–P3**: abrir aula enfileira P0; próxima em P1; após scan, 1ª aula de
  cada curso em P2; background em P3. Não gera a biblioteca inteira.
- **LLM**: off → sem chamadas; on válido → correção aplicada; falha/timeout →
  original preservado; saída que inventa/omite id ou encurta → guardrail
  rejeita. Nenhum log imprime chave/token.
- **Concorrência**: transcode e whisper compartilham slots (não rodam juntos
  por padrão); LLM não consome slot.
- **Tradução de legendas** (LLM, sob demanda): aula EN com `translation.enabled`
  e LLM da correção configurado → menu CC mostra **Original (en)** e
  **Português**; selecionar PT enfileira P0 (`hash-lang`), vira
  `.courseplayer/subtitles/<hash>-pt.vtt` + espelho `data/subtitles/<hash>-pt.vtt`;
  a original **nunca** é tocada (raw/processed intactos). Sem LLM → só Original
  (status "Tradução indisponível", sem job morto). Falha/timeout do LLM →
  original preservado. Clear por vídeo/global apaga traduções (`hash-*`);
  `?lang=` em status/generate/editor; `/subtitles/<hash>-pt.vtt` servido com
  regex `^[0-9a-f]{24}(?:-[a-z]{2,10})?\.vtt$`.

## 7. Tópicos e escopo

- Biblioteca de teste com `.topic`/`(TP)` aninhados e cursos diretos: Home
  mostra cards de tópico (marcador explícito; `Projeto TP`/`(TP) Curso`/`Aula
  TP` não viram tópicos); breadcrumb; curso dentro de tópico abre o player.
- Escopo: "Seu progresso"/"Continuar assistindo" global na Home (com fallback
  quando não há curso direto) e restrito à subárvore dentro de tópicos;
  `TI` não alcança `TI2` (comparação por segmentos).

## 8. Mobile e desktop

- Viewports mobile (320–430px): drawer de aulas, cabeçalho compacto, controles
  em uma linha, sem overflow horizontal; arrastar no topo **não** aciona o
  pull-to-refresh (overscroll desativado) e o player mantém 16/9.
- Landscape/wide: player respeita o limite vertical (`72svh`) sem resize
  dinâmico durante scroll.
- Desktop: player, fullscreen, controles, legendas e layout inalterados.
- **Mobile ≤600px**: seletor de idioma **só no menu ⋮** (`pc-more-cc-group`); o
  popover CC da barra não abre em telas estreitas (mesma regra de volume/
  velocidade); sem estouro horizontal; drawer/cabeçalho intactos; seleção por
  toque não bloqueia a reprodução; dot CC informa estado (gerando/traduzindo).
