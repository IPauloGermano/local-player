// Servidor local do "Local Player": escaneia o conteúdo de mídia em disco
// (cursos, treinamentos, bibliotecas de vídeo etc.), expõe uma API de árvore
// de conteúdo, serve os vídeos/materiais com suporte a range requests
// (necessário para o <video>) e persiste o progresso do usuário.
// Os arquivos são servidos SEMPRE no formato original, direto do disco — sem
// transcodificação, conversão ou processamento (player local, como VLC).

const express = require("express");
const path = require("path");
const state = require("./server/state");
const core = require("./server/index.js");

const app = express();

// Headers de segurança baseline em TODA resposta (JSON/erros/HTML/arquivos):
// nosniff evita MIME-sniffing (material não pode ser renderizado como outro
// tipo); Referrer-Policy evita vazar paths/nomes de cursos no Referer ao abrir
// links externos; X-Frame-Options impede a UI de ser embutida num iframe de
// outro site (clickjacking).
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  next();
});

// Monitoramento de atividade para economia de energia e desligamento automático por inatividade
app.use((req, res, next) => {
  if (
    req.path !== "/api/system/idle" &&
    req.path !== "/api/system/status" &&
    req.path !== "/api/logs"
  ) {
    core.recordActivity();
  }
  next();
});

app.use(express.json({ limit: "100kb" }));

// Proteção anti-CSRF global para todas as rotas mutantes (POST, PUT, PATCH, DELETE).
// Bloqueia requisições cross-site (Sec-Fetch-Site: cross-site) e Origins/Referers divergentes do Host.
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const csrf = core.verifyCsrfAndSafeOrigin(req);
    if (!csrf.ok) {
      return res.status(csrf.status).json({ error: csrf.error });
    }
  }
  next();
});

// Registro de rotas desacopladas por submódulo
core.registerLibraryRoutes(app);
core.registerProgressRoutes(app);
core.registerMediaRoutes(app);
core.registerSystemRoutes(app);
core.registerAiRoutes(app);
core.registerTutorRoutes(app);
core.registerSubtitleRoutes(app);

// Intercept de GET / ANTES do express.static(public). Quando o estado real do
// sistema não está pronto (biblioteca/dispositivo/aplicação indisponível),
// serve a página de indisponibilidade em vez de deixar o Express cair no
// finalhandler com "Cannot GET /".
app.get("/", async (req, res, next) => {
  const st = await core.getSystemStatus().catch(() => null);
  if (!st || st.ready || st.spa === "available") return next();
  console.error(`[APP] servindo página de indisponibilidade (reason=${st.reason || "?"}, code=${st.code || "-"})`);
  res
    .status(503)
    .set("Cache-Control", "no-store")
    .set("X-Content-Type-Options", "nosniff")
    .type("html")
    .send(core.UNAVAILABLE_HTML);
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => {
      // CSP só na SPA (assets próprios, sem recursos externos; inline styles
      // vêm de atributos style gerados pelo app). Não é aplicado à página de
      // indisponibilidade (servida de memória com script inline próprio).
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    },
  }),
);

// Erros assíncronos não tratados não devem derrubar o servidor
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

process.on("SIGINT", () => core.shutdownNow(0));
process.on("SIGTERM", () => core.shutdownNow(0));

let server;

// O servidor só sobe quando executado diretamente (`node server.js`). Quando
// `require`'d (testes com node:test), expõe as funções sem bindar porta
// nem tocar em data/ (ensureTools/initPersistence ficam de fora).
if (require.main === module) {
  core.ensureTools();
  // Sobe o listener SÓ depois que a persistência terminar
  core.initPersistence()
    .then(() => {
      server = app.listen(state.PORT, state.HOST, () => {
        state.server = server;
        console.log(`Local Player rodando em http://${state.HOST}:${state.PORT}`);
        if (state.HOST === "0.0.0.0" || state.HOST === "::") {
          console.log("[SECURITY] Escutando em todas as interfaces. Operações administrativas destrutivas restritas a localhost.");
        }
        const libCount = core.getLibraries().length;
        console.log(`Bibliotecas: ${libCount} (padrão: ${state.ROOT})`);
        core.openBrowserInBackground();
        core.startIdleCheckLoop();
      });

      // Duas instâncias simultâneas na mesma porta: sai com mensagem clara
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            `A porta ${state.PORT} já está em uso: outra instância do Local Player já está rodando. Encerre-a antes de iniciar novamente.`,
          );
          process.exit(1);
        }
        throw err;
      });
    })
    .catch((err) => {
      console.error("Falha ao iniciar persistência:", err && err.message);
      process.exit(1);
    });
} else {
  module.exports = {
    ...core,
    app,
  };
}
