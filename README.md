# Local Player

Player local/offline em Node.js + Express (backend único `server.js`, SPA em
`public/` em JS puro, **sem build step**) para organizar e reproduzir mídia em
disco — módulos, treinamentos, cursos e bibliotecas de vídeo. Lê tudo direto do
armazenamento local ou externo (HD, SSD, pendrive, cartão SD), sem envio para a
internet.

## Funcionalidades

- **Boot instantâneo e scan concorrente**: cache de árvore persistente em disco
  (`data/tree-cache-<libId>.json`) e varredura paralela com concorrência
  controlada, carregando bibliotecas com milhares de aulas em milissegundos mesmo
  em pendrives ou discos USB.
- **Tópicos hierárquicos**: pastas declaradas como tópicos (`.topic` ou nome
  terminando em `(TP)`) viram navegação com breadcrumb (`Home › TI › Python`).
- **Cards com capa inteligente**: capas automáticas detectadas pelo nome da
  imagem ou herdadas de módulos filhos; sem imagem, gera gradiente com iniciais.
- **Destaque visual sutil para módulos concluídos**: cursos e módulos com todas
  as aulas finalizadas tornam-se discretos e esmaecidos, mantendo o foco visual
  nos conteúdos pendentes.
- **Busca global e contextual**: busca instantânea por tópicos, módulos, aulas e
  materiais de apoio com correspondência flexível e sem distinção de acentos.
- **Player robusto com progresso persistente**: salvamento atômico de posição,
  retomada automática inteligente e auto-conclusão ao atingir >95% do vídeo.
- **Áudio Boost e Controles**: amplificação de volume além de 100% via Web
  Audio API (GainNode) para gravações baixas, velocidade ajustável (0.5× a 2×)
  persistida, modo teatro, tela cheia nativa e atalhos de teclado configuráveis.
- **Sidebar de aulas e materiais**: sidebar focada exclusivamente em navegação de
  aulas; arquivos de suporte (.pdf, .zip, .docx, códigos) ficam isolados na seção
  "Materiais da aula".
- **Transcoding de fallback transparente**: reprodução direta de formatos
  nativos via HTTP Range; fallback progressivo em tempo real com FFmpeg apenas
  se o navegador não suportar o codec do arquivo.
- **Multi-biblioteca configurável**: registre bibliotecas extras em pastas ou
  discos externos (Configurações → Bibliotecas) com isolamento total de chaves
  (`libId\0rel`), backups dedicados e suporte a bibliotecas desativadas.
- **Legendas automáticas por IA e Tradução**: transcrição offline com
  **whisper.cpp**, fila de prioridades (P0 a P3), correção opcional via LLM
  guardrail, tradução de legendas sob demanda e recuperação robusta contra erros.
- **Tutor IA integrado com Web Search**: assistente de estudos em tempo real via
  chat streaming (SSE), com contexto automático da aula (transcrição, timestamps
  clicáveis e leitura inteligente de PDFs, Office e códigos), pesquisa web
  segura com proteção anti-SSRF e skills de otimização de tokens (Caveman, RTK,
  Headroom).
- **Quizzes e Flashcards 3D por IA**: geração automática de questões de múltipla
  escolha com avaliação imediata e cartões de repetição espaçada com animação 3D
  baseados no conteúdo da aula.
- **Interface responsiva**: suporte completo a desktop, tablet e smartphones com
  drawer retrátil para navegação.

## Requisitos

- Node.js 18+.
- Navegador moderno (Chrome, Firefox, Edge, Safari).
- FFmpeg / FFprobe **opcionais**: necessários apenas para transcoding de vídeos
  incompatíveis e extração de áudio para legendas.
- Whisper.cpp **opcional**: necessário apenas para transcrição local de legendas
  (ver `docs/whisper.md`).

Linux e Windows — o mesmo código roda nativamente em ambos os sistemas.

## Como rodar

O app deve ficar em uma pasta cujo **pai seja a raiz da biblioteca padrão** (a
raiz é derivada da localização do app, nunca hardcoded):

```text
Minha Biblioteca/
├── Módulo A/
├── Módulo B/
└── _LocalPlayer/          ← pasta do app (nome livre)
```

```bash
npm install --no-bin-links   # --no-bin-links ajuda em drives externos/FAT/exFAT
npm start                    # servidor em http://localhost:4173
```

`PORT` e `HOST` sobrescrevem porta e interface (padrão: todas as interfaces —
use `HOST=127.0.0.1` para restringir à máquina local).

## Configuração (variáveis de ambiente)

