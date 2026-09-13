// Verificação e gerenciamento OPCIONAL de atalhos de sistema (Linux)

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const state = require("../state");

async function checkDesktopShortcuts() {
  if (process.platform !== "linux") {
    return { ok: false, error: "Gerenciamento de atalhos suportado apenas no Linux." };
  }
  try {
    const home = os.homedir();
    const appsDir = path.join(home, ".local", "share", "applications");
    const checkFile = async (f) => {
      try {
        const content = await fs.readFile(f, "utf-8");
        return content.includes("Local Player") || content.includes("local-player") || content.includes("localplayer");
      } catch {
        return false;
      }
    };
    const inMenu = (await checkFile(path.join(appsDir, "local-player.desktop"))) ||
                   (await checkFile(path.join(appsDir, "localplayer.desktop")));
    let onDesktop = false;
    for (const d of [path.join(home, "Desktop"), path.join(home, "Área de trabalho")]) {
      const deskFile = path.join(d, "Local Player.desktop");
      if (await checkFile(deskFile)) {
        onDesktop = true;
        break;
      }
    }
    return { ok: true, platform: "linux", installed: inMenu || onDesktop, inMenu, onDesktop };
  } catch {
    return { ok: true, platform: "linux", installed: false };
  }
}

async function createDesktopShortcuts() {
  if (process.platform !== "linux") {
    return { ok: false, error: "A criação de atalhos está disponível apenas para Linux." };
  }
  const appDir = state.APP_DIR;
  const home = os.homedir();
  const appsDir = path.join(home, ".local", "share", "applications");
  const hicolorDir = path.join(home, ".local", "share", "icons", "hicolor");
  await fs.mkdir(appsDir, { recursive: true }).catch(() => {});

  // Copia os ícones para o tema do sistema
  const iconCandidates = [
    path.join(appDir, "assets", "local-player.png"),
    path.join(appDir, "assets", "icon.png"),
    path.join(appDir, "build", "icons", "512x512.png"),
  ];
  let srcIcon = null;
  for (const c of iconCandidates) {
    if (await fs.stat(c).catch(() => null)) {
      srcIcon = c;
      break;
    }
  }

  if (srcIcon) {
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
      const dir = path.join(hicolorDir, `${size}x${size}`, "apps");
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
      await fs.copyFile(srcIcon, path.join(dir, "local-player.png")).catch(() => {});
      await fs.copyFile(srcIcon, path.join(dir, "localplayer.png")).catch(() => {});
    }
  }

  const scalableDir = path.join(hicolorDir, "scalable", "apps");
  await fs.mkdir(scalableDir, { recursive: true }).catch(() => {});
  const svgCandidates = [
    path.join(appDir, "assets", "icon.svg"),
    path.join(appDir, "assets", "local-player.svg"),
  ];
  for (const svg of svgCandidates) {
    if (await fs.stat(svg).catch(() => null)) {
      await fs.copyFile(svg, path.join(scalableDir, "local-player.svg")).catch(() => {});
      await fs.copyFile(svg, path.join(scalableDir, "localplayer.svg")).catch(() => {});
      break;
    }
  }

  // Resolve o comando correto de execução
  let execTarget = "";
  if (process.env.APPIMAGE) {
    execTarget = `"${process.env.APPIMAGE}" %U`;
  } else if (typeof process.send === "function" && process.execPath) {
    execTarget = `"${process.execPath}" "${path.join(appDir, "electron-main.js")}" %U`;
  } else {
    execTarget = `"${path.join(appDir, "local-player.sh")}"`;
  }

  const desktopContent = [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=Local Player",
    "GenericName=Player de Cursos e Mídia",
    "Comment=Player local/offline de cursos e mídia com suporte a legendas IA",
    `Exec=${execTarget}`,
    "Icon=local-player",
    "Terminal=false",
    "StartupNotify=true",
    "StartupWMClass=local-player",
    "Categories=AudioVideo;Player;Video;Education;",
    "Keywords=video;player;curso;aula;offline;local;",
    "MimeType=x-scheme-handler/localplayer;",
    "",
  ].join("\n");

  const appFile = path.join(appsDir, "local-player.desktop");
  // Remove arquivo legado/alternativo para garantir que não haja atalhos duplicados no menu
  await fs.unlink(path.join(appsDir, "localplayer.desktop")).catch(() => {});
  await fs.writeFile(appFile, desktopContent, { mode: 0o755 });

  let onDesktop = false;
  for (const d of [path.join(home, "Desktop"), path.join(home, "Área de trabalho")]) {
    const exists = await fs.stat(d).then((s) => s.isDirectory()).catch(() => false);
    if (exists) {
      const deskFile = path.join(d, "Local Player.desktop");
      await fs.writeFile(deskFile, desktopContent, { mode: 0o755 });
      // No GNOME/Fedora/Ubuntu, marca como confiável via gio para ativar execução imediata
      spawn("gio", ["set", deskFile, "metadata::trusted", "yes"], { stdio: "ignore" }).on("error", () => {});
      onDesktop = true;
    }
  }

  spawn("gtk-update-icon-cache", ["-f", "-t", hicolorDir], { stdio: "ignore" }).on("error", () => {});
  spawn("update-desktop-database", [appsDir], { stdio: "ignore" }).on("error", () => {});

  return {
    ok: true,
    message: onDesktop
      ? "Atalho criado com sucesso na Área de Trabalho e no Menu!"
      : "Atalho criado com sucesso no Menu de Aplicativos!",
  };
}

async function removeDesktopShortcuts() {
  if (process.platform !== "linux") {
    return { ok: false, error: "A remoção de atalhos está disponível apenas para Linux." };
  }
  const home = os.homedir();
  const appsDir = path.join(home, ".local", "share", "applications");
  const hicolorDir = path.join(home, ".local", "share", "icons", "hicolor");

  await fs.unlink(path.join(appsDir, "localplayer.desktop")).catch(() => {});
  await fs.unlink(path.join(appsDir, "local-player.desktop")).catch(() => {});

  for (const d of [path.join(home, "Desktop"), path.join(home, "Área de trabalho")]) {
    await fs.unlink(path.join(d, "Local Player.desktop")).catch(() => {});
  }

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    await fs.unlink(path.join(hicolorDir, `${size}x${size}`, "apps", "localplayer.png")).catch(() => {});
    await fs.unlink(path.join(hicolorDir, `${size}x${size}`, "apps", "local-player.png")).catch(() => {});
  }
  await fs.unlink(path.join(hicolorDir, "scalable", "apps", "localplayer.svg")).catch(() => {});
  await fs.unlink(path.join(hicolorDir, "scalable", "apps", "local-player.svg")).catch(() => {});

  spawn("gtk-update-icon-cache", ["-f", "-t", hicolorDir], { stdio: "ignore" }).on("error", () => {});
  spawn("update-desktop-database", [appsDir], { stdio: "ignore" }).on("error", () => {});

  return { ok: true, message: "Atalhos removidos com sucesso." };
}

module.exports = {
  checkDesktopShortcuts,
  createDesktopShortcuts,
  removeDesktopShortcuts,
};
