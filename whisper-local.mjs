/**
 * Dita — transcrição local com Whisper (whisper.cpp).
 *
 * Backend 100% offline: nenhum áudio sai da máquina.
 *
 * O áudio chega como PCM s16le mono 16 kHz (o formato nativo do Whisper) e é
 * entregue ao binário `whisper-cli` por um arquivo temporário de 16 bits. A
 * saída padrão do binário vem como `[00:00:00.000 --> ...]  texto`, que é
 * limpa aqui para sobrar só o texto transcrito.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Taxa nativa do Whisper. Tudo é convertido para isso antes de transcrever. */
export const WHISPER_RATE = 16_000;
/** Limite de áudio aceito (10 minutos, como no backend remoto). */
const MAX_PCM_BYTES = 24_000 * 2 * 60 * 10;

/** Candidatos a binário, em ordem de preferência. */
const BIN_CANDIDATES = [
  "whisper-cli",
  "whisper-cpp",
  "whisper.cpp",
  "main",
];

/** Candidatos de modelo, quando o usuário não define um caminho. */
const MODEL_DIRS = [
  path.join(os.homedir(), ".local", "share", "dita", "models"),
  path.join(os.homedir(), ".cache", "whisper"),
  "/usr/share/whisper.cpp/models",
  "/usr/local/share/whisper.cpp/models",
];

/** Procura um executável no PATH (sem shell). */
function which(command) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (existsSync(candidate)) {
      try {
        // Verifica se é executável de fato.
        access(candidate, 1 /* X_OK */);
        return candidate;
      } catch {
        // segue procurando
      }
    }
  }
  return null;
}

/** Descobre o binário do whisper.cpp. */
export function findWhisperBin(explicit) {
  // 1) caminho passado pela configuração do Dita (~/.config/dita/azure.env)
  const fromArg = (explicit || '').trim();
  if (fromArg) return existsSync(fromArg) ? fromArg : null;

  // 2) variável de ambiente
  const fromEnv = (process.env.DITA_WHISPER_BIN || '').trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  for (const name of BIN_CANDIDATES) {
    const found = which(name);
    if (found) return found;
  }
  // Build local do usuário (instalação feita pelo install.sh).
  const localBuild = path.join(os.homedir(), ".local", "share", "dita", "whisper.cpp", "build", "bin", "whisper-cli");
  if (existsSync(localBuild)) return localBuild;
  return null;
}

/** Descobre o modelo ggml. */
export function findWhisperModel(explicit) {
  // 1) caminho passado pela configuração do Dita
  const fromArg = (explicit || '').trim();
  if (fromArg) return existsSync(fromArg) ? fromArg : null;

  // 2) variável de ambiente
  const fromEnv = (process.env.DITA_WHISPER_MODEL || '').trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;

  const fromBin = (process.env.DITA_MODEL_DIR || '').trim();
  const dirs = fromBin ? [fromBin, ...MODEL_DIRS] : MODEL_DIRS;

  // Preferência: small > base > medium > tiny > large (equilíbrio qualidade/velocidade).
  const preference = ["ggml-small.bin", "ggml-base.bin", "ggml-medium.bin", "ggml-tiny.bin", "ggml-large-v3.bin"];

  for (const file of preference) {
    for (const dir of dirs) {
      const candidate = path.join(dir, file);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Qualquer ggml-*.bin encontrado.
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const fs = require("node:fs");
      const entry = fs.readdirSync(dir).find((f) => /^ggml-.*\.bin$/.test(f));
      if (entry) return path.join(dir, entry);
    } catch {
      // diretório ilegível
    }
  }
  return null;
}

/** Nome amigável do modelo (ex.: "base", "small.en"). */
export function modelLabel(modelPath) {
  if (!modelPath) return null;
  const base = path.basename(modelPath).replace(/^ggml-/, "").replace(/\.bin$/, "");
  return base;
}

/** Diagnóstico usado por /api/status e pela interface. */
export function localStatus(options = {}) {
  const bin = findWhisperBin(options.bin);
  const model = findWhisperModel(options.model);

  if (!bin) {
    return {
      available: false,
      bin: null,
      model,
      modelName: modelLabel(model),
      reason: "whisper.cpp não encontrado (instale com ./install.sh ou defina DITA_WHISPER_BIN)",
    };
  }
  if (!model) {
    return {
      available: false,
      bin,
      model: null,
      modelName: null,
      reason: "modelo do Whisper não encontrado (defina DITA_WHISPER_MODEL ou baixe um ggml-*.bin)",
    };
  }
  return { available: true, bin, model, modelName: modelLabel(model) };
}

/**
 * Verifica de verdade se o binário roda (pega bibliotecas faltando, binário
 * de outra arquitetura, ggml incompatível).
 */
