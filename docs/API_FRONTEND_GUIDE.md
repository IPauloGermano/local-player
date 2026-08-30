# 🎬 Local Player — Guia da API REST para o Frontend

> **Leitor ideal:** Desenvolvedor Júnior P2 que quer entender *como* o Frontend
> (SPA Vanilla JS) conversa com o Backend (Node.js/Express).
>
> Aqui você não vai encontrar só uma lista fria de rotas — vai entender o
> **porquê** de cada decisão e como as peças se encaixam. 🧩

---

## 1. O Conceito Básico (A API como "Garçom") 🍽️

Imagine que você está em um restaurante. A **cozinha** guarda os ingredientes
(os vídeos no seu HD, ex.: `C:\Cursos`). O **cliente** (seu navegador) está
sentado na mesa, mas **não tem acesso à cozinha** — não pode simplesmente pegar
um prato da geladeira.

É exatamente essa a situação aqui:

- 🚫 **O JavaScript do navegador NÃO consegue ler `C:\Cursos\aula.mp4`**
  diretamente. Por segurança, o navegador **isola** a sua máquina: uma página
  web (mesmo rodando localmente) não tem acesso ao sistema de arquivos. Um
  `fetch("C:/Cursos/...")` ou um `<video src="C:/Cursos/...">` simplesmente
  **não funciona**.
- ✅ **A solução:** a cozinha é o nosso **Backend (Node.js/Express)**. Ele roda
  *fora* do navegador, como um programa comum do seu computador, e portanto
  **pode** ler o disco. Ele atende aos pedidos do navegador e traz a comida.

> 👨‍🍳 **A API REST é o "garçom"**: o navegador faz o *pedido* (uma requisição
> HTTP) e o garçom/backend busca na cozinha (disco) e traz de volta a resposta.

### 🏠 A URL base é sempre local

Como tudo roda na sua própria máquina, a base de todas as chamadas é:

```
http://localhost:4173
```

Todas as URLs que o front usa são **relativas** (ex.: `/api/tree`). Na prática,
isso significa que o navegador resolve para
`http://localhost:4173/api/tree` automaticamente. Você **nunca** precisa
escrever o `localhost:4173` no código do front — escreve só a rota. ✅

---

## 2. Descobrimento (Montando a Árvore de Cursos) 🌳

Na tela inicial, o player precisa saber **o que existe no HD**: quais cursos,
quais tópicos, quais aulas, quais materiais. Ele não "adivinha" — ele pergunta
ao servidor, que **escaneia o disco** e monta uma **árvore** de nós.

### 🛰️ `GET /api/tree`

Retorna toda a árvore de cursos da biblioteca. Cada nó pode ser:

| Tipo | O que é |
|---|---|
| `folder` | Um curso (ou módulo) |
| `topic` | Uma pasta de tópico (agrupa cursos) |
| `video` | Uma aula em vídeo 🎥 |
| `file` | Um material (PDF, slide...) — não é aula |

Exemplo do fetch no front:

```js
async function carregarArvore() {
  const res = await fetch("/api/tree");
  const data = await res.json();
  // data.libraries[].tree contém a árvore de cada biblioteca
  const libPadrao = data.libraries.find((l) => l.isDefault);
  state.tree = libPadrao.tree;
}
```

> 💡 **Detalhe de arquitetura:** o servidor **cacheia** a árvore em memória
> (`treeCaches`) para não escanear o disco a cada clique. É rápido demais!

### 🔄 `POST /api/rescan`

Quando o usuário clica no botão **⟳ Atualizar** (ou você quer refletir um
arquivo novo que apareceu no disco), o front pede para o servidor **re-escanear
de verdade**, ignorando o cache:

```js
await fetch("/api/rescan", { method: "POST" });
// depois recarrega a árvore e re-renderiza
```

---

## 3. Mídia e Reprodução (A Mágica do Streaming) 🎞️

Aqui está uma das partes mais legais! Para tocar um vídeo, o front simplesmente
coloca a URL da mídia no `<video>`:

```html
<video src="/media/Caminho/aula.mp4"></video>
```

O servidor responde com **`GET /media/*`**, que serve o arquivo **original** do
disco. Mas calma — tem uma mágica acontecendo por baixo dos panos. 🪄

### ⭐ Conceito de Ouro: HTTP Range (Status 206)

Um vídeo de 2 horas pode ter **1 GB**. Baixar **tudo de uma vez** seria:

