#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endpointFromEnv, pcmFromWav, transcribeAzure } from "./azure-realtime.mjs";
import { localStatus, probeLocal, transcribeLocal } from "./whisper-local.mjs";
import { globalState, toggleGlobalDictation } from "./linux-global.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 3927);
const CONFIG_FILE = process.env.DITA_CONFIG || path.join(os.homedir(), ".config", "dita", "azure.env");
const MAX_BODY = 24_000 * 2 * 60 * 10 + 1024 * 64;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json" };

async function loadConfig() {
  const env = { ...process.env };
  try {
    const text = await readFile(CONFIG_FILE, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // "local" (padrão) usa o Whisper na própria máquina; "azure" usa o serviço remoto.
  const provider = (env.DITA_PROVIDER || "local").toLowerCase() === "azure" ? "azure" : "local";

  return {
    provider,
    azureCredential: env.AZURE_OPENAI_API_KEY,
    endpoint: endpointFromEnv(env),
    language: env.DITA_LANGUAGE || "pt",
    local: {
      bin: env.DITA_WHISPER_BIN,
      model: env.DITA_WHISPER_MODEL,
      threads: Number(env.DITA_WHISPER_THREADS || 0) || undefined,
    },
  };
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("audio-grande-demais");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = path.resolve(DIST, requested);
  if (!file.startsWith(`${DIST}${path.sep}`) && file !== path.join(DIST, "index.html")) return json(res, 403, { error: "proibido" });
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if ((req.headers.accept || "").includes("text/html")) file = path.join(DIST, "index.html");
    else return json(res, 404, { error: "nao-encontrado" });
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "max-age=300" });
  createReadStream(file).pipe(res);
}

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("Build ausente. Execute: npm run build");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/api/status") {
      const config = await loadConfig();
      return json(res, 200, await providerStatus(config));
    }
    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      const body = await readBody(req);
      const config = await loadConfig();
      const language = url.searchParams.get("lang") || config.language;

      const text =
        config.provider === "azure"
          ? // O Azure exige PCM cru no formato anunciado na sessão.
            await transcribeAzure(pcmFromWav(body), {
              apiKey: config.azureCredential,
              endpoint: config.endpoint,
              language,
            })
          : // O whisper.cpp aceita o WAV e reamostra sozinho.
            await transcribeLocal(body, { ...config.local, language });

      return json(res, 200, { text, provider: config.provider });
    }

    // Alterna entre Whisper local e Azure, persistindo a escolha.
    if (url.pathname === "/api/provider" && req.method === "POST") {
      const parsed = JSON.parse((await readBody(req)).toString() || "{}");
      const provider = parsed.provider === "azure" ? "azure" : "local";
      await saveProviderChoice(provider);
      return json(res, 200, await providerStatus(await loadConfig()));
    }
    if (url.pathname === "/api/hotkey" && req.method === "POST") {
      return json(res, 202, await toggleGlobalDictation(await loadConfig()));
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "erro-interno";
    const status =
      message === "azure-sem-chave" || message === "whisper-local-ausente" || message === "whisper-modelo-ausente"
        ? 503
        : message.startsWith("audio-") || message.startsWith("whisper-")
        ? 400
        : 502;
    return json(res, status, { error: message });
  }
});

/** Estado dos provedores para a interface. */
async function providerStatus(config) {
  const local = localStatus(config.local);
  const azureReady = Boolean(config.azureCredential);
  const active = config.provider;

  // O probe só roda quando o local é o provedor ativo (evita custo por consulta).
  let localReady = local.available;
  let localDetail = local.reason || "pronto";
  if (local.available && active === "local") {
    const probe = await probeLocal(config.local);
    localReady = probe.ok;
    localDetail = probe.detail;
  }

  return {
    provider: active,
    providerLabel: active === "local" ? "Whisper local (whisper.cpp)" : "Azure gpt-realtime-whisper",
    configured: active === "local" ? localReady : azureReady,
    available: { local: local.available && localReady, azure: azureReady },
    local: {
      available: local.available && localReady,
      bin: local.bin,
      model: local.model,
      modelName: local.modelName,
      detail: localDetail,
    },
    azure: { configured: azureReady, endpoint: config.endpoint },
    language: config.language,
    state: globalState(),
  };
}

/** Grava DITA_PROVIDER preservando o resto do arquivo (permissão 600). */
async function saveProviderChoice(provider) {
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  let lines = [];
  try {
    lines = (await readFile(CONFIG_FILE, "utf8")).split(/\r?\n/);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const kept = lines.filter((l) => l.trim() && !/^DITA_PROVIDER=/.test(l));
  kept.push(`DITA_PROVIDER=${provider}`);
  await writeFile(CONFIG_FILE, kept.join("\n") + "\n", { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Dita ativo em http://127.0.0.1:${PORT}`);
  console.log("Atalho global: ~/.local/bin/dita-toggle");
});
