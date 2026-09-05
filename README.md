# Local Player

Player local/offline em Node.js + Express (backend único `server.js`, SPA em
`public/` em JS puro, **sem build step**) para organizar e reproduzir mídia em
disco — módulos, treinamentos, cursos e bibliotecas de vídeo no **Linux**. Lê
tudo direto do armazenamento local ou externo (HD, SSD, pendrive, cartão SD),
sem envio para a internet.

## Funcionalidades

- **Boot instantâneo e scan concorrente**: cache de árvore persistente em disco
  (`data/tree-cache-<libId>.json`) e varredura paralela com concorrência
  controlada, carregando bibliotecas com milhares de aulas em milissegundos mesmo
  em pendrives ou discos USB.
- **Execução sem terminal e atalhos de sistema (Linux)**: inicialização desacoplada
  em segundo plano (`setsid`), sem janelas de terminal abertas. Integração nativa
  opcional com o menu de aplicativos e área de trabalho (GNOME, KDE, XFCE) com
  ícones nítidos em SVG/PNG via especificação FreeDesktop (`.desktop` e `hicolor`).
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

- **Sistema Operacional**: Linux (Fedora, Ubuntu, Debian, Arch Linux, openSUSE, etc.).
- **Node.js**: 18+.
- **Navegador moderno**: Firefox, Chrome, Chromium, Brave, Edge.
- **FFmpeg / FFprobe (opcionais)**: necessários apenas para transcoding de vídeos
  incompatíveis e extração de áudio para legendas.
- **Whisper.cpp (opcional)**: necessário apenas para transcrição local de legendas
  (ver `docs/whisper.md`).

## Como rodar

O app deve ficar em uma pasta cujo **pai seja a raiz da biblioteca padrão** (a
raiz é derivada da localização do app, nunca hardcoded):

```text
Minha Biblioteca/
├── Módulo A/
├── Módulo B/
└── _LocalPlayer/          ← pasta do app (nome livre)
```

### Instalação

```bash
npm install --no-bin-links   # --no-bin-links ajuda em drives externos/FAT/exFAT
```

### Execução

Você pode executar o Local Player de duas formas:

#### Opção 1: Em segundo plano (sem janela de terminal aberta)

```bash
./local-player.sh
# ou via npm:
npm run start:bg
```

O script inicia o servidor desacoplado da sessão (`setsid`), abre o navegador padrão automaticamente e libera o terminal imediatamente. Para encerrar o servidor em background:

```bash
./stop.sh
# ou:
npm run stop
```

#### Opção 2: No terminal (foreground tradicional)

```bash
npm start                    # servidor em http://localhost:4173
```

`PORT` e `HOST` sobrescrevem porta e interface (padrão: todas as interfaces —
use `HOST=127.0.0.1` para restringir à máquina local).

---

### Atalho de Aplicativo no Sistema (Opcional)

A criação do atalho no sistema é **100% opcional** e nunca é imposta automaticamente:

- **Pela Interface Web**: Acesse **Configurações → Geral** no app e clique no botão **Criar Atalho no Sistema** (ou **Remover Atalho**).
- **Pelo Terminal**:
  - Para instalar no menu de aplicativos e área de trabalho:
    ```bash
    ./instalar-atalho.sh     # ou: npm run shortcut:install
    ```
  - Para desinstalar e limpar os ícones do sistema:
    ```bash
    ./remover-atalho.sh      # ou: npm run shortcut:remove
    ```

O instalador gera o arquivo `localplayer.desktop` em `~/.local/share/applications/`, distribui os ícones em SVG e PNG na hierarquia de temas `hicolor` e atualiza a base de dados do ambiente gráfico (GNOME, KDE, etc.).


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
| `LP_IDLE_TIMEOUT_MINUTES` | `30` | Minutos de inatividade sem abas para auto-shutdown (`0` = desativado) |

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
- **Proteção Anti-CSRF e Origem Segura**: endpoints mutáveis e sensíveis (limpeza de progresso, transcoding, atalhos do sistema) exigem verificação de mesma origem (`Sec-Fetch-Site: same-origin` / `same-site`) e validação estrita de cabeçalhos `Host` e `Origin`.
- **Proteção Anti-SSRF na Pesquisa Web**: bloqueio rigoroso contra requisições a redes privadas e especiais (RFC 1918, loopback `127.0.0.0/8`, link-local `169.254.0.0/16`, CGNAT `100.64.0.0/10`, IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 `::ffff:`, túneis 6to4) e bloqueio de portas não-web perigosas.
- **Proteção contra Path Traversal**: todas as rotas de mídia e arquivos passam por resolução canônica que impede escape do diretório da biblioteca ou do aplicativo.
- **Sanitização de Caminhos na Interface**: caminhos absolutos do sistema exibidos no frontend substituem a pasta do usuário por `~` para proteger a privacidade do sistema de arquivos local.
- **Isolamento de Materiais**: arquivos de suporte com potencial executável (HTML, JS, SVG, JSON) são servidos obrigatoriamente como anexo com cabeçalhos `attachment` e `X-Content-Type-Options: nosniff`.
- **Chaves de API protegidas**: credenciais de provedores de IA ficam salvas exclusivamente no servidor (`data/ai-config.json`), nunca retornam para o navegador e são censuradas em logs.

## Desenvolvimento e Testes

- **Sem build step**: edite `server.js` ou os arquivos em `public/` e recarregue a página no navegador.
- **Verificação de sintaxe**:

```bash
node --check server.js public/app.js public/scope.js
```

- **Execução da suíte completa de testes (150 testes)**:

```bash
npm test
# ou diretamente:
node --test test/*.test.js test/*-smoke.js
```

- **Validação manual**: consulte `docs/VALIDACAO.md` para o checklist completo.

## Estrutura do projeto

- `server.js` — Backend completo (scan com cache, API REST, media Range, persistência atômica, fallback ffmpeg, pipeline Whisper, rotas do Tutor e integração com atalhos de sistema).
- `public/` — SPA em JS/CSS puro (`index.html`, `app.js`, `scope.js`, `styles.css`, `favicon.svg`, `favicon.png`).
- `assets/` — Ícones de alta fidelidade da aplicação em SVG e PNG.
- `local-player.sh` — Script de inicialização desacoplada em background para Linux (sem console aberto).
- `instalar-atalho.sh` / `remover-atalho.sh` — Scripts auxiliares para instalação e remoção dos atalhos `.desktop` e ícones no sistema.
- `stop.sh` — Script para encerramento gracioso do servidor em segundo plano.
- `data/` — Runtime local: `progress.json` (+ backups), `tree-cache-<libId>.json`, `ai-config.json`, `libraries.json`, `subtitles/`, `transcoded/`.
- `test/` — Suíte de testes automatizados com `node:test` (unitários, invariância, persistência, segurança anti-SSRF/CSRF, forense e runtime smoke).
- `docs/` — Documentação técnica (`DOCUMENTACAO.md`, `SUBTITLES.md`, `whisper.md`, `VALIDACAO.md`).
