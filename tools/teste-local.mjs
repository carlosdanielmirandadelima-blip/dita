#!/usr/bin/env node
/**
 * Testa o adaptador local com áudio de fala REAL.
 *
 * Prova que o pipeline do Dita funciona sem Azure:
 *   1) WAV de fala (16 kHz mono) -> PCM (é o que o servidor recebe)
 *   2) transcribeLocal() -> texto
 *   3) confere que saiu texto legível, sem carimbos de tempo nem logs
 */
import { readFile } from "node:fs/promises";

import { transcribeLocal, localStatus, probeLocal, cleanWhisperOutput } from "../whisper-local.mjs";

const wavPath = process.env.WAV || "/tmp/fala-real.wav";

/** Extrai o bloco `data` de um WAV PCM (o servidor já entrega PCM puro). */
function pcmFromWav(wav) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV inválido");
  }
  for (let off = 12; off + 8 <= wav.length; ) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === "data") return wav.subarray(start, start + size);
    off = start + size + (size % 2);
  }
  throw new Error("bloco data ausente");
}

async function main() {
  console.log("\n=== 1) detecção do ambiente ===");
  const status = localStatus();
  console.log("   binário:", status.bin || "(não encontrado)");
  console.log("   modelo :", status.model || "(não encontrado)", status.modelName ? `(${status.modelName})` : "");
  console.log("   disponível:", status.available ? "SIM" : `NÃO — ${status.reason}`);

  const probe = await probeLocal();
  console.log("   probe  :", probe.ok ? `ok — ${probe.detail}` : `falhou — ${probe.detail}`);
  if (!probe.ok) process.exit(1);

  console.log("\n=== 2) prepara o áudio (como o servidor recebe) ===");
  const wav = await readFile(wavPath);
  const pcm = pcmFromWav(wav);
  const segundos = pcm.length / 2 / 16000;
  console.log(`   ${wavPath}: ${segundos.toFixed(2)}s | ${pcm.length} bytes de PCM s16le`);

  console.log("\n=== 3) transcreve (whisper.cpp local, sem rede) ===");
  const inicio = Date.now();
  const texto = await transcribeLocal(pcm, {
    language: process.env.LANG_W || "en",
    threads: 8,
    timeoutMs: 300_000,
  });
  const gasto = ((Date.now() - inicio) / 1000).toFixed(2);
  console.log(`   tempo: ${gasto}s | caracteres: ${texto.length}`);
  console.log(`   TEXTO: "${texto}"`);

  console.log("\n=== 4) valida a saída ===");
  const semTimestamp = !/\[\d{2}:\d{2}/.test(texto);
  const semLog = !/whisper_|ggml_|encode time|decode time/i.test(texto);
  const temTexto = texto.trim().length > 3;
  console.log(`   ${semTimestamp ? "ok  " : "FALHA"} sem carimbo de tempo`);
  console.log(`   ${semLog ? "ok  " : "FALHA"} sem logs do ggml`);
  console.log(`   ${temTexto ? "ok  " : "FALHA"} texto presente`);

  console.log("\n=== 5) limpeza da saída bruta (casos reais) ===");
  const amostras = [
    "[00:00:00.000 --> 00:00:02.000]   Olá, isto é um teste.",
    "whisper_init_from_file_with_params_no_state: loading model\n[00:00:01.000 --> 00:00:03.000]  Segundo trecho.",
    "[BLANK_AUDIO]",
    "[00:00:00.000 --> 00:00:01.000]   (música)",
  ];
  for (const a of amostras) {
    console.log(`   ${JSON.stringify(cleanWhisperOutput(a))}`);
  }

  const ok = semTimestamp && semLog && temTexto;
  console.log(ok ? "\n>>> OK: transcrição local funcionando" : "\n>>> FALHOU");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("\nERRO:", e.message);
  process.exit(1);
});
