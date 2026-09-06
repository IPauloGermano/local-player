// Web Search, Leitura Segura de Páginas e Navegação Web (Text-Only) com proteção Anti-SSRF
const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns").promises;
const { URL } = require("url");

// 1. Validador de Segurança Anti-SSRF (IPs privados, loopback, metadata APIs, CGNAT e IPv6)
function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== "string") return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true;
  if (parts[0] === 0) return true; // 0.0.0.0/8 (RFC 1122)
  if (parts[0] === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (parts[0] === 127) return true; // 127.0.0.0/8 (Loopback)
  if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 (Link-local / Cloud Metadata)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // 100.64.0.0/10 (CGNAT / RFC 6598)
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true; // TEST-NET-1 (RFC 5737)
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true; // TEST-NET-2 (RFC 5737)
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true; // TEST-NET-3 (RFC 5737)
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true; // 198.18.0.0/15 (Benchmark)
  if (parts[0] >= 224) return true; // 224.0.0.0/4 (Multicast / Reserved / Broadcast)
  return false;
}

function expandIPv6(ip) {
  if (!ip || typeof ip !== "string") return null;
  let str = ip.trim().toLowerCase();
  const v4Match = str.match(/(.*):(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4Parts = v4Match[2].split(".").map(Number);
    if (v4Parts.length !== 4 || v4Parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
    const w6 = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const w7 = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    str = (v4Match[1] ? v4Match[1] : "::") + ":" + w6 + ":" + w7;
  }
  let parts;
  if (str.includes("::")) {
    const halves = str.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const middle = new Array(missing).fill("0");
    parts = [...left, ...middle, ...right];
  } else {
    parts = str.split(":");
  }
  if (parts.length !== 8) return null;
  const words = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    words.push(parseInt(p, 16));
  }
  return words;
}

function isPrivateIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  const trimmed = ip.trim().replace(/^\[|\]$/g, "");
  if (net.isIPv4(trimmed)) {
    return isPrivateIpv4(trimmed);
  }
  const words = expandIPv6(trimmed);
  if (!words) return true;

  if (words.every((w, i) => (i === 7 ? w === 1 : w === 0))) return true; // ::1
  if (words.every((w) => w === 0)) return true; // ::

  const isV4Mapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;
  const isV4Compat =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0;
  if (isV4Mapped || isV4Compat) {
    const v4 = [
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ].join(".");
    return isPrivateIpv4(v4);
  }

  if (words[0] === 0x2002) {
    const v4 = [
      words[1] >> 8,
      words[1] & 0xff,
      words[2] >> 8,
      words[2] & 0xff,
    ].join(".");
    return isPrivateIpv4(v4);
  }

  if ((words[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((words[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
  if ((words[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // Doc 2001:db8::/32

  return false;
}

const ALLOWED_WEB_PORTS = new Set([80, 443, 8080, 8443]);

async function validateSafeUrl(rawUrl, opts = {}) {
  try {
    if (!rawUrl || typeof rawUrl !== "string") {
      return { ok: false, error: "URL inválida ou vazia." };
    }
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `Protocolo "${parsed.protocol}" não permitido (apenas http/https).` };
    }
    const hostname = parsed.hostname.toLowerCase();
    const cleanHost = hostname.replace(/^\[|\]$/g, "");
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".onion")
    ) {
      return { ok: false, error: `Acesso ao host "${hostname}" bloqueado por segurança (SSRF).` };
    }

    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return { ok: false, error: `Porta inválida "${parsed.port}".` };
    }
    if (!opts.allowAnyPort && !ALLOWED_WEB_PORTS.has(port)) {
      return { ok: false, error: `Porta "${port}" não permitida por segurança (SSRF).` };
    }

    let validatedIp = null;
    let family = 4;

    if (net.isIP(cleanHost)) {
      if (isPrivateIp(cleanHost)) {
        return { ok: false, error: `Acesso a IP privado "${cleanHost}" bloqueado por segurança (SSRF).` };
      }
      validatedIp = cleanHost;
      family = net.isIP(cleanHost);
    } else {
      let resolvedIps = [];
      try {
        const [a4, a6] = await Promise.all([
          dns.resolve4(hostname).catch(() => []),
          dns.resolve6(hostname).catch(() => []),
        ]);
        resolvedIps = [...a4, ...a6];
      } catch {}

      if (!resolvedIps.length) {
        try {
          const l = await dns.lookup(hostname, { all: true });
          resolvedIps = (l || []).map((x) => x.address);
        } catch (lookupErr) {
          return { ok: false, error: `Não foi possível resolver o domínio "${hostname}": ${lookupErr.message}` };
        }
      }

      if (!resolvedIps.length) {
        return { ok: false, error: `Não foi possível resolver o domínio "${hostname}".` };
      }

      for (const addr of resolvedIps) {
        if (isPrivateIp(addr)) {
          return { ok: false, error: `Host "${hostname}" resolve para IP privado "${addr}" (bloqueado por SSRF).` };
        }
      }

      validatedIp = resolvedIps[0];
      family = net.isIP(validatedIp) || 4;
    }

    return {
      ok: true,
      url: parsed.href,
      parsed,
      hostname,
      port,
      validatedIp,
      family,
    };
  } catch (err) {
    return { ok: false, error: `URL inválida: ${err.message}` };
  }
}

// 2. Leitor Seguro de Páginas Web (com limite de tamanho, timeout, redirects validados e socket pinado)
async function fetchSafeWebPage(rawUrl, maxBytes = 1.5 * 1024 * 1024, timeoutMs = 8000, maxRedirects = 3) {
  let currentUrl = rawUrl;
  let redirects = 0;

  while (redirects <= maxRedirects) {
    const valid = await validateSafeUrl(currentUrl);
    if (!valid.ok) return { ok: false, error: valid.error };

    const parsed = new URL(valid.url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (val) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      const req = mod.request(
        parsed,
        {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            Host: parsed.host,
          },
          lookup: (hostname, opts, cb) => {
            if (opts && opts.all) {
              cb(null, [{ address: valid.validatedIp, family: valid.family }]);
            } else {
              cb(null, valid.validatedIp, valid.family);
            }
          },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400) {
            const location = res.headers.location;
            res.resume();
            if (!location) {
              return finish({ ok: false, error: "Redirecionamento sem cabeçalho Location." });
            }
            try {
              const resolved = new URL(location, valid.url).href;
              return finish({ redirect: true, nextUrl: resolved });
            } catch (err) {
              return finish({ ok: false, error: `Redirecionamento inválido: ${err.message}` });
            }
          }

          if (status < 200 || status >= 300) {
            res.resume();
            return finish({ ok: false, error: `HTTP ${status} ao acessar a página.` });
          }

          const contentType = res.headers["content-type"] || "";
          if (
            contentType &&
            !contentType.includes("text") &&
            !contentType.includes("html") &&
            !contentType.includes("xml") &&
            !contentType.includes("json")
          ) {
            res.resume();
            return finish({ ok: false, error: `Tipo de conteúdo não suportado (${contentType}).` });
          }

          const chunks = [];
          let totalBytes = 0;
          let truncated = false;

          res.on("data", (chunk) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              truncated = true;
              const allowed = chunk.length - (totalBytes - maxBytes);
              if (allowed > 0) chunks.push(chunk.subarray(0, allowed));
              res.destroy();
              const buf = Buffer.concat(chunks);
              finish({ ok: true, html: buf.toString("utf8"), url: valid.url, truncated: true });
            } else {
              chunks.push(chunk);
            }
          });

          res.on("end", () => {
            if (settled) return;
            const buf = Buffer.concat(chunks);
            finish({ ok: true, html: buf.toString("utf8"), url: valid.url, truncated });
          });

          res.on("error", (err) => {
            finish({ ok: false, error: (err && err.message) || "Erro ao ler resposta." });
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        finish({ ok: false, error: "Tempo limite de conexão esgotado." });
      });

      req.on("error", (err) => {
        finish({ ok: false, error: (err && err.message) || "Erro ao baixar página." });
      });

      req.end();
    });

    if (result.redirect) {
      currentUrl = result.nextUrl;
      redirects++;
      continue;
    }

    return result;
  }

  return { ok: false, error: "Excedido o limite de redirecionamentos." };
}

// 3. Conversor de HTML para Markdown Estruturado (Reader Mode)
function htmlToCleanMarkdown(html, baseUrl = "") {
  if (typeof html !== "string" || !html.trim()) return "";

  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");

  // Headings
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n#### $1\n\n");

  // Code blocks & pre
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n\n```\n$1\n```\n\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Links
  text = text.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const cleanContent = content.replace(/<[^>]+>/g, "").trim();
    if (!cleanContent) return "";
    let fullUrl = href;
    try {
      if (baseUrl && !href.startsWith("http://") && !href.startsWith("https://")) {
        fullUrl = new URL(href, baseUrl).href;
      }
    } catch {}
    return `[${cleanContent}](${fullUrl})`;
  });

  // Lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n* $1");
  text = text.replace(/<\/(?:ul|ol)>/gi, "\n\n");

  // Paragraphs and breaks
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Unescape entities
  text = text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 4. Árvore de Acessibilidade Textual para Modelos Text-Only
