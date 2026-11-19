// Gera docs/media/{demo.mp4,demo.webp,poster.png} a partir de uma gravação REAL
// do app em sandbox. Uso: cd video-presentation && npm install && npm run video
// Chromium: CHROME_PATH=/caminho/chrome (padrão: cache do Playwright).
import { chromium } from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const media = join(repo, 'docs', 'media');
const sb = join(tmpdir(), 'lp-video-sandbox');
const PORT = 4174;
const URL = `http://127.0.0.1:${PORT}/`;
const ff = (...a) => execFileSync(ffmpegPath, ['-nostdin', '-loglevel', 'error', '-y', ...a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) biblioteca de exemplo gerada (testsrc2 + sine), nada da biblioteca real
rmSync(sb, { recursive: true, force: true });
const lib = join(sb, 'lib');
const lessons = [
  'Programação (TP)/Python Básico/01 - Introdução/01 Boas-vindas.mp4',
  'Programação (TP)/Python Básico/01 - Introdução/02 Instalação.mp4',
  'Programação (TP)/Python Básico/02 - Estruturas/01 Listas.mp4',
  'Programação (TP)/Python Básico/02 - Estruturas/02 Dicionários.mp4',
  'Design/UX Essencial/01 Heurísticas.mp4',
];
for (const rel of lessons) {
  const f = join(lib, rel); mkdirSync(dirname(f), { recursive: true });
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=60', '-f', 'lavfi', '-i', 'sine=f=330:d=60',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f);
}
writeFileSync(join(lib, 'Programação (TP)/Python Básico/01 - Introdução/slides.pdf'), '%PDF-1.4\n');

// 2) servidor em sandbox
const server = spawn(process.execPath, ['server.js'], {
  cwd: repo, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), LP_DATA_DIR: join(sb, 'data'), LP_ROOT_DIR: lib,
    LP_NO_BROWSER: '1', BACKGROUND_SUBTITLE_GENERATION: '0' },
});
for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await sleep(200); }

// Camada de legenda/título: injetada na página, com tokens e easing do DESIGN.md.
const OVERLAY_CSS = `
#lpv{position:fixed;inset:0;pointer-events:none;z-index:99999;font-family:system-ui,sans-serif}
#lpv .cap{position:absolute;left:50%;bottom:28px;transform:translate(-50%,8px);opacity:0;
 background:rgba(10,12,18,.88);color:#f1f5fb;border:1px solid rgba(255,138,61,.35);
 padding:10px 18px;border-radius:999px;font-size:17px;font-weight:600;white-space:nowrap;
 transition:opacity .15s ease,transform .15s ease}
#lpv .cap.on{opacity:1;transform:translate(-50%,0)}
#lpv kbd{background:#ff8a3d;color:#1a0d03;border-radius:6px;padding:1px 7px;margin:0 3px;font:700 14px ui-monospace,monospace}
#lpv .card{position:absolute;inset:0;background:#0a0c12;display:flex;flex-direction:column;
 align-items:center;justify-content:center;gap:14px;color:#f1f5fb;opacity:0;transition:opacity .15s ease}
#lpv .card.on{opacity:1}#lpv .card h1{margin:0;font-size:44px}#lpv .card p{margin:0;color:#9aa8bf;font-size:19px}`;
const ICON = 'data:image/svg+xml;base64,' + (await import('node:fs')).readFileSync(join(repo, 'public/favicon.svg')).toString('base64');

async function overlay(p) {
  await p.evaluate(([css]) => {
    if (document.getElementById('lpv')) return;
    const s = document.createElement('style'); s.textContent = css; document.head.append(s);
    const d = document.createElement('div'); d.id = 'lpv'; d.innerHTML = '<div class="card"></div><div class="cap"></div>';
    document.body.append(d);
  }, [OVERLAY_CSS]);
}
const caption = async (p, html, ms = 2600) => {
  await overlay(p);
  await p.evaluate((h) => { const c = document.querySelector('#lpv .cap'); c.innerHTML = h; c.classList.add('on'); }, html);
  await sleep(ms);
  await p.evaluate(() => document.querySelector('#lpv .cap').classList.remove('on'));
  await sleep(200);
};
const card = async (p, html, ms) => {
  await overlay(p);
  await p.evaluate((h) => { const c = document.querySelector('#lpv .card'); c.innerHTML = h; c.classList.add('on'); }, html);
  await sleep(ms);
  await p.evaluate(() => document.querySelector('#lpv .card').classList.remove('on'));
  await sleep(200);
};
const clickText = (p, t) => p.getByText(t, { exact: false }).first().click();

