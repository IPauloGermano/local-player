// Validação RUNTIME (§14): sidebar vs "Materiais da aula" sobre um scan REAL.
//
// Sobe o servidor real num diretório temporário (LP_DATA_DIR), cria uma
// biblioteca externa sandbox com a estrutura do §14, escaneia via API e valida
// as regras sobre a árvore REAL devolvida:
//   - a lista de navegação (flattenVideos) tem SÓ vídeos;
//   - "próxima aula" de Aula 01 é Aula 02 (nunca o pdf);
//   - os materiais (type "file") continuam na árvore p/ "Materiais da aula";
//   - isSidebarNavigableNode rejeita todo material do sandbox.
// Rodar: node --test test/sidebar-runtime-smoke.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { isSidebarNavigableNode, flattenVideos } = require("../public/scope.js");

const SERVER = path.resolve(__dirname, "..", "server.js");

function httpGet(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: route }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON inválido de ${route}: ${body.slice(0, 120)}`));
        }
      });
    });
    req.on("error", reject);
  });
}

function httpPost(port, route, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(new Error(`JSON inválido de POST ${route}: ${out.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("runtime: sidebar só vídeos/módulos; materiais só em 'Materiais da aula'", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lp-sidebar-"));
  const root = path.join(tmp, "lib");
  const curso = path.join(root, "Curso");
  const mod1 = path.join(curso, "Módulo 1");
  const mod2 = path.join(curso, "Módulo 2");
  fs.mkdirSync(mod1, { recursive: true });
  fs.mkdirSync(mod2, { recursive: true });
  // §14: Módulo 1/{Aula 01.mp4, Aula 01.pdf, Exercícios.zip, figura.png}
  //       Módulo 2/{Aula 02.mp4, Material.docx}
  // (figura.png, e não "imagem.png": "image" é hint de CAPA — uma imagem de
  // capa é excluída dos materiais pelo scan, regra preservada — §12.)
  for (const f of ["Aula 01.mp4", "Aula 01.pdf", "Exercícios.zip", "figura.png"]) {
    fs.writeFileSync(path.join(mod1, f), "");
  }
  for (const f of ["Aula 02.mp4", "Material.docx"]) {
    fs.writeFileSync(path.join(mod2, f), "");
  }

  const port = 48771 + Math.floor(Math.random() * 1000);
  const dataDir = path.join(tmp, "data");
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LP_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", () => {});

  try {
    // Espera o servidor subir.
    let tree;
    for (let i = 0; i < 50; i++) {
      try {
        tree = await httpGet(port, "/api/tree?rescan=1");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(tree && Array.isArray(tree.libraries), "servidor não subiu");
    if (tree.libraries.length !== 1) throw new Error("esperava 1 biblioteca (padrão)");

    // Registra a biblioteca externa do sandbox.
    const created = await httpPost(port, "/api/libraries", { name: "Sandbox", path: root });
    assert.ok(created && created.id, `criação da lib falhou: ${JSON.stringify(created)}`);

    // Scan da externa.
    const after = await httpGet(port, "/api/tree?rescan=1");
    const lib = after.libraries.find((l) => l.name === "Sandbox");
    assert.ok(lib, "biblioteca externa não apareceu no tree");
    const tree2 = lib.tree;

    // Anota libId (como o frontend faz) para os helpers. A raiz de `lib.tree`
    // é `{children, videoCount}` SEM `type`; o frontend chama flattenVideos
    // sempre com o nó de curso (que tem `type`), então descemos ao curso.
    const annotate = (n) => {
      n.libId = lib.id;
      for (const c of n.children || []) annotate(c);
    };
    annotate(tree2);
    const course = tree2.children.find((c) => c.type === "folder" && c.name === "Curso");
    assert.ok(course, "curso 'Curso' não encontrado no tree");

    // Aula 01 e Aula 02 existem como vídeo (lista de navegação = flattenVideos
    // do curso, o mesmo que alimenta state.flatVideos no frontend).
    const videos = flattenVideos(course);
    const vPaths = videos.map((v) => v.path);
    assert.deepStrictEqual(vPaths, [
      "Curso/Módulo 1/Aula 01.mp4",
      "Curso/Módulo 2/Aula 02.mp4",
    ], "lista de navegação (flattenVideos) deve ter só os 2 vídeos, sem pdf/zip/png/docx");

    // Próxima aula de Aula 01 = Aula 02 (nunca o pdf).
    const idx = videos.findIndex((v) => v.path.endsWith("Aula 01.mp4"));
    assert.strictEqual(videos[idx + 1].path, "Curso/Módulo 2/Aula 02.mp4");
    // Anterior de Aula 02 = Aula 01.
    assert.strictEqual(videos[idx].path, "Curso/Módulo 1/Aula 01.mp4");

    // Nenhum material do sandbox é navegável na sidebar.
    const allNodes = [];
    (function walk(n) {
      allNodes.push(n);
      for (const c of n.children || []) walk(c);
    })(course);
    for (const n of allNodes) {
      if (n.type === "file") {
        assert.strictEqual(isSidebarNavigableNode(n), false, `material navegável: ${n.path}`);
      } else if (n.type === "video" || n.type === "folder") {
        assert.strictEqual(isSidebarNavigableNode(n), true, `nó de nav rejeitado: ${n.path}`);
      }
    }

    // "Materiais da aula" da Aula 01: a mesma regra do frontend
    // (parentFolder.children.filter(type==="file")). Aula 01 está em Módulo 1.
    const module = course.children.find((c) => c.type === "folder" && c.name === "Módulo 1");
    const materials = module.children.filter((c) => c.type === "file").map((c) => c.path);
    // O `figura.png` NÃO entra nos materiais: uma imagem em pasta de aula é
    // promovida a CAPA do módulo pelo scan (regra pré-existente de capas,
    // §12) e capas são excluídas dos materiais. A capa continua funcionando.
    assert.deepStrictEqual(materials, [
      "Curso/Módulo 1/Aula 01.pdf",
      "Curso/Módulo 1/Exercícios.zip",
    ], "Materiais da aula da Aula 01 (figura.png vira capa, não material)");
    assert.ok(
      module.coverImage && module.coverImage.endsWith("figura.png"),
      `capa do módulo preservada (§12): ${module.coverImage}`,
    );

    // Materiais do Módulo 2 (docx) não vazam para a sidebar de Aula 01.
    const mod2Node = course.children.find((c) => c.type === "folder" && c.name === "Módulo 2");
    assert.strictEqual(mod2Node.children.some((c) => c.type === "file" && c.path.endsWith("Material.docx")), true);
  } finally {
    proc.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
