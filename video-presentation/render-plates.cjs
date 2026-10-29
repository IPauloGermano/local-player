const fs = require('fs');
const path = require('path');
const sharp = require('/home/armbian/.npm/_npx/702923228c2ce1e6/node_modules/sharp');

const ASSETS_DIR = path.join(__dirname, 'assets');
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Helper to base64 encode an image
function getBase64Image(filename) {
  const filePath = path.join(ASSETS_DIR, filename);
  const data = fs.readFileSync(filePath);
  return `data:image/png;base64,${data.toString('base64')}`;
}

async function renderPlates() {
  console.log('Generating scene plates...');

  const iconBase64 = getBase64Image('icon.png');
  const homeBase64 = getBase64Image('home.png');
  const courseBase64 = getBase64Image('course.png');
  const playerBase64 = getBase64Image('player.png');
  const settingsBase64 = getBase64Image('settings.png');

  // SVG Common Defs
  const defs = `
    <defs>
      <linearGradient id="amber-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffa05c" />
        <stop offset="50%" stop-color="#ff8a3d" />
        <stop offset="100%" stop-color="#e65100" />
      </linearGradient>
      <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ff8a3d" stop-opacity="0.18" />
        <stop offset="60%" stop-color="#ff8a3d" stop-opacity="0.04" />
        <stop offset="100%" stop-color="#0a0b0e" stop-opacity="0" />
      </radialGradient>
      <radialGradient id="right-glow" cx="80%" cy="50%" r="60%">
        <stop offset="0%" stop-color="#ff8a3d" stop-opacity="0.14" />
        <stop offset="60%" stop-color="#ff8a3d" stop-opacity="0.02" />
        <stop offset="100%" stop-color="#0a0b0e" stop-opacity="0" />
      </radialGradient>
      <radialGradient id="left-glow" cx="20%" cy="50%" r="60%">
        <stop offset="0%" stop-color="#ff8a3d" stop-opacity="0.14" />
        <stop offset="60%" stop-color="#ff8a3d" stop-opacity="0.02" />
        <stop offset="100%" stop-color="#0a0b0e" stop-opacity="0" />
      </radialGradient>
      <filter id="soft-blur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="40" />
      </filter>
      <clipPath id="window-clip">
        <rect x="0" y="0" width="1020" height="630" rx="14" ry="14" />
      </clipPath>
      <clipPath id="viewport-clip">
        <rect x="0" y="38" width="1020" height="592" />
      </clipPath>
    </defs>
  `;

  // Window helper template
  function makeWindow(x, y, title, imgBase64) {
    return `
      <g transform="translate(${x}, ${y})">
        <!-- Window shadow & border -->
        <rect x="-1" y="-1" width="1022" height="632" rx="15" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5" />
        <g clip-path="url(#window-clip)">
          <!-- Window background -->
          <rect x="0" y="0" width="1020" height="630" fill="#13151b" />
          <!-- Window Header Bar -->
          <rect x="0" y="0" width="1020" height="38" fill="#111319" />
          <line x1="0" y1="38" x2="1020" y2="38" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
          <!-- Traffic Lights -->
          <circle cx="20" cy="19" r="5.5" fill="#ff5f56" />
          <circle cx="36" cy="19" r="5.5" fill="#ffbd2e" />
          <circle cx="52" cy="19" r="5.5" fill="#27c93f" />
          <!-- Title -->
          <text x="74" y="24" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="500" fill="#64748b">${title}</text>
          <!-- Viewport Image -->
          <g clip-path="url(#viewport-clip)">
            <image href="${imgBase64}" x="0" y="38" width="1020" height="592" preserveAspectRatio="xMidYMin slice" />
          </g>
        </g>
      </g>
    `;
  }

  // ==========================================
  // SCENE 1: Introduction & Brand Reveal
  // ==========================================
  const svgScene1 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="960" cy="460" r="450" fill="url(#center-glow)" />

      <!-- Center Brand Logo -->
      <g transform="translate(880, 240)">
        <rect x="-10" y="-10" width="180" height="180" rx="42" fill="#ff8a3d" opacity="0.15" filter="url(#soft-blur)" />
        <image href="${iconBase64}" x="0" y="0" width="160" height="160" />
      </g>

      <!-- Kicker Pill -->
      <g transform="translate(760, 445)">
        <rect x="0" y="0" width="400" height="36" rx="18" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
        <text x="200" y="23" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="700" letter-spacing="2.5" fill="#ff8a3d" text-anchor="middle">APRESENTANDO O LOCAL PLAYER</text>
      </g>

      <!-- Headline -->
      <text x="960" y="550" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="64" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="-1">
        O player de cursos definitivo.
      </text>
      <text x="960" y="630" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="64" font-weight="800" fill="url(#amber-grad)" text-anchor="middle" letter-spacing="-1">
        100% offline.
      </text>

      <!-- Subtitle -->
      <text x="960" y="715" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="22" font-weight="400" fill="#94a3b8" text-anchor="middle">
        Sua jornada de aprendizado organizada, acelerada e sob seu total controle.
      </text>
    </svg>
  `;

  // ==========================================
  // SCENE 2: Centralized Library
  // ==========================================
  const svgScene2 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="1400" cy="540" r="600" fill="url(#right-glow)" />

      <!-- Left Column: Copy -->
      <g transform="translate(110, 220)">
        <!-- Kicker -->
        <rect x="0" y="0" width="220" height="34" rx="17" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
        <text x="110" y="22" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="700" letter-spacing="2" fill="#ff8a3d" text-anchor="middle">ORGANIZAÇÃO IMPECÁVEL</text>

        <!-- Headline -->
        <text x="0" y="90" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1">
          Todos os seus cursos
        </text>
        <text x="0" y="150" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1">
          em uma <tspan fill="url(#amber-grad)">biblioteca única.</tspan>
        </text>

        <!-- Subtitle -->
        <text x="0" y="215" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="20" font-weight="400" fill="#94a3b8">
          <tspan x="0" dy="0">Escaneamento instantâneo de diretórios locais.</tspan>
          <tspan x="0" dy="32">Capas automáticas, múltiplos diretórios e estatísticas</tspan>
          <tspan x="0" dy="32">unificadas de progresso sem depender de internet.</tspan>
        </text>

        <!-- Feature Pill 1 -->
        <g transform="translate(0, 340)">
          <rect x="0" y="0" width="560" height="68" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="14" y="14" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="34" y="40" font-size="20" text-anchor="middle">📁</text>
          <text x="70" y="34" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="700" fill="#ffffff">Múltiplas Bibliotecas Locais</text>
          <text x="70" y="54" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="400" fill="#94a3b8">Escaneamento instantâneo sem nuvem</text>
        </g>

        <!-- Feature Pill 2 -->
        <g transform="translate(0, 424)">
          <rect x="0" y="0" width="560" height="68" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="14" y="14" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="34" y="40" font-size="20" text-anchor="middle">📊</text>
          <text x="70" y="34" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="700" fill="#ffffff">Progresso Unificado</text>
          <text x="70" y="54" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="400" fill="#94a3b8">Estatísticas detalhadas de tempo e aulas assistidas</text>
        </g>
      </g>

      <!-- Right Column: Mockup Window -->
      ${makeWindow(770, 225, 'Local Player — Minha Biblioteca', homeBase64)}
    </svg>
  `;

  // ==========================================
  // SCENE 3: Continuous Learning & Flow
  // ==========================================
  const svgScene3 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="500" cy="540" r="600" fill="url(#left-glow)" />

      <!-- Left Column: Mockup Window -->
      ${makeWindow(130, 225, 'Local Player — Estrutura Modular do Curso', courseBase64)}

      <!-- Right Column: Copy -->
      <g transform="translate(1220, 220)">
        <!-- Kicker -->
        <rect x="0" y="0" width="200" height="34" rx="17" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
        <text x="100" y="22" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="700" letter-spacing="2" fill="#ff8a3d" text-anchor="middle">CONTINUIDADE TOTAL</text>

        <!-- Headline -->
        <text x="0" y="90" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1">
          Retome no segundo
        </text>
        <text x="0" y="150" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="url(#amber-grad)" letter-spacing="-1">
          exato onde parou.
        </text>

        <!-- Subtitle -->
        <text x="0" y="215" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="20" font-weight="400" fill="#94a3b8">
          <tspan x="0" dy="0">Fileira dedicada de continuidade imediata,</tspan>
          <tspan x="0" dy="32">marcação automática de conclusão e transição</tspan>
          <tspan x="0" dy="32">fluida para a próxima aula sem quebrar o ritmo.</tspan>
        </text>

        <!-- Feature Pill 1 -->
        <g transform="translate(0, 340)">
          <rect x="0" y="0" width="570" height="68" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="14" y="14" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="34" y="40" font-size="20" text-anchor="middle" fill="#ff8a3d">▶</text>
          <text x="70" y="34" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="700" fill="#ffffff">Retomada Instantânea</text>
          <text x="70" y="54" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="400" fill="#94a3b8">Timestamp milimétrico gravado automaticamente</text>
        </g>

        <!-- Feature Pill 2 -->
        <g transform="translate(0, 424)">
          <rect x="0" y="0" width="570" height="68" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="14" y="14" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="34" y="40" font-size="20" text-anchor="middle" fill="#27c93f">✓</text>
          <text x="70" y="34" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="700" fill="#ffffff">Módulos Inteligentes</text>
          <text x="70" y="54" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="400" fill="#94a3b8">Visualização clara do que falta para concluir o módulo</text>
        </g>
      </g>
    </svg>
  `;

  // ==========================================
  // SCENE 4: The Cinema-Grade Player
  // ==========================================
  const svgScene4 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="1400" cy="540" r="600" fill="url(#right-glow)" />

      <!-- Left Column: Copy -->
      <g transform="translate(110, 200)">
        <!-- Kicker -->
        <rect x="0" y="0" width="250" height="34" rx="17" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
        <text x="125" y="22" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="700" letter-spacing="2" fill="#ff8a3d" text-anchor="middle">EXPERIÊNCIA DE REPRODUÇÃO</text>

        <!-- Headline -->
        <text x="0" y="90" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1">
          Construído para foco
        </text>
        <text x="0" y="150" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="url(#amber-grad)" letter-spacing="-1">
          e velocidade.
        </text>

        <!-- Subtitle -->
        <text x="0" y="215" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="20" font-weight="400" fill="#94a3b8">
          <tspan x="0" dy="0">Interface limpa e imersiva. Atalhos precisos de teclado,</tspan>
          <tspan x="0" dy="32">amplificação de áudio para gravações silenciosas</tspan>
          <tspan x="0" dy="32">e controle refinado de velocidade de reprodução.</tspan>
        </text>

        <!-- Feature Pill 1 -->
        <g transform="translate(0, 335)">
          <rect x="0" y="0" width="560" height="64" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="12" y="12" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="32" y="38" font-size="20" text-anchor="middle">🔊</text>
          <text x="68" y="32" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="15" font-weight="700" fill="#ffffff">Audio Boost até 200%</text>
          <text x="68" y="51" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="400" fill="#94a3b8">Equalização limpa para aulas gravadas com som baixo</text>
        </g>

        <!-- Feature Pill 2 -->
        <g transform="translate(0, 411)">
          <rect x="0" y="0" width="560" height="64" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="12" y="12" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="32" y="38" font-size="20" text-anchor="middle">⚡</text>
          <text x="68" y="32" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="15" font-weight="700" fill="#ffffff">Velocidade Contínua (0.25x – 3x)</text>
          <text x="68" y="51" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="400" fill="#94a3b8">Ajuste milimétrico sem distorção de tom de voz</text>
        </g>

        <!-- Feature Pill 3 -->
        <g transform="translate(0, 487)">
          <rect x="0" y="0" width="560" height="64" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="12" y="12" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="32" y="38" font-size="20" text-anchor="middle">⌨</text>
          <text x="68" y="32" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="15" font-weight="700" fill="#ffffff">Atalhos Ágeis</text>
          <text x="68" y="51" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="400" fill="#94a3b8">Pular 5s, 10s, alternar materiais e zoom com fluidez</text>
        </g>
      </g>

      <!-- Right Column: Mockup Window -->
      ${makeWindow(770, 225, 'Local Player — Player Imersivo', playerBase64)}
    </svg>
  `;

  // ==========================================
  // SCENE 5: AI-Assisted Study Companion
  // ==========================================
  const svgScene5 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="1300" cy="540" r="600" fill="url(#right-glow)" />

      <!-- Left Column: Copy -->
      <g transform="translate(110, 240)">
        <!-- Kicker -->
        <rect x="0" y="0" width="230" height="34" rx="17" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
        <text x="115" y="22" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="700" letter-spacing="2" fill="#ff8a3d" text-anchor="middle">INTELIGÊNCIA DE ESTUDO</text>

        <!-- Headline -->
        <text x="0" y="90" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1">
          Entenda. Pratique.
        </text>
        <text x="0" y="150" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="url(#amber-grad)" letter-spacing="-1">
          Memorize.
        </text>

        <!-- Subtitle -->
        <text x="0" y="215" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="20" font-weight="400" fill="#94a3b8">
          <tspan x="0" dy="0">Vá muito além de apenas assistir passivamente.</tspan>
          <tspan x="0" dy="32">Ferramentas cognitivas com inteligência artificial</tspan>
          <tspan x="0" dy="32">trabalham com você para fixar cada conceito essencial.</tspan>
        </text>

        <!-- Active learning badge -->
        <g transform="translate(0, 345)">
          <rect x="0" y="0" width="560" height="74" rx="14" fill="#181b24" stroke="rgba(255,138,61,0.25)" stroke-width="1" />
          <rect x="16" y="15" width="44" height="44" rx="10" fill="rgba(255,138,61,0.15)" stroke="rgba(255,138,61,0.4)" stroke-width="1" />
          <text x="38" y="44" font-size="22" text-anchor="middle">🧠</text>
          <text x="76" y="37" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="17" font-weight="700" fill="#ffffff">Aprendizado Ativo Integrado</text>
          <text x="76" y="58" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="14" font-weight="400" fill="#94a3b8">Do conteúdo assistido ao domínio duradouro</text>
        </g>
      </g>

      <!-- Right Column: 3 Feature Cards -->
      <g transform="translate(850, 200)">
        <!-- Card 1: AI Tutor (Highlighted) -->
        <g transform="translate(0, 0)">
          <rect x="0" y="0" width="940" height="150" rx="16" fill="#181b24" stroke="#ff8a3d" stroke-width="1.5" stroke-opacity="0.6" />
          <rect x="24" y="24" width="56" height="56" rx="12" fill="rgba(255,138,61,0.15)" stroke="rgba(255,138,61,0.4)" stroke-width="1" />
          <text x="52" y="60" font-size="30" text-anchor="middle">💬</text>
          <text x="100" y="50" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#ffffff">Tutor de IA Contextual</text>
          <text x="100" y="85" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="400" fill="#cbd5e1">
            <tspan x="100" dy="0">Tire dúvidas em tempo real sobre a explicação do professor com contexto exato</tspan>
            <tspan x="100" dy="24">da aula em reprodução. Pergunte código, teoria ou sínteses rápidas.</tspan>
          </text>
        </g>

        <!-- Card 2: Quizzes -->
        <g transform="translate(0, 180)">
          <rect x="0" y="0" width="940" height="150" rx="16" fill="#13151b" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="24" y="24" width="56" height="56" rx="12" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
          <text x="52" y="60" font-size="30" text-anchor="middle">🎯</text>
          <text x="100" y="50" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#ffffff">Quizzes Gerados na Hora</text>
          <text x="100" y="85" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="400" fill="#94a3b8">
            <tspan x="100" dy="0">Teste sua retenção instantaneamente com questões de múltipla escolha geradas</tspan>
            <tspan x="100" dy="24">diretamente a partir dos conceitos explicados na aula.</tspan>
          </text>
        </g>

        <!-- Card 3: Flashcards -->
        <g transform="translate(0, 360)">
          <rect x="0" y="0" width="940" height="150" rx="16" fill="#13151b" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="24" y="24" width="56" height="56" rx="12" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
          <text x="52" y="60" font-size="30" text-anchor="middle">📇</text>
          <text x="100" y="50" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#ffffff">Flashcards com Repetição Espaçada</text>
          <text x="100" y="85" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="400" fill="#94a3b8">
            <tspan x="100" dy="0">Crie cards de memorização para termos técnicos, códigos e fórmulas com</tspan>
            <tspan x="100" dy="24">algoritmo de revisão cronometrada para retenção de longo prazo.</tspan>
          </text>
        </g>
      </g>
    </svg>
  `;

  // ==========================================
  // SCENE 6: Sovereign Local Privacy
  // ==========================================
  const svgScene6 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="500" cy="540" r="600" fill="url(#left-glow)" />

      <!-- Left Column: Mockup Window -->
      ${makeWindow(130, 225, 'Local Player — Preferências &amp; Dados Locais', settingsBase64)}

      <!-- Right Column: Copy -->
      <g transform="translate(1220, 220)">
        <!-- Kicker -->
        <rect x="0" y="0" width="240" height="34" rx="17" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
        <text x="120" y="22" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="12" font-weight="700" letter-spacing="2" fill="#ff8a3d" text-anchor="middle">SOBERANIA &amp; PRIVACIDADE</text>

        <!-- Headline -->
        <text x="0" y="90" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1">
          100% no seu computador.
        </text>
        <text x="0" y="150" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="52" font-weight="800" fill="url(#amber-grad)" letter-spacing="-1">
          Zero telemetria.
        </text>

        <!-- Subtitle -->
        <text x="0" y="215" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="20" font-weight="400" fill="#94a3b8">
          <tspan x="0" dy="0">Sem contas obrigatórias. Sem rastreamento de navegação.</tspan>
          <tspan x="0" dy="32">Seus arquivos permanecem no seu disco rígido,</tspan>
          <tspan x="0" dy="32">acessíveis mesmo sem nenhuma conexão com a internet.</tspan>
        </text>

        <!-- Feature Pill 1 -->
        <g transform="translate(0, 340)">
          <rect x="0" y="0" width="570" height="68" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="14" y="14" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="34" y="40" font-size="20" text-anchor="middle">🛡</text>
          <text x="70" y="34" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="700" fill="#ffffff">Privacidade Absoluta</text>
          <text x="70" y="54" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="400" fill="#94a3b8">Nenhum dado de estudo sai da sua máquina</text>
        </g>

        <!-- Feature Pill 2 -->
        <g transform="translate(0, 424)">
          <rect x="0" y="0" width="570" height="68" rx="12" fill="#181b24" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
          <rect x="14" y="14" width="40" height="40" rx="8" fill="rgba(255,138,61,0.12)" stroke="rgba(255,138,61,0.3)" stroke-width="1" />
          <text x="34" y="40" font-size="20" text-anchor="middle">⚡</text>
          <text x="70" y="34" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="700" fill="#ffffff">Desempenho Instantâneo Offline</text>
          <text x="70" y="54" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="400" fill="#94a3b8">Acesso imediato a gigabytes de aulas sem carregar</text>
        </g>
      </g>
    </svg>
  `;

  // ==========================================
  // SCENE 7: Closing Call To Action
  // ==========================================
  const svgScene7 = `
    <svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      <rect width="1920" height="1080" fill="#0a0b0e" />
      <circle cx="960" cy="460" r="500" fill="url(#center-glow)" />

      <!-- Center Brand Logo -->
      <g transform="translate(875, 210)">
        <rect x="-15" y="-15" width="200" height="200" rx="46" fill="#ff8a3d" opacity="0.2" filter="url(#soft-blur)" />
        <image href="${iconBase64}" x="0" y="0" width="170" height="170" />
      </g>

      <!-- Title -->
      <text x="960" y="465" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="76" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="-1.5">
        Local Player
      </text>

      <!-- Tagline -->
      <text x="960" y="535" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="34" font-weight="600" fill="url(#amber-grad)" text-anchor="middle" letter-spacing="-0.5">
        Seu conhecimento. Seu ritmo. Localmente.
      </text>

      <!-- Subtitle -->
      <text x="960" y="605" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="22" font-weight="400" fill="#94a3b8" text-anchor="middle">
        O reprodutor desktop definitivo para sua biblioteca pessoal de estudos.
      </text>

      <!-- Badge Pill -->
      <g transform="translate(850, 675)">
        <rect x="0" y="0" width="220" height="46" rx="23" fill="rgba(24, 27, 36, 0.9)" stroke="rgba(255,255,255,0.12)" stroke-width="1.2" />
        <circle cx="36" cy="23" r="5" fill="#22c55e" />
        <text x="56" y="29" font-family="Ubuntu Sans, DejaVu Sans, sans-serif" font-size="13" font-weight="700" letter-spacing="2" fill="#ffffff">EXPERIMENTE HOJE</text>
      </g>
    </svg>
  `;

  const scenes = [
    { name: 'scene1.png', svg: svgScene1 },
    { name: 'scene2.png', svg: svgScene2 },
    { name: 'scene3.png', svg: svgScene3 },
    { name: 'scene4.png', svg: svgScene4 },
    { name: 'scene5.png', svg: svgScene5 },
    { name: 'scene6.png', svg: svgScene6 },
    { name: 'scene7.png', svg: svgScene7 }
  ];

  for (const s of scenes) {
    const dest = path.join(OUTPUT_DIR, s.name);
    console.log(`Rendering ${s.name}...`);
    await sharp(Buffer.from(s.svg)).png({ compressionLevel: 6 }).toFile(dest);
    console.log(`Saved ${s.name}`);
  }

  console.log('All 7 scene plates rendered successfully!');
}

renderPlates().catch(err => {
  console.error('Error generating plates:', err);
  process.exit(1);
});