export async function probeLocal(options = {}) {
  const status = localStatus(options);
  if (!status.available) return { ok: false, detail: status.reason || "indisponível" };

  try {
    // `--help` sai com código 0 na maioria das versões; se sair diferente,
    // ainda assim significa que o binário executou.
    const { stdout, stderr } = await execFileAsync(status.bin, ["--help"], { timeout: 15_000 });
    const text = `${stdout}${stderr}`;
    if (/whisper|usage/i.test(text)) {
      return { ok: true, detail: `whisper.cpp pronto (modelo ${status.modelName})` };
    }
    return { ok: true, detail: "binário executou" };
  } catch (error) {
    const e = error;
    const text = `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`;
    // Alguns builds saem com código != 0 em --help mas funcionam.
    if (/whisper|usage|error: unknown argument/i.test(text)) {
      return { ok: true, detail: "binário executou" };
    }
    return { ok: false, detail: text.trim().split("\n").slice(0, 2).join(" ") || "falha ao executar" };
  }
}

/**
 * Escreve PCM cru em um WAV temporário.
 * A taxa precisa ser a REAL do áudio gravado: assumir 16 kHz para um áudio de
 * 24 kHz faria o Whisper "ouvir" tudo 1,5x mais rápido.
 */
function pcmToWav(pcm, rate = WHISPER_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // tamanho do bloco fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits por amostra
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Converte PCM s16le para float32 (formato usado por --format no whisper.cpp). */
function pcmToF32(pcm) {
  const samples = pcm.length / 2;
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    out.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4);
  }
  return out;
}

/** Limpa a saída do whisper.cpp, deixando só o texto. */
export function cleanWhisperOutput(raw) {
  const lines = raw.split(/\r?\n/);
  const parts = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Ignora logs do ggml/whisper.
    if (/^(whisper_|ggml_|main:|system_info|error:|warning:|encoded \d+|decoding|load time|mel time|sample time|encode time|decode time|total time|threads)/i.test(trimmed)) {
      continue;
    }
    // Remove o carimbo de tempo: [00:00:00.000 --> 00:00:02.000]
    const withoutStamp = trimmed.replace(/^\[[\d:.,\s>-]+\]\s*/, "");
    if (!withoutStamp) continue;
    // Remove marcadores de silêncio/não-fala.
    if (/^\[(BLANK_AUDIO|SILENCE|MUSIC|INAUDIBLE|.*no speech.*)\]$/i.test(withoutStamp)) continue;
    if (/^\((.*(silence|música|music|inaudível|inaudible).*)\)$/i.test(withoutStamp)) continue;
    parts.push(withoutStamp);
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Transcreve audio usando o whisper.cpp local.
 *
 * Aceita o WAV inteiro (cabeçalho + dados). O whisper.cpp reamostra para
 * 16 kHz internamente, então qualquer taxa de amostragem mono funciona.
 * Se receber apenas PCM cru (sem cabeçalho), monta o WAV em 16 kHz.
 */
export async function transcribeLocal(audio, options = {}) {
  const status = localStatus(options);
  const bin = options.bin || status.bin;
  const model = options.model || status.model;

  if (!bin) throw new Error("whisper-local-ausente");
  if (!model) throw new Error("whisper-modelo-ausente");
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw new Error("audio-invalido");
  if (audio.length > MAX_PCM_BYTES) throw new Error("audio-grande-demais");

  const isWav = audio.length > 44 && audio.toString("ascii", 0, 4) === "RIFF" && audio.toString("ascii", 8, 12) === "WAVE";
  if (!isWav && audio.length % 2 !== 0) throw new Error("audio-invalido");

  // Carrega o modelo uma vez? Não: cada chamada é um processo curto e o
  // modelo fica no cache de páginas do sistema.
  const dir = await mkdtemp(path.join(os.tmpdir(), "dita-local-"));
  const wavPath = path.join(dir, "audio.wav");

  try {
    // Taxa da gravação (o atalho grava em 24 kHz; o navegador também).
    const rate = Number(options.rate) || WHISPER_RATE;
    await writeFile(wavPath, isWav ? audio : pcmToWav(audio, rate));

    const language = (options.language || "auto").toLowerCase();
    const threads = Math.max(1, options.threads || Math.max(1, Math.floor(os.cpus().length / 2)));

    const args = [
      "-m", model,
      "-f", wavPath,
      "-t", String(threads),
      "-nt",              // sem timestamps na saída
      "-otxt",            // também gera .txt (usamos o stdout como principal)
      "--no-prints",      // silencia logs do ggml
    ];

    if (language && language !== "auto") {
      args.push("-l", language);
    } else {
      args.push("-l", "auto");
    }

    // Prompt inicial ajuda a manter pontuação natural em português.
    if (language === "pt" || language === "pt-br") {
      args.push("--prompt", "Transcrição em português do Brasil.");
    }

    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: options.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GGML_LOG_LEVEL: "ERROR" },
    });

    let text = cleanWhisperOutput(stdout);

    // Alguns builds gravam o texto só no arquivo .txt ao lado do áudio.
    if (!text) {
      try {
        const txt = await readFile(path.join(dir, "audio.wav.txt"), "utf8");
        text = cleanWhisperOutput(txt);
      } catch {
        // sem arquivo txt
      }
    }

    if (!text) {
      const errText = cleanWhisperOutput(stderr);
      throw new Error(errText ? `whisper-falhou: ${errText.slice(0, 200)}` : "whisper-resposta-vazia");
    }

    return text;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { pcmToWav, pcmToF32 };
