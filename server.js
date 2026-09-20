const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Prioridade: Cloudflare (CF_ACCOUNT_ID + CF_API_TOKEN) > Hugging Face (HF_TOKEN) > Pollinations (sem chave).
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
// Modelo da Cloudflare. Troque por "@cf/black-forest-labs/flux-1-schnell" para voltar ao antigo.
const CF_MODEL = process.env.CF_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
const CF_IS_FLUX2 = CF_MODEL.includes("flux-2");
const HF_TOKEN = process.env.HF_TOKEN || "";
const HF_MODEL = process.env.HF_MODEL || "black-forest-labs/FLUX.1-schnell";

const MAX_PROMPT = 500;
const TIMEOUT_MS = 90_000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Limite simples por IP para proteger a cota gratuita (6 pedidos por minuto).
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (list.length >= 6) {
    return res
      .status(429)
      .json({ error: "Muitos pedidos seguidos. Espere um minuto e tente de novo." });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < 60_000)) hits.delete(ip);
  }
}, 60_000).unref();

function clampSize(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 768;
  return Math.min(1024, Math.max(256, Math.round(v / 64) * 64));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithCloudflare({ prompt, width, height, seed }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_MODEL}`;
  const headers = { Authorization: `Bearer ${CF_API_TOKEN}` };
  let body;

  if (CF_IS_FLUX2) {
    // A família FLUX.2 exige multipart/form-data, mesmo só com texto.
    const form = new FormData();
    form.append("prompt", prompt.slice(0, 2048));
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("seed", String(seed));
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 4 });
  }

  const r = await fetchWithTimeout(url, { method: "POST", headers, body });

  const type = r.headers.get("content-type") || "";
  if (r.ok && type.startsWith("image/")) {
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  }

  let data = null;
  try {
    data = await r.json();
  } catch (_) {}
  if (!r.ok || !data || data.success === false) {
    const msg =
      (data && Array.isArray(data.errors) && data.errors.map((e) => e.message).join("; ")) ||
      `Cloudflare respondeu ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const b64 = (data.result && data.result.image) || data.image;
  if (!b64) throw new Error("A Cloudflare não devolveu imagem.");
  return `data:image/${CF_IS_FLUX2 ? "png" : "jpeg"};base64,${b64}`;
}

async function generateWithHuggingFace({ prompt, width, height, seed }) {
  // A biblioteca oficial escolhe sozinha o provedor que atende o modelo.
  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(HF_TOKEN);
  const blob = await client.textToImage({
    provider: "auto",
    model: HF_MODEL,
    inputs: prompt,
    parameters: { width, height, seed },
  });
  const buf = Buffer.from(await blob.arrayBuffer());
  return `data:${blob.type || "image/png"};base64,${buf.toString("base64")}`;
}

async function generateWithPollinations({ prompt, width, height, seed }) {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;
  const r = await fetchWithTimeout(url);
  if (!r.ok) {
    const err = new Error(`Pollinations respondeu ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const type = r.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) {
    throw new Error("O serviço não devolveu uma imagem.");
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:${type};base64,${buf.toString("base64")}`;
}

function currentProvider() {
  if (CF_ACCOUNT_ID && CF_API_TOKEN) return "cloudflare";
  if (HF_TOKEN) return "huggingface";
  return "pollinations";
}

app.get("/api/status", (_req, res) => {
  const provider = currentProvider();
  res.json({ provider, supportsSize: provider !== "cloudflare" || CF_IS_FLUX2 });
});

app.post("/api/generate", rateLimit, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Escreva uma descrição." });
  if (prompt.length > MAX_PROMPT) {
    return res
      .status(400)
      .json({ error: `Descrição muito longa (máximo ${MAX_PROMPT} caracteres).` });
  }

  const width = clampSize(req.body?.width);
  const height = clampSize(req.body?.height);
  const seedIn = parseInt(req.body?.seed, 10);
  const seed = Number.isFinite(seedIn) ? seedIn : Math.floor(Math.random() * 1e9);

  try {
    const provider = currentProvider();
    const image =
      provider === "cloudflare"
        ? await generateWithCloudflare({ prompt, width, height, seed })
        : provider === "huggingface"
        ? await generateWithHuggingFace({ prompt, width, height, seed })
        : await generateWithPollinations({ prompt, width, height, seed });
    res.json({ image, seed });
  } catch (e) {
    console.error("Erro ao gerar:", e.message);
    if (e.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "A geração demorou demais. Tente de novo em instantes." });
    }
    if (e.status === 503) {
      return res
        .status(503)
        .json({ error: "O modelo está carregando. Tente de novo em alguns segundos." });
    }
    if (
      e.status === 429 ||
      e.status === 402 ||
      /depleted|daily free allocation|neurons|quota|credits/i.test(e.message)
    ) {
      return res
        .status(429)
        .json({ error: "A cota gratuita acabou por agora. Ela renova sozinha (no Cloudflare, todo dia). Tente mais tarde." });
    }
    res.status(502).json({ error: "Não foi possível gerar a imagem agora.", detail: e.message });
  }
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
