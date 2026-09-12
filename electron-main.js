// electron-main.js — Ponto de entrada nativo do Electron para o Local Player
const { app, BrowserWindow, powerSaveBlocker, dialog, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { fork } = require("child_process");

app.setName("Local Player");
if (process.platform === "linux") {
  app.setAppUserModelId("com.localplayer.app");
}

let mainWindow = null;
let serverProcess = null;
let powerSaveId = null;

// 1. Resolução do diretório de dados (durabilidade e portabilidade)
function resolveDataDir() {
  if (process.env.LP_DATA_DIR) {
    return path.resolve(process.env.LP_DATA_DIR);
  }
  // Se estiver executando como AppImage empacotado:
  if (process.env.APPIMAGE) {
    const appImageDir = path.dirname(process.env.APPIMAGE);
    const portableMarker = path.join(appImageDir, ".portable");
    const portableDataDir = path.join(appImageDir, "data");
    // Modo portátil explícito (pendrive com .portable ou pasta data/ já existente)
    if (fs.existsSync(portableMarker) || (fs.existsSync(portableDataDir) && fs.statSync(portableDataDir).isDirectory())) {
      try {
        fs.mkdirSync(portableDataDir, { recursive: true });
        fs.accessSync(portableDataDir, fs.constants.W_OK);
        return portableDataDir;
      } catch {}
    }
    // Armazenamento padrão persistente do usuário (~/.config/local-player/data)
    const fallbackDir = path.join(app.getPath("userData"), "data");
    fs.mkdirSync(fallbackDir, { recursive: true });
    return fallbackDir;
  }
  // Modo de desenvolvimento local
  const devDataDir = path.join(__dirname, "data");
  fs.mkdirSync(devDataDir, { recursive: true });
  return devDataDir;
}

// 2. Resolução da raiz padrão da biblioteca
function resolveRootDir() {
  if (process.env.LP_ROOT_DIR) {
    return path.resolve(process.env.LP_ROOT_DIR);
  }
  if (process.env.APPIMAGE) {
    const appImageDir = path.dirname(process.env.APPIMAGE);
    const coursesDir = path.join(appImageDir, "courses");
    const portableMarker = path.join(appImageDir, ".portable");
    // Se houver pasta courses/ no mesmo diretório do AppImage:
    if (fs.existsSync(coursesDir) && fs.statSync(coursesDir).isDirectory()) {
      return coursesDir;
    }
    // Se estiver em modo portátil explícito (.portable no pendrive):
    if (fs.existsSync(portableMarker)) {
      return appImageDir;
    }
    // Padrão amigável para usuário de desktop: pasta Videos do sistema
    try {
      const videosDir = app.getPath("videos");
      if (videosDir && fs.existsSync(videosDir)) return videosDir;
    } catch {}
    try {
      const homeDir = app.getPath("home");
      const homeVideos = path.join(homeDir, "Videos");
      if (fs.existsSync(homeVideos)) return homeVideos;
      return homeDir;
    } catch {}
    return appImageDir;
  }
  return path.resolve(__dirname, "..");
}

// 3. Procura uma porta livre a partir de 4173
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.once("close", () => resolve(true)).close();
      })
      .listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort = 4173) {
  let port = startPort;
  while (port < startPort + 50) {
    const available = await checkPortAvailable(port);
    if (available) return port;
    port++;
  }
  return startPort;
}

