# Local Player

Player local/offline em Node.js + Express (backend único `server.js`, SPA em
`public/` em JS puro, **sem build step**) para organizar e reproduzir mídia em
disco — cursos, treinamentos, bibliotecas de vídeo. Lê tudo direto do
armazenamento (HD, SSD, pendrive), sem upload para a internet.

## Funcionalidades

- escaneia a biblioteca e monta a árvore de cursos/módulos/aulas;
- cards com capa automática (imagem da pasta ou gradiente com iniciais);
- **tópicos hierárquicos**: pastas declaradas como tópicos (`*.topic` ou nome
  terminando em `(TP)`) viram navegação com breadcrumb (`Home › TI › Python`);
- busca por tópico, curso, aula e material de apoio;
- player com **progresso persistente por aula** e retomada automática;
- sidebar de módulos/aulas; arquivos de apoio ficam em "Materiais da aula";
- atalhos de teclado configuráveis;
- reprodução direta do original (HTTP Range) com **transcoding de fallback**
  (ffmpeg) só para formatos que o navegador não reproduz;
- **bibliotecas externas** por path absoluto (Configurações → Bibliotecas);
- **legendas automáticas por IA** (whisper.cpp local + correção LLM opcional) —
  recurso adicional, nunca bloqueia a reprodução;
- layout responsivo (desktop, tablet, smartphone).

## Requisitos

- Node.js 18+.
- Navegador moderno (Chrome, Firefox, Edge).
- ffmpeg/ffprobe **opcionais** — necessários apenas para o fallback de
  transcoding e para extrair o áudio das legendas.

Linux e Windows — o mesmo código roda nos dois sistemas.

## Como rodar

O app deve ficar em uma pasta cujo **pai seja a raiz da biblioteca** (a raiz é
derivada da localização do app, nunca hardcoded):

```text
Minha Biblioteca/
├── Curso A/
├── Curso B/
└── _LocalPlayer/          ← pasta do app (nome livre)
```

```bash
npm install --no-bin-links   # --no-bin-links ajuda em drives externos/FAT
npm start                    # servidor em http://localhost:4173
```

`PORT` e `HOST` sobrescrevem porta/interface (padrão: todas as interfaces — use
`HOST=127.0.0.1` para restringir à máquina local).

## Configuração (variáveis de ambiente)

Todas opcionais:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `4173` | porta do servidor |
| `HOST` | todas as interfaces | interface de escuta |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` no PATH | caminho dos binários (aceita espaços) |
| `MAX_CONCURRENT_TRANSCODES` | `1` | conversões simultâneas |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | `1` | transcrições whisper simultâneas |
| `BACKGROUND_SUBTITLE_GENERATION` | config da Central de IA | `true`/`1` liga geração P3 em background |
| `WHISPER_BIN` / `WHISPER_MODEL_DIR` | `bin/` / `models/` | binário e modelos do whisper (ver docs/whisper.md) |
| `LP_DATA_DIR` | `data/` | redireciona os dados de runtime (uso de testes) |

## Uso rápido

1. Abra a Home e escolha um curso (ou tópico).
2. Na página do curso, navegue pela sidebar para escolher a aula.
3. O progresso é salvo automaticamente e retomado ao voltar.
4. Use **⟳ Atualizar** no topo quando mudar arquivos/pastas.
5. Atalhos padrão: `Espaço` play/pause, `←`/`→` ±5s, `J`/`L` ±10s, `N`/`P`
   próxima/anterior, `M` mudo, `,`/`.` velocidade, `F` tela cheia, `T` modo
   teatro, `/` busca, `H` Home. Todos configuráveis em Configurações.

## Tópicos

Uma pasta é **tópico** somente quando marcada explicitamente: contém o arquivo
vazio `.topic` **ou** o nome termina com `(TP)` (case-insensitive). Nenhuma
heurística de conteúdo classifica pastas. O `(TP)` e a numeração inicial
somem apenas do título exibido. Tudo o mais é curso/módulo normal.

## Bibliotecas externas

Em **Configurações → Bibliotecas**, registre bibliotecas extras por path
absoluto. O path é validado (absoluto, realpath, sem aninhamento, sem apontar
para a pasta do app/dados). Progresso, favoritos e caches são escopados por
biblioteca (`libId\0rel`). **Remover** é config-only: nenhum arquivo é tocado;
a remoção é bloqueada enquanto houver jobs ativos.

## Legendas por IA

O player pode gerar legendas automaticamente com **whisper.cpp** local
(extração de áudio com ffmpeg → transcrição → correção LLM opcional com
guardrail → WebVTT). Nada é baixado pelo projeto: instale o binário e o modelo
manualmente — guia completo em `docs/whisper.md`. Sem binário/modelo/chave/
internet o player funciona normalmente (o badge mostra "Legenda indisponível").
Chaves de API ficam só no servidor (`data/ai-config.json`), nunca no navegador
nem nos logs.

## Segurança

- Servidor local; as únicas saídas de rede são o teste de conexão do LLM e a
  correção opcional de legendas, ambos só quando configurados.
- Todo path vindo do navegador é validado contra path traversal e restrito à
  biblioteca da requisição; symlinks apontando para fora da biblioteca não são
  servidos.
- A pasta do app (`data/` inclusive) não é servida por `/media/*`.
- Materiais com conteúdo ativo (html/js/json etc.) são servidos como
  `attachment` + `nosniff`.
- Caches (transcode/legendas) usam nomes em hash, nunca nomes de arquivo do
  usuário em URLs.

## Desenvolvimento

- Sem build step: edite `server.js` e `public/` e recarregue a página.
- Verificação de sintaxe: `node --check server.js public/app.js public/scope.js`.
- Testes:

```bash
node --test test/progress.test.js test/topics.test.js test/libraries.test.js \
  test/scope.test.js test/sidebar.test.js test/sidebar-runtime-smoke.js \
  test/progress-invariance.test.js test/progress-persistence.test.js \
  test/progress-forensic.test.js
```

- Checklist de validação manual: `docs/VALIDACAO.md`.

## Estrutura

- `server.js` — backend completo (scan, API, media, persistência, transcoding, legendas).
- `public/index.html`, `public/app.js`, `public/scope.js`, `public/styles.css` — SPA.
- `data/` — runtime local: `progress.json` (+ backups), `transcoded/`, `ai-config.json`, `subtitles/`, `libraries.json`.
- `test/` — testes `node:test` (puros e com servidor real via `LP_DATA_DIR`).
- `docs/` — documentação técnica.

## Documentação

- `docs/DOCUMENTACAO.md` — referência técnica (arquitetura, API, persistência, transcoding, frontend).
- `docs/SUBTITLES.md` — subsistema de legendas/IA em detalhe.
- `docs/whisper.md` — instalação e configuração do whisper.cpp.
- `docs/VALIDACAO.md` — checklist de validação.