const exe = process.env.CHROME_PATH ||
  join(homedir(), '.cache/ms-playwright', readdirSync(join(homedir(), '.cache/ms-playwright')).find((d) => /^chromium-\d+$/.test(d)), 'chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe });
const clips = join(sb, 'clips'); mkdirSync(clips, { recursive: true });

// 3) desktop: 960x540 @2x = 1920x1080
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2,
    recordVideo: { dir: clips, size: { width: 960, height: 540 } } });
  const p = await ctx.newPage();
  await p.goto(URL); await sleep(600);
  await card(p, `<img src="${ICON}" width="96" height="96" alt=""><h1>Local Player</h1><p>Seus cursos em vídeo, offline, no Linux</p>`, 2800);
  await caption(p, 'Boot instantâneo · biblioteca local, zero telemetria', 2800);
  await clickText(p, 'Programação'); await sleep(900);
  await clickText(p, 'Python Básico'); await sleep(1200);
  await p.keyboard.press(' '); await caption(p, 'Progresso salvo de forma atômica · auto-resume', 3000);
  await p.keyboard.press('n'); await sleep(1500);
  await p.keyboard.press('p'); await caption(p, 'Voltou? Continua de onde parou', 2600);
  await p.keyboard.press(' ').catch(() => {});
  await p.hover('.pc-vol-btn').catch(() => {}); await caption(p, 'Audio boost até 300% + normalizador', 2600);
  await p.mouse.move(480, 200);
  await p.keyboard.press('.'); await p.keyboard.press('.');
  await caption(p, 'Velocidade <kbd>,</kbd><kbd>.</kbd>', 2200);
  await p.keyboard.press('t'); await caption(p, 'Modo teatro <kbd>T</kbd>', 2600);
  await p.keyboard.press('t'); await sleep(400);
  await ctx.close();
}
// 4) mobile: drawer de aulas
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, recordVideo: { dir: clips, size: { width: 390, height: 693 } } });
  const p = await ctx.newPage();
  await p.goto(URL); await sleep(600);
  await clickText(p, 'Programação'); await sleep(700);
  await clickText(p, 'Python Básico'); await sleep(1000);
  await p.click('.lesson-sidebar-toggle').catch(() => {}); await caption(p, 'Responsivo · drawer de aulas', 3200);
  await p.keyboard.press('Escape'); await sleep(600);
  await ctx.close();
}
// 5) end card
{
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2,
    recordVideo: { dir: clips, size: { width: 960, height: 540 } } });
  const p = await ctx.newPage(); await p.goto(URL); await sleep(300);
  await card(p, `<img src="${ICON}" width="80" height="80" alt=""><h1>Baixe o AppImage</h1><p>github.com/IPauloGermano/local-player</p>`, 3500);
  await ctx.close();
}
await browser.close(); server.kill();

// 6) composição: ordena por mtime, mobile centralizado em 1920x1080, corta o 1º frame branco
const webms = readdirSync(clips).filter((f) => f.endsWith('.webm'))
  .map((f) => join(clips, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
const norm = 'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0a0c12,fps=30,setsar=1';
const inputs = webms.flatMap((f) => ['-ss', '0.4', '-i', f]);
const fc = webms.map((_, i) => `[${i}:v]${norm}[v${i}]`).join(';') + ';' +
  webms.map((_, i) => `[v${i}]`).join('') + `concat=n=${webms.length}:v=1:a=0[out]`;
mkdirSync(media, { recursive: true });
const mp4 = join(media, 'demo.mp4');
ff(...inputs, '-filter_complex', fc, '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'slow',
  '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4);
ff('-ss', '1.5', '-i', mp4, '-frames:v', '1', join(media, 'poster.png'));
ff('-i', mp4, '-vf', 'fps=10,scale=800:-2', '-c:v', 'libwebp_anim', '-quality', '55', '-loop', '0', join(media, 'demo.webp'));
for (const f of ['demo.mp4', 'demo.webp', 'poster.png']) console.log(f, (statSync(join(media, f)).size / 1e6).toFixed(2), 'MB');
if (!existsSync(mp4)) process.exit(1);
