const { AI_LLM_PROVIDER_TYPES } = require("../ai/config");
const { sanitizeTestError } = require("../core/scan");

async function streamLlmChat({ provider, model, temperature, messages, systemPrompt, res, req, timeoutMs }) {
  const type =
    AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
    AI_LLM_PROVIDER_TYPES[0];
  const url = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) })),
    ],
    temperature: typeof temperature === "number" ? temperature : 0.3,
    stream: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 45000);

  if (req) {
    req.on("close", () => {
      clearTimeout(timer);
      controller.abort();
    });
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const why = err && err.name === "AbortError" ? "Tempo limite excedido." : (err && err.message) || "Erro de conexão com o provedor.";
    res.write(`data: ${JSON.stringify({ error: sanitizeTestError(why) })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (!resp.ok) {
    clearTimeout(timer);
    let errMsg = `HTTP ${resp.status} do provedor LLM`;
    try {
      const errJson = await resp.json();
      if (errJson && errJson.error) {
        errMsg = typeof errJson.error === "string" ? errJson.error : errJson.error.message || errMsg;
      }
    } catch {}
    res.write(`data: ${JSON.stringify({ error: sanitizeTestError(errMsg) })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of resp.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          res.write("data: [DONE]\n\n");
          continue;
        }
        try {
          const parsed = JSON.parse(dataStr);
          const delta =
            parsed &&
            parsed.choices &&
            parsed.choices[0] &&
            parsed.choices[0].delta &&
            typeof parsed.choices[0].delta.content === "string"
              ? parsed.choices[0].delta.content
              : null;
          if (delta) {
            res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
        } catch {}
      }
    }
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          res.write("data: [DONE]\n\n");
        } else {
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (delta) res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          } catch {}
        }
      }
    }
    res.write("data: [DONE]\n\n");
  } catch (err) {
    if (err && err.name !== "AbortError") {
      res.write(`data: ${JSON.stringify({ error: sanitizeTestError(err.message || "Erro no streaming") })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
  } finally {
    clearTimeout(timer);
    res.end();
  }
}

module.exports = {
  streamLlmChat,
};
