# Relatório de Análise e Arquitetura de Segurança (Local Player)

Este documento descreve a postura de segurança, modelos de ameaça e salvaguardas implementadas no **Local Player** (aplicação web local + cliente desktop Electron).

---

## 1. Modelo de Ameaça

O Local Player é executado localmente na máquina do usuário e processa arquivos locais (vídeos, legendas, documentos, modelos de IA). As principais superfícies de ataque consideradas são:

1. **Ataques baseados em rede local ou navegação web do usuário**:
   - Páginas web maliciosas no navegador do usuário tentando se comunicar com o servidor HTTP local (`127.0.0.1:4173`).
   - Técnicas de **DNS Rebinding** (onde um domínio externo resolve temporariamente para `127.0.0.1` a fim de burlar a Same-Origin Policy).
   - Ataques de **Cross-Site Request Forgery (CSRF)** para acionar endpoints destrutivos ou caros (limpar progresso, disparar transcrições pesadas de CPU, reconfigurar bibliotecas).

2. **Injeção e Escape de Filesystem**:
   - Ataques de **Path Traversal** via parâmetros de caminho relativos (`../`, barras invertidas no Windows, drive roots) tentando acessar arquivos arbitrários do sistema operacional.
   - Symlinks maliciosos criados dentro de pastas de cursos apontando para arquivos sensíveis fora da biblioteca autorizada.

3. **Injeção de Comandos em Subprocessos**:
   - Chamadas a utilitários de mídia e IA (`ffmpeg`, `ffprobe`, `whisper-cli`, `pdftotext`).

4. **Vazamento de Segredos e Chaves de API**:
   - Chaves de API de provedores de IA em nuvem (OpenAI, Anthropic, OpenRouter, etc.).

5. **Superfície do Electron (Desktop)**:
   - Execução de código arbitrário caso conteúdo web ou links externos sejam renderizados no renderer.

---

## 2. Salvaguardas Implementadas por Classe de Vulnerabilidade

### 2.1. Proteção contra DNS Rebinding e CSRF
- **Validação de Cabeçalho `Host`**:
  O middleware global em `server.js` (`isAllowedHostHeader`) inspeciona todas as requisições HTTP (incluindo `GET`). Requisições com `Host` divergente de `localhost`, IPs literais (`127.0.0.1`, `::1` ou IPs locais de rede) ou o `HOST` configurado são sumariamente rejeitadas com HTTP 403.
- **Proteção Anti-CSRF Global**:
  Todas as rotas mutantes (`POST`, `PUT`, `PATCH`, `DELETE`) passam por `verifyCsrfAndSafeOrigin`. Requisições marcadas com `Sec-Fetch-Site: cross-site` ou com cabeçalhos `Origin` ou `Referer` divergentes do `Host` são bloqueadas com HTTP 403.
- **Headers HTTP Baseline**:
  - `X-Content-Type-Options: nosniff` (impede MIME-sniffing).
  - `Referrer-Policy: no-referrer` (evita vazamento de nomes de pastas/aulas em requisições de saída).
  - `X-Frame-Options: DENY` (previne clickjacking em iframes).

### 2.2. Isolamento de Filesystem e Anti-Path Traversal
- **Resolução Estrita (`resolveSafeRelPath` / `resolveLibraryRel`)**:
  - Normaliza caminhos e remove leading slashes/backslashes.
  - Rejeita sequências de escape (`..`) após normalização.
  - Ancorado no caminho absoluto canônico da biblioteca. No Windows, a comparação de caminhos é normalizada para case-insensitivity e suporte a raízes de volume (`D:\`).
- **Verificação Pós-Symlink (`fileWithinLibrary`)**:
  - Utiliza `fs.realpath` para resolver symlinks e junctions antes de abrir ou servir arquivos. Garante que o alvo real esteja estritamente contido no diretório autorizado.
- **Proteção do Diretório da Aplicação (`isAppDirRel`)**:
  - Bloqueia acessos que apontem para a pasta interna da aplicação (`_LocalPlayer`), impedindo leitura ou adulteração dos arquivos do player.
- **Escrita Atômica (`fs-atomic.js`)**:
  - Modificações em dados de progresso e configurações usam escrita atômica via arquivo temporário com substituição atômica (`rename`), acompanhada de backup (`.bak`) e auto-recuperação.

### 2.3. Execução Segura de Subprocessos
- Nenhuma chamada a `child_process.exec()` ou `spawn()` com `{ shell: true }`.
- Todos os binários (`ffmpeg`, `ffprobe`, `whisper-cli`, `pdftotext`) são executados com argumentos passados estritamente como array de strings, eliminando injeção de comandos de shell.
- Timeout rígido configurado em execuções de suporte para prevenir travamento de processos.

### 2.4. Anti-SSRF (Server-Side Request Forgery)
- Funções de busca web e teste de endpoints de IA utilizam `validateSafeUrl` e `isPrivateIp`.
- Bloqueio completo de IPs de loopback (`127.0.0.0/8`, `::1`), RFC 1918 (redes privadas `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), Link-Local (`169.254.0.0/16`), metadados de nuvem e esquemas não-HTTP (`file:`, `ftp:`, `gopher:`).

### 2.5. Proteção de Chaves de API e Segredos
- As chaves de API salvas em `data/ai-config.json` nunca são expostas na íntegra para o frontend.
- A função `maskAiConfig` mascara as chaves, retornando apenas `hasApiKey: boolean` nas respostas da API REST.
- O endpoint de configuração administrativa é restrito a requisições locais (`requireAdminOrLocal`).

### 2.6. Isolamento e Segurança do Electron (Desktop)
- `nodeIntegration: false` (o processo de renderização não possui acesso às APIs nativas do Node.js).
- `contextIsolation: true` (scripts de página rodam em contexto isolado).
- `setWindowOpenHandler`: bloqueia novas janelas embutidas e delega URLs externas para o navegador padrão do sistema operacional (`shell.openExternal`).
- `will-navigate`: impede navegação para fora do servidor local autorizado.
- `setPermissionRequestHandler`: rejeita solicitações de permissões sensíveis (câmera, microfone, geolocalização).
- `SingleInstanceLock`: garante instância única, evitando múltiplos servidores concorrentes.

---

## 3. Matriz de Testes Automatizados de Segurança

A suíte em `test/security-fixes.test.js` e `test/windows-compat.test.js` valida continuamente:
1. Rejeição de DNS Rebinding (GET e métodos mutantes).
2. Bloqueio de CSRF com `Sec-Fetch-Site: cross-site` e `Origin` divergente.
3. Detecção e bloqueio de SSRF para todos os formatos de IPv4 e IPv6 privados.
4. Bloqueio de Path Traversal lexical e baseado em symlinks.
5. Fechamento seguro de subprocessos e durabilidade de dados.
