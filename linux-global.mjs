import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transcribeAzure } from "./azure-realtime.mjs";
import { transcribeLocal } from "./whisper-local.mjs";

// Taxa usada pelo gravador (pw-record/arecord).
const RECORD_RATE = 24_000;

let recording = null;
let processing = false;

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/**
 * Transcreve usando o provedor configurado.
 * "local" roda o Whisper na própria máquina (nenhum áudio sai daqui).
 */
async function transcribe(pcm, config) {
  if (config.provider === "azure") {
    return transcribeAzure(pcm, {
      apiKey: config.azureCredential,
      endpoint: config.endpoint,
      language: config.language,
    });
  }
  // A gravação é PCM s16le 24 kHz; o módulo local monta o WAV quando recebe
  // PCM cru, então basta repassar.
  // A gravação é feita em 24 kHz mono (ver startRecording).
  return transcribeLocal(pcm, { ...(config.local || {}), language: config.language, rate: RECORD_RATE });
}

function notify(message) {
  if (commandExists("notify-send")) spawn("notify-send", ["Dita", message], { stdio: "ignore", detached: true }).unref();
}

async function startRecording() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dita-"));
  const file = path.join(dir, "audio.raw");
  let child;
  if (commandExists("pw-record")) {
    child = spawn("pw-record", ["--format=s16", `--rate=${RECORD_RATE}`, "--channels=1", file], { stdio: "ignore" });
  } else if (commandExists("arecord")) {
    child = spawn("arecord", ["-q", "-f", "S16_LE", "-r", String(RECORD_RATE), "-c", "1", "-t", "raw", file], { stdio: "ignore" });
  } else {
    await rm(dir, { recursive: true, force: true });
    throw new Error("instale pipewire-bin ou alsa-utils");
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 250);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code && code !== 130) {
        clearTimeout(timer);
        reject(new Error("microfone indisponível"));
      }
    });
  });
  recording = { child, dir, file };
  notify("Gravando… pressione F8 novamente para transcrever.");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");
}

function runWithInput(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
  return result.status === 0;
}

function pasteText(text) {
  if (commandExists("wl-copy") && commandExists("ydotool")) {
    if (!runWithInput("wl-copy", [], text)) return false;
    return spawnSync("ydotool", ["key", "29:1", "47:1", "47:0", "29:0"], { stdio: "ignore" }).status === 0;
  }
  if (commandExists("xclip") && commandExists("xdotool")) {
    if (!runWithInput("xclip", ["-selection", "clipboard"], text)) return false;
    return spawnSync("xdotool", ["key", "--clearmodifiers", "ctrl+v"], { stdio: "ignore" }).status === 0;
  }
  return false;
}

async function stopAndType(config) {
  const current = recording;
  recording = null;
  processing = true;
  try {
    await stopChild(current.child);
    const pcm = await readFile(current.file);
    if (pcm.length < 24_000) throw new Error("áudio curto ou vazio");
    notify(config.provider === "azure" ? "Transcrevendo com Azure Whisper…" : "Transcrevendo com Whisper local…");
    const text = await transcribe(pcm, config);
    if (!pasteText(text)) {
      throw new Error("não foi possível digitar; configure ydotool (Wayland) ou xdotool (X11)");
    }
    notify("Texto digitado.");
  } finally {
    processing = false;
    await rm(current.dir, { recursive: true, force: true });
  }
}

export function globalState() {
  return processing ? "processing" : recording ? "recording" : "idle";
}

export async function toggleGlobalDictation(config) {
  if (processing) return { state: "processing" };
  if (!recording) {
    await startRecording();
    return { state: "recording" };
  }
  void stopAndType(config).catch((error) => notify(`Erro: ${error.message}`));
  return { state: "processing" };
}