Todas opcionais:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `4173` | Porta do servidor HTTP |
| `HOST` | todas as interfaces | Interface de rede para escuta |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` no PATH | Caminho dos binários do FFmpeg (aceita espaços) |
| `MAX_CONCURRENT_TRANSCODES` | `1` | Limite de conversões de vídeo simultâneas |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | `1` | Limite de transcrições whisper simultâneas |
| `MAX_CONCURRENT_AI_JOBS` | `1` | Slots de concorrência pesada compartilhados (transcode + whisper) |
| `BACKGROUND_SUBTITLE_GENERATION` | config da Central de IA | `true`/`1` ativa geração P3 em background |
| `WHISPER_BIN` / `WHISPER_MODEL_DIR` | `bin/` / `models/` | Binário e modelos do whisper (ver `docs/whisper.md`) |
| `LP_DATA_DIR` | `data/` | Redireciona os dados de runtime (usado para sandbox de testes) |
| `LP_NO_BROWSER` | (inativo) | `1` impede abertura automática do navegador no boot |
| `LP_PROGRESS_FORENSIC` | (inativo) | `1` ativa logs forenses detalhados de escrita de progresso |

## Uso rápido

1. Abra a Home e escolha um curso ou tópico.
2. Na página do curso, navegue pela sidebar para selecionar a aula.
3. O progresso é gravado automaticamente e retomado com precisão ao retornar.
4. Utilize o botão **⟳ Atualizar** no topo sempre que alterar ou adicionar arquivos no disco.
5. **Atalhos de teclado padrão**:
   - `Espaço`: Reproduzir / Pausar
   - `←` / `→`: Retroceder / Avançar 5 segundos
   - `J` / `L`: Retroceder / Avançar 10 segundos
   - `N` / `P`: Próxima aula / Aula anterior
   - `M`: Ativar / Desativar mudo
   - `,` / `.`: Diminuir / Aumentar velocidade
   - `F`: Tela cheia
   - `T`: Modo teatro
   - `/`: Focar campo de busca
   - `H`: Ir para a Home
   *(Todos configuráveis em Configurações → Atalhos)*.

## Tópicos

Uma pasta é classificada como **tópico** de forma explícita e previsível:
- Contém o arquivo marcador `.topic` **ou**
- Seu nome termina com o sufixo `(TP)` (case-insensitive, ex.: `Programação (TP)`).

Tópicos abrem telas de navegação hierárquica com breadcrumb. O marcador `(TP)` e
a numeração inicial são removidos apenas do título visual exibido na interface.

## Bibliotecas externas

Em **Configurações → Bibliotecas**, você pode adicionar diretórios extras por
caminho absoluto (HDs externos, pendrives ou outras pastas locais).
- Paths são validados contra aninhamento e escape.
- Chaves de progresso, favoritos e caches são isolados por biblioteca (`libId\0rel`).
- Bibliotecas desativadas permanecem visíveis para reativação ou remoção, sem bloquear caminhos.
- A remoção de bibliotecas é estritamente **config-only**: nenhum arquivo é excluído do disco.

## Legendas por IA e Tradução

O player transcreve áudio com **whisper.cpp** local de forma não-bloqueante:
1. Extração de áudio mono PCM16 com FFmpeg.
2. Transcrição com threads calculadas dinamicamente.
3. Pós-processamento determinístico e correção opcional via LLM (com guardrail contra alucinações).
4. **Tradução por IA**: traduz legendas transcritas para idiomas configurados (sob demanda no menu CC).
5. **Resiliência**: botão de ação com reinício forçado (`force=1`), cancelamento de jobs órfãos e mensagens explicativas em caso de ausência de binários ou modelos.

*Consulte o guia detalhado em `docs/whisper.md` e `docs/SUBTITLES.md`.*

## Tutor IA, Quizzes e Flashcards

Na aba lateral do Player, você tem acesso às ferramentas de estudo por IA:
- **Tutor IA**: tire dúvidas sobre a aula via streaming SSE. O assistente recebe
  automaticamente o título, hierarquia, transcrição da aula, materiais de apoio
  (com extração de PDFs sem dependências externas, arquivos Word/PowerPoint/RTF e código)
  e conta com pesquisa web integrada contra dados desatualizados.
- **Skills de IA**:
  - *Caveman*: respostas concisas e econômicas em tokens.
  - *RTK*: filtragem de ruído e logs em materiais extensos.
  - *Headroom*: compressão estruturada de contexto e snippets.
- **Quizzes**: gere testes rápidos de múltipla escolha com correção interativa e
  justificativas baseadas na aula.
- **Flashcards 3D**: memorize conceitos-chave com cartões interativos giratórios.

## Segurança e Privacidade

- **100% Local**: sem telemetria e sem dependência de nuvem para execução do player.
- As únicas saídas de rede externas acontecem caso o usuário configure LLMs remotos
  (OpenAI, Anthropic, Gemini, Groq) ou ative a pesquisa web do Tutor IA.
- Proteção anti-SSRF com validação estrita de endereços IP privados na pesquisa web.
- Proteção contra Path Traversal em todos os endpoints de arquivos e mídia.
- Materiais com código executável (HTML, JS, SVG, JSON) são servidos estritamente
  com headers `attachment` e `X-Content-Type-Options: nosniff`.
- Chaves de API ficam gravadas exclusivamente no backend (`data/ai-config.json`) e
  nunca são expostas ao frontend nem impressas nos logs.

## Desenvolvimento e Testes

- **Sem build step**: edite `server.js` ou os arquivos em `public/` e recarregue a página no navegador.
- **Verificação de sintaxe**:

```bash
node --check server.js public/app.js public/scope.js
```

- **Execução da suíte completa de testes (144 testes)**:

```bash
node --test test/*.js
```

- **Validação manual**: consulte `docs/VALIDACAO.md` para o checklist completo.

## Estrutura do projeto

- `server.js` — Backend completo (scan com cache, API REST, media Range, persistência atômica, fallback ffmpeg, pipeline Whisper e rotas do Tutor).
- `public/` — SPA em JS/CSS puro (`index.html`, `app.js`, `scope.js`, `styles.css`).
- `data/` — Runtime local: `progress.json` (+ backups), `tree-cache-<libId>.json`, `ai-config.json`, `libraries.json`, `subtitles/`, `transcoded/`.
- `test/` — Suíte de testes automatizados com `node:test` (unitários, invariância, persistência, forense e runtime smoke).
- `docs/` — Documentação técnica (`DOCUMENTACAO.md`, `SUBTITLES.md`, `whisper.md`, `VALIDACAO.md`).
