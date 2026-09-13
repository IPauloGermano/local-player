// --- Logs técnicos em memória (anel) ---
// Logs marcados [SUBTITLE]/[TRANSCODE]/[AI]/[SHUTDOWN]/[DEVICE]/[PROCESS] são
// espelhados num anel em memória para a Central de Diagnóstico (GET /api/logs).
// NUNCA são gravados em arquivo — invariante do projeto (log só em stdout).
const { logBuffer, MAX_LOG_ENTRIES } = require("../state");

function logTagOf(msg) {
  const m = /^\[([A-Za-z]+)\]/.exec(String(msg || ""));
  return m ? m[1].toUpperCase() : "LOG";
}

function pushLogBuffer(level, msg) {
  logBuffer.push({ ts: Date.now(), level, tag: logTagOf(msg), msg: String(msg) });
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  }
}

// Espelha console.* marcado para o anel; o resto passa direto (o comportamento
// atual de stdout é preservado). Os call sites já sanitizam chaves/prompts.
const _lpConsoleLog = console.log;
const _lpConsoleError = console.error;
const _lpConsoleWarn = console.warn;

function lpLogLevelFromMsg(first, fallback) {
  if (first.includes("[ERROR]")) return "ERROR";
  if (first.includes("[WARN]")) return "WARN";
  if (first.includes("[INFO]")) return "INFO";
  return fallback;
}

function lpMirrorConsole(method, args, fallbackLevel) {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (/^\[(SUBTITLE|TRANSCODE|AI|SHUTDOWN|PROCESS|DEVICE)\]/.test(first)) {
    pushLogBuffer(lpLogLevelFromMsg(first, fallbackLevel), args.map(String).join(" "));
  }
  return method.apply(console, args);
}

console.log = (...a) => lpMirrorConsole(_lpConsoleLog, a, "INFO");
console.warn = (...a) => lpMirrorConsole(_lpConsoleWarn, a, "WARN");
console.error = (...a) => lpMirrorConsole(_lpConsoleError, a, "ERROR");

module.exports = {
  logBuffer,
  MAX_LOG_ENTRIES,
  logTagOf,
  pushLogBuffer,
  lpLogLevelFromMsg,
  lpMirrorConsole,
};