function htmlToAccessibilityTree(html, url = "") {
  const cleanMd = htmlToCleanMarkdown(html, url);
  const elements = [];
  let elId = 1;

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(cleanMd)) !== null && elements.length < 30) {
    elements.push({ id: elId++, type: "link", text: match[1], target: match[2] });
  }

  const lines = cleanMd.split("\n").slice(0, 100);
  const truncatedText = lines.join("\n").slice(0, 8000);

  return {
    url,
    content: truncatedText,
    interactiveElements: elements,
  };
}

// 5. Motor de Pesquisa na Web (DuckDuckGo / SearXNG / Custom em Puro Node.js)
function parseDuckDuckGoHtml(html) {
  if (typeof html !== "string") return [];
  const results = [];
  const resultBlockRegex = /<div[^>]*class=["'][^"']*result\s+results_links[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match;

  while ((match = resultBlockRegex.exec(html)) !== null && results.length < 5) {
    const block = match[1];
    const titleMatch = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
                       /<a[^>]*class=["'][^"']*result__url[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const linkMatch = /<a[^>]*class=["'][^"']*result__url[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(block) ||
                      /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result__url/i.exec(block);
    const snippetMatch = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block) ||
                         /<div[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block);

    const rawUrl = linkMatch ? linkMatch[1] : "";
    let cleanUrl = rawUrl;
    if (rawUrl.includes("uddg=")) {
      try {
        const u = new URL(rawUrl, "https://duckduckgo.com");
        cleanUrl = decodeURIComponent(u.searchParams.get("uddg") || rawUrl);
      } catch {}
    }

    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    if (cleanUrl && (title || snippet)) {
      results.push({
        title: title || cleanUrl,
        url: cleanUrl,
        snippet: snippet.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'),
      });
    }
  }

  if (results.length === 0) {
    const genericLinkRegex = /<a[^>]*class=["'][^"']*result__url[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = genericLinkRegex.exec(html)) !== null && results.length < 5) {
      let cleanUrl = lm[1];
      if (cleanUrl.includes("uddg=")) {
        try {
          const u = new URL(cleanUrl, "https://duckduckgo.com");
          cleanUrl = decodeURIComponent(u.searchParams.get("uddg") || cleanUrl);
        } catch {}
      }
      results.push({
        title: lm[2].replace(/<[^>]+>/g, "").trim() || cleanUrl,
        url: cleanUrl,
        snippet: "",
      });
    }
  }

  return results;
}

async function performWebSearch(query, maxResults = 3, customEndpoint = "") {
  if (!query || typeof query !== "string" || !query.trim()) return [];
  const cleanQuery = query.trim().slice(0, 200);

  try {
    const searchUrl = customEndpoint && customEndpoint.trim()
      ? customEndpoint.replace("{query}", encodeURIComponent(cleanQuery))
      : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;

    const pageRes = await fetchSafeWebPage(searchUrl, 1024 * 1024, 7000);
    if (!pageRes.ok || !pageRes.html) {
      return [];
    }

    const rawResults = parseDuckDuckGoHtml(pageRes.html);
    const validResults = [];
    for (const r of rawResults) {
      if (validResults.length >= maxResults) break;
      const v = await validateSafeUrl(r.url);
      if (v.ok) {
        validResults.push({
          title: r.title,
          url: v.url,
          snippet: r.snippet,
        });
      }
    }
    return validResults;
  } catch (err) {
    return [];
  }
}

// 6. Recuperação e Síntese de Páginas da Web para Injeção no Contexto do Tutor
async function fetchAndSummarizeWebSources(query, maxPages = 2, maxResults = 3, onStatus = null) {
  if (typeof onStatus === "function") {
    onStatus({ status: "searching", query });
  }

  const searchResults = await performWebSearch(query, maxResults);
  if (!searchResults || searchResults.length === 0) {
    return { query, sources: [], content: "" };
  }

  const sources = [];
  const contentBlocks = [];

  for (let i = 0; i < Math.min(searchResults.length, maxPages); i++) {
    const item = searchResults[i];
    if (typeof onStatus === "function") {
      onStatus({ status: "reading", url: item.url, title: item.title });
    }

    const pageRes = await fetchSafeWebPage(item.url, 1024 * 1024, 6000);
    if (pageRes.ok && pageRes.html) {
      const cleanMd = htmlToCleanMarkdown(pageRes.html, item.url);
      if (cleanMd && cleanMd.length > 50) {
        const truncated = cleanMd.slice(0, 10000);
        contentBlocks.push(
          `### FONTE [${i + 1}]: ${item.title}\nURL: ${item.url}\n\n${truncated}`
        );
        sources.push({ title: item.title, url: item.url });
      }
    } else if (item.snippet) {
      contentBlocks.push(
        `### FONTE [${i + 1}]: ${item.title}\nURL: ${item.url}\nResumo / Snippet:\n${item.snippet}`
      );
      sources.push({ title: item.title, url: item.url });
    }
  }

  return {
    query,
    sources,
    content: contentBlocks.join("\n\n---\n\n"),
  };
}

// 7. Detecção de Intenção de Pesquisa Web na Mensagem do Aluno
function detectWebSearchIntent(userMsg) {
  if (!userMsg || typeof userMsg !== "string") return { needsSearch: false, query: "" };
  const text = userMsg.trim();
  const lower = text.toLowerCase();

  const urlMatch = /(https?:\/\/[^\s]+)/i.exec(text);
  if (urlMatch) {
    return { needsSearch: true, isUrl: true, targetUrl: urlMatch[1], query: text };
  }

  const explicitSearchPatterns = [
    /^(?:pesquise|pesquisa|busque|busca|procure|procura|consulte|consulta|verifique|navegue|acesse)\s+(?:na\s+web|na\s+internet|no\s+google|sobre|o\s+que\s+é|como)\s+(.+)/i,
    /(?:pesquisar|buscar|procurar|consultar)\s+(?:na\s+web|na\s+internet|online)\s+(.+)/i,
    /(?:o\s+que\s+diz\s+a\s+documentação\s+(?:oficial\s+)?(?:do|de|da)\s+)(.+)/i,
    /(?:novidades\s+da\s+versão|última\s+versão\s+do|changelog\s+do)\s+(.+)/i,
  ];

  for (const p of explicitSearchPatterns) {
    const m = p.exec(text);
    if (m && m[1]) {
      return { needsSearch: true, query: m[1].replace(/[?.,!]+$/, "").trim() };
    }
  }

  if (
    lower.includes("pesquise na web") ||
    lower.includes("pesquise na internet") ||
    lower.includes("busque na web") ||
    lower.includes("documentação oficial") ||
    lower.includes("última versão") ||
    lower.includes("novidades da versão")
  ) {
    return { needsSearch: true, query: text };
  }

  return { needsSearch: false, query: "" };
}

module.exports = {
  isPrivateIpv4,
  expandIPv6,
  isPrivateIp,
  ALLOWED_WEB_PORTS,
  validateSafeUrl,
  fetchSafeWebPage,
  htmlToCleanMarkdown,
  htmlToAccessibilityTree,
  parseDuckDuckGoHtml,
  performWebSearch,
  fetchAndSummarizeWebSources,
  detectWebSearchIntent,
};
