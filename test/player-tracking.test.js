const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function trackLesson() {
  const video = Object.assign(new EventTarget(), {
    dataset: {}, duration: 600, currentTime: 0, loads: 0,
    load() { this.loads++; },
    removeAttribute() {},
  });
  const posts = [];
  const probes = [];
  const messages = [];
  let now = 0;
  const context = vm.createContext({
    window: { LocalPlayerScope: {}, addEventListener() {} },
    document: { getElementById: id => id === "video-el" ? video : null, addEventListener() {} },
    performance: { now: () => now },
    fetch: async (url, options) => {
      if (options?.method === "POST") posts.push(JSON.parse(options.body).position);
      else probes.push(url);
      return { ok: true, json: async () => ({ compatible: true }) };
    },
  });
  for (const file of ["app.js", "js/player.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
    vm.runInContext(source.replace(/^init\(\);\s*$/m, ""), context, { filename: file });
  }
  context.updateProgressUI = () => {};
  context.setPlayerStatus = (message, retry) => messages.push({ message, retry });
  context.setupVideoTracking({ path: "aula.mp4" });
  return {
    video, posts, probes, messages,
    playAt(position, elapsedMs) {
      now += elapsedMs;
      video.currentTime = position;
      video.dispatchEvent(new Event("timeupdate"));
    },
  };
}

test("continua salvando a cada cinco segundos depois de retroceder", () => {
  const { playAt, posts } = trackLesson();
  playAt(300, 6000);
  playAt(60, 100);
  playAt(66, 6000);
  assert.deepEqual(posts, [300, 66]);
});

test("um segundo erro do original oferece nova tentativa manual", async () => {
  const { video, probes, messages } = trackLesson();
  video.dispatchEvent(new Event("error"));
  await new Promise(setImmediate);
  video.dispatchEvent(new Event("error"));
  await new Promise(setImmediate);
  assert.equal(probes.length, 1);
  assert.equal(video.loads, 1);
  assert.equal(typeof messages.at(-1).retry, "function");
  assert.match(messages.at(-1).message, /reproduzir/i);
});