// 4. Aguarda o servidor HTTP responder
async function waitForServer(url, maxTimeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxTimeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// 5. Gerenciamento do estado da janela (tamanho e posição)
function loadWindowState(dataDir) {
  try {
    const stateFile = path.join(dataDir, "desktop-window-state.json");
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
  } catch {}
  return { width: 1280, height: 800 };
}

function saveWindowState(win, dataDir) {
  try {
    if (!win || win.isDestroyed()) return;
    const isMax = win.isMaximized();
    const bounds = win.getBounds();
    const state = {
      ...bounds,
      isMaximized: isMax,
    };
    const stateFile = path.join(dataDir, "desktop-window-state.json");
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

// Instala o ícone no tema hicolor do usuário para o Wayland/GNOME associar a janela
function installDesktopIcon() {
  if (process.platform !== "linux") return;
  try {
    const home = app.getPath("home");
    const hicolorDir = path.join(home, ".local", "share", "icons", "hicolor");
    const iconSource = path.join(__dirname, "assets", "icon.png");
    if (!fs.existsSync(iconSource)) return;

    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const dir = path.join(hicolorDir, `${size}x${size}`, "apps");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "local-player.png");
      if (!fs.existsSync(target)) {
        fs.copyFileSync(iconSource, target);
      }
    }
  } catch {}
}

async function startApp() {
  const dataDir = resolveDataDir();
  const rootDir = resolveRootDir();
  const serverPort = await findAvailablePort(4173);
  const serverHost = "127.0.0.1";
  const serverUrl = `http://${serverHost}:${serverPort}/`;

  console.log(`[DESKTOP] Inicializando Local Player Nativo...`);
  console.log(`[DESKTOP] Data Dir: ${dataDir}`);
  console.log(`[DESKTOP] Root Dir: ${rootDir}`);
  console.log(`[DESKTOP] Porta: ${serverPort}`);

  // Resolve diretório de recursos caso empacotado
  const resourcesDir = process.resourcesPath || __dirname;
  const embeddedBin = path.join(resourcesDir, "bin");
  const embeddedModels = path.join(resourcesDir, "models");
  const appImageDir = process.env.APPIMAGE
    ? path.dirname(process.env.APPIMAGE)
    : __dirname;
  const portableModels = path.join(appImageDir, "models");
  const userDataModels = path.join(dataDir, "models");

  const serverEnv = {
    ...process.env,
    LP_DATA_DIR: dataDir,
    LP_ROOT_DIR: rootDir,
    LP_NO_BROWSER: "1",
    PORT: String(serverPort),
    HOST: serverHost,
  };

  // Prioriza binários de IA integrados no pacote se existirem
  const embeddedWhisperCli = path.join(embeddedBin, "whisper-cli");
  if (fs.existsSync(embeddedWhisperCli)) {
    serverEnv.WHISPER_BIN = embeddedWhisperCli;
    serverEnv.PATH = `${embeddedBin}${path.delimiter}${process.env.PATH || ""}`;
    serverEnv.LD_LIBRARY_PATH = `${embeddedBin}${path.delimiter}${process.env.LD_LIBRARY_PATH || ""}`;
    console.log(`[DESKTOP] Whisper integrado ativo: ${embeddedWhisperCli}`);
  }

  function hasModelFiles(dir) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const files = fs.readdirSync(dir);
        return files.some((f) => f.startsWith("ggml-") && f.endsWith(".bin"));
      }
    } catch {}
    return false;
  }

  // Resolução da pasta de modelos do Whisper:
  // 1. Env explícito WHISPER_MODEL_DIR
  // 2. Pasta models/ ao lado do executável AppImage (modo portátil / pen drive)
  // 3. Pasta models/ no diretório pai (quando executado de dist/)
  // 4. Pasta models/ no perfil de dados do usuário (~/.config/Local Player/data/models)
  // 5. Pasta models/ integrada se existir
  const parentModels = path.join(appImageDir, "..", "models");
  let activeModelsDir = null;
  if (process.env.WHISPER_MODEL_DIR && fs.existsSync(process.env.WHISPER_MODEL_DIR)) {
    activeModelsDir = process.env.WHISPER_MODEL_DIR;
    console.log(`[DESKTOP] Modelos Whisper (via env): ${activeModelsDir}`);
  } else if (hasModelFiles(portableModels)) {
    activeModelsDir = portableModels;
    console.log(`[DESKTOP] Modelos Whisper detectados ao lado do executável: ${portableModels}`);
  } else if (hasModelFiles(parentModels)) {
    activeModelsDir = parentModels;
    console.log(`[DESKTOP] Modelos Whisper detectados na raiz pai: ${parentModels}`);
  } else if (hasModelFiles(userDataModels)) {
    activeModelsDir = userDataModels;
    console.log(`[DESKTOP] Modelos Whisper detectados no perfil do usuário: ${userDataModels}`);
  } else if (hasModelFiles(embeddedModels)) {
    activeModelsDir = embeddedModels;
    console.log(`[DESKTOP] Modelos Whisper integrados: ${embeddedModels}`);
  } else if (fs.existsSync(portableModels)) {
    activeModelsDir = portableModels;
  } else {
    activeModelsDir = process.env.APPIMAGE ? portableModels : userDataModels;
  }
  serverEnv.WHISPER_MODEL_DIR = activeModelsDir;

  // Inicia o server.js em subprocesso isolado
  const serverScript = path.join(__dirname, "server.js");
  serverProcess = fork(serverScript, [], {
    env: serverEnv,
    stdio: "inherit",
  });

  // Quando o servidor interno encerra (ex.: desligamento automático por inatividade), fecha o app desktop
  serverProcess.on("exit", (code) => {
    console.log(`[DESKTOP] Servidor interno finalizado (código: ${code})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    app.quit();
  });

  serverProcess.on("message", async (msg) => {
    if (msg && msg.type === "select-folder") {
      try {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: "Selecionar pasta da biblioteca",
          properties: ["openDirectory", "createDirectory"],
        });
        serverProcess.send({
          id: msg.id,
          type: "select-folder-result",
          supported: true,
          canceled: result.canceled,
          path: !result.canceled && result.filePaths && result.filePaths[0] ? result.filePaths[0] : null,
        });
      } catch (err) {
        serverProcess.send({
          id: msg.id,
          type: "select-folder-result",
          supported: true,
          error: err && err.message,
        });
      }
    }

    if (msg && msg.type === "select-model-file") {
      try {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: "Selecionar arquivo de modelo do Whisper (.bin)",
          filters: [
            { name: "Modelos Whisper (*.bin)", extensions: ["bin"] },
            { name: "Todos os arquivos", extensions: ["*"] },
          ],
          properties: ["openFile"],
        });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) {
          serverProcess.send({
            id: msg.id,
            type: "select-model-file-result",
            supported: true,
            canceled: true,
          });
        } else {
          const chosenFile = result.filePaths[0];
          const targetDir = activeModelsDir || path.join(dataDir, "models");
          fs.mkdirSync(targetDir, { recursive: true });
          const targetFile = path.join(targetDir, path.basename(chosenFile));
          if (chosenFile !== targetFile) {
            fs.copyFileSync(chosenFile, targetFile);
          }
          serverProcess.send({
            id: msg.id,
            type: "select-model-file-result",
            supported: true,
            canceled: false,
            path: targetFile,
            filename: path.basename(targetFile),
          });
        }
      } catch (err) {
        serverProcess.send({
          id: msg.id,
          type: "select-model-file-result",
          supported: true,
          error: err && err.message,
        });
      }
    }

    if (msg && msg.type === "open-models-folder") {
      try {
        const targetDir = activeModelsDir || path.join(dataDir, "models");
        fs.mkdirSync(targetDir, { recursive: true });
        const { shell } = require("electron");
        await shell.openPath(targetDir);
        serverProcess.send({
          id: msg.id,
          type: "open-models-folder-result",
          supported: true,
          ok: true,
          path: targetDir,
        });
      } catch (err) {
        serverProcess.send({
          id: msg.id,
          type: "open-models-folder-result",
          supported: true,
          error: err && err.message,
        });
      }
    }
  });

  // Aguarda o servidor estar pronto
  const ready = await waitForServer(`${serverUrl}api/tree`, 20000);
  if (!ready) {
    console.error("[DESKTOP] O servidor interno demorou a responder.");
  }

  // Gerenciamento inteligente de economia de energia:
  // Previne que a tela apague APENAS durante a reprodução ativa de aulas
  function updatePowerSave(isPlaying) {
    if (isPlaying) {
      if (powerSaveId === null || !powerSaveBlocker.isStarted(powerSaveId)) {
        try {
          powerSaveId = powerSaveBlocker.start("prevent-display-sleep");
          console.log("[DESKTOP] Economia de energia: bloqueio de suspensão ativado (reprodução em andamento)");
        } catch {}
      }
    } else {
      if (powerSaveId !== null) {
        try {
          if (powerSaveBlocker.isStarted(powerSaveId)) {
            powerSaveBlocker.stop(powerSaveId);
          }
          console.log("[DESKTOP] Economia de energia: bloqueio de suspensão liberado (reprodução pausada)");
        } catch {}
        powerSaveId = null;
      }
    }
  }

  installDesktopIcon();
  const windowState = loadWindowState(dataDir);
  const iconPath = path.join(__dirname, "assets", "icon.png");
  let windowIcon = undefined;
  if (fs.existsSync(iconPath)) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) windowIcon = img;
    } catch {}
  }

  mainWindow = new BrowserWindow({
    width: windowState.width || 1280,
    height: windowState.height || 800,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 520,
    title: "Local Player",
    icon: windowIcon,
    autoHideMenuBar: true,
    backgroundColor: "#0d1117",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // Áudio continua tocando com a janela minimizada
      spellcheck: false,
    },
  });

  if (windowIcon) {
    try { mainWindow.setIcon(windowIcon); } catch {}
  }

  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Monitora reprodução de mídia para economia de tela/bateria
  mainWindow.webContents.on("media-started-playing", () => {
    updatePowerSave(true);
  });

  // Segurança de navegação: impede que links externos abram dentro do contexto do Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      const { shell } = require("electron");
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) {
        const { shell } = require("electron");
        shell.openExternal(url);
      }
    }
  });

  // Gerenciamento de downloads (notas/resumos .md e .txt do Tutor IA, exportações, etc.)
  // Salva diretamente na pasta Downloads do usuário, evitando a abertura de múltiplos diálogos ou janelas externas
  mainWindow.webContents.session.on("will-download", (event, item) => {
    try {
      const filename = item.getFilename() || "download";
      const downloadsDir = app.getPath("downloads") || path.join(app.getPath("home"), "Downloads");
      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }
      let targetPath = path.join(downloadsDir, filename);
      let counter = 1;
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      while (fs.existsSync(targetPath)) {
        targetPath = path.join(downloadsDir, `${base} (${counter})${ext}`);
        counter++;
      }
      item.setSavePath(targetPath);
    } catch (err) {
      console.error("[DESKTOP] Erro ao definir caminho do download:", err);
    }
  });

  // Princípio do menor privilégio: recusa permissões desnecessárias (câmera, mic, geolocalização)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });

  mainWindow.loadURL(serverUrl);

  // Salva estado ao fechar
  mainWindow.on("close", () => {
    updatePowerSave(false);
    saveWindowState(mainWindow, dataDir);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Encerramento limpo e gracioso
function gracefulShutdown() {
  if (powerSaveId !== null) {
    try {
      if (powerSaveBlocker.isStarted(powerSaveId)) {
        powerSaveBlocker.stop(powerSaveId);
      }
    } catch {}
    powerSaveId = null;
  }
  if (serverProcess) {
    console.log("[DESKTOP] Encerrando servidor interno graciosamente...");
    serverProcess.kill("SIGTERM");
    setTimeout(() => {
      try { serverProcess.kill("SIGKILL"); } catch {}
    }, 4000);
  }
}

app.whenReady().then(startApp);

app.on("before-quit", gracefulShutdown);

app.on("window-all-closed", () => {
  gracefulShutdown();
  app.quit();
});