- Lento para começar a tocar (esperar o download inteiro);
- Desperdício de banda (o usuário talvez assista só 10 minutos).

Por isso usamos o **HTTP Range**. A ideia é simples:

> O navegador pede **só um pedaço** do arquivo:
> `"me dê do byte X até o byte Y"`.

- O servidor responde com **status `206 Partial Content`** e **apenas o trecho**
  solicitado.
- O `<video>` nativo do navegador já faz isso sozinho! Ele pede um pedaço,
  toca, e quando chega perto do fim daquele pedaço, **pede o próximo**. É isso
  que permite o **seek** (arrastar a barra de progresso) e o **streaming** sem
  baixar o arquivo inteiro. 🚀

> 📌 **Por que não baixamos tudo?** Porque o navegador é preguiçoso de um jeito
> bom: ele só baixa o que precisa *agora*. O vídeo começa em segundos e a
> memória não fica cheia.

### 🛟 Fallback de Transcoding (o plano B)

Nem todo vídeo o navegador sabe tocar. Um `.mkv` ou `.avi` pode disparar o
evento `error` no `<video>`. Nesse caso, o front não desiste — ele **pede ajuda**:

```js
videoEl.addEventListener("error", async () => {
  const res = await fetch(`/api/video/fallback?path=${encodeURIComponent(video.path)}`);
  const plano = await res.json();
  // plano.status === "transcoding" | "ready" | "compatible" ...
  // se houver URL pronta, troca o src do MESMO <video> e toca de novo.
});
```

O servidor então converte o vídeo com **FFmpeg** e serve uma versão compatível
via `/transcoded/*`. **Importante:** isso é o **plano B** — nunca fazemos isso
para um vídeo que o navegador já sabe tocar (isso seria uma regressão de
desempenho). 🔁

---

## 4. Progresso (Salvando de onde o usuário parou) 📊

Ninguém quer assistir 40 minutos de aula e, ao fechar, perder tudo e voltar do
início. Por isso o app guarda o progresso **por aula**.

### O ciclo completo 🔄

1. **Ao abrir o app:** o front carrega todo o progresso salvo com
   `GET /api/progress` e guarda em memória (`state.progress`).
2. **Enquanto o vídeo toca:** no evento `timeupdate`, o front envia
   atualizações com `POST /api/progress`.
3. **Ao voltar a uma aula:** o front lê a posição salva e faz `seek` para ela.

### 📤 Enviando progresso no `timeupdate`

Aqui está um snippet real de como o front envia o progresso:

```js
videoEl.addEventListener("timeupdate", () => {
  // Evita salvar a cada fração de segundo: só a cada ~5s
  if (videoEl.currentTime - lastSaved < 5) return;
  lastSaved = videoEl.currentTime;

  const payload = {
    path: video.path,          // caminho relativo da aula (sempre com "/")
    position: videoEl.currentTime, // onde o usuário parou (segundos)
    duration: videoEl.duration,    // duração total da aula
    completed: false,              // true quando termina (auto > 95%)
  };

  // Bibliotecas externas (outros discos) precisam dizer de onde vêm:
  if (isExternalLib(video.libId)) payload.libraryId = video.libId;

  fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
});
```

> 🧠 **`libraryId` e `relPath`:** o servidor deriva a chave
> `<libraryId>\0<rel>` a partir do `libraryId` (quando for biblioteca externa)
> e do `path` relativo. Isso garante que duas bibliotecas com o mesmo caminho
> não misturem o progresso. Para a biblioteca padrão, `libraryId` nem precisa
> ser enviado (o servidor usa a padrão).

### ⚡ Escrita atômica: protegendo contra queda de luz

Você deve estar se perguntando: "e se faltar luz bem no momento do salvamento?".
Ótima pergunta! 🔌

O servidor **não** escreve direto no arquivo. Ele usa `writeFileAtomic`:

1. Escreve em um **arquivo temporário** (`.tmp`);
2. Faz `fsync` (garante que chegou ao disco de verdade);
3. **Renomeia** o `.tmp` para o arquivo final — uma operação atômica no
   filesystem.

Resultado: **ou o arquivo fica 100% novo, ou fica 100% o antigo** — nunca um
arquivo "pela metade" e corrompido. Se algo der errado, existe até um backup
(`progress.json.bak`) para recuperação automática. 🛡️

---

## 5. Configurações Extras (Bibliotecas e IA) 🗂️🤖

### 📀 Múltiplas bibliotecas (`/api/libraries`)

O projeto suporta **vários discos/pastas** além da raiz padrão. Cada um é uma
**biblioteca** com um `id` único. As rotas:

| Rota | O que faz |
|---|---|
| `GET /api/libraries` | Lista as bibliotecas |
| `POST /api/libraries` | Adiciona uma (envia `{ path, name? }`) |
| `PATCH /api/libraries/:id` | Edita |
| `DELETE /api/libraries/:id` | Remove (**só da config**, nunca apaga arquivos!) |

E aqui mora um ponto **fundamental**:

> 🧭 **Toda requisição de mídia precisa referenciar de onde vem.** Como dois
> discos podem ter pastas com o mesmo nome, o front sempre carrega o `libId`
> junto de cada nó da árvore e o envia nas chamadas (no `libraryId` do body
> ou na URL `/media/<libId>/<rel>` para bibliotecas externas). Sem isso, o
> servidor não saberia de qual disco buscar o arquivo.

### 🤖 IA (Whisper) — sem travar o player

O app pode **gerar legendas automaticamente** usando Whisper local. Mas atenção
a uma decisão de design importante:

> **A IA nunca trava o player.** Gerar legendas demora (transcreve o áudio
> inteiro), então tudo acontece em **segundo plano**, em uma fila.

O front, ao renderizar o player, **pergunta primeiro** se a IA está disponível:

```js
const res = await fetch("/api/ai/status");
const status = await res.json();
// status.available === true  → mostra o botão "Gerar legendas"
// status.available === false → esconde o botão (sem quebrar nada)
```

Se o Whisper não estiver instalado/configurado, **o player funciona normal** —
só não aparece o botão de legendas. Nenhuma dependência, nenhum erro. 🎉

---

## 6. Dicas de Ouro de Arquitetura (o que um Júnior P2 precisa lembrar) 🏆

Guarde estas três lições — elas são o DNA deste projeto:

### 1️⃣ Barras `/` SEMPRE, mesmo no Windows 🧭

Os caminhos "relativos" (rel paths) dentro da árvore, das chaves de progresso e
das URLs **usam sempre `/`** — nunca `\`. Isso vale até rodando no Windows!

```js
// ❌ NÃO
"TI\\Python\\Aula 01.mp4"

// ✅ SIM
"TI/Python/Aula 01.mp4"
```

**Por quê?** Para o código funcionar igual no Linux e no Windows (e o backend é
multiplataforma). O servidor converte para o separador nativo só quando vai
acessar o disco de verdade. Só os caminhos *absolutos* internos usam `\` no
Windows.

### 2️⃣ Transcoding é o PLANO B, nunca o padrão 🔁

- ✅ **Compatível** (o navegador toca) → **serve direto**, sem conversão.
- 🔄 **Incompatível** → só então converte com FFmpeg.

> Converter um vídeo que o navegador já toca seria um desperdício enorme de CPU
> e tempo. A regra de ouro: **o fallback só dispara após o `error` do `<video>`**,
> e a decisão nunca é pela extensão do arquivo — é pela análise real do
> conteúdo (ffprobe).

### 3️⃣ O backend não confia no frontend 🔒

O front pode mandar qualquer caminho. Mas o servidor **nunca** usa esse caminho
direto. Ele passa por **`resolveSafeRelPath()`** (e `resolveLibraryRel` em
operações por biblioteca), que:

- Rejeita `..` (escape de diretório) e caminhos absolutos;
- Garante que o resultado está **dentro** da pasta da biblioteca;
- Devolve **404/400** se algo estiver errado.

Isso é proteção contra **Path Traversal** (`../../etc/passwd`). Nunca confie em
entrada do usuário (nem do próprio frontend) — **sempre valide no servidor.** 🔐

---

## 🧠 Resumo Mental

```
Navegador (SPA)          Backend (Express)          Disco
     │  GET /api/tree ────────►│  escaneia ─────────►│
     │  ◄── árvore de cursos ──│                     │
     │                         │                     │
     │  <video src=/media/...> │  GET /media/*       │
     │  ─── Range (206) ──────►│  lê pedaço ────────►│
     │  ◄── bytes do vídeo ────│                     │
     │                         │                     │
     │  timeupdate             │                     │
     │  POST /api/progress ───►│  writeFileAtomic ──►│ progress.json
     │  ◄── ok ────────────────│                     │
```

**Em uma frase:** o navegador pede, o backend busca no disco, e ninguém precisa
acessar o HD diretamente — a API é o garçom que faz todo o meio-campo. 🍽️✨
