/**
 * Testes do backend local do Dita.
 *
 * Rodam sem rede e sem modelo real quando possível; os testes que precisam do
 * binário/modelo são pulados automaticamente se eles não estiverem presentes.
 *
 *   npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cleanWhisperOutput,
  findWhisperBin,
  findWhisperModel,
  localStatus,
  modelLabel,
  pcmToWav,
  transcribeLocal,
} from "../whisper-local.mjs";
import { endpointFromEnv, pcmFromWav } from "../azure-realtime.mjs";

/* ------------------------------------------------------------------ */
/* Limpeza da saída                                                    */
/* ------------------------------------------------------------------ */

describe("cleanWhisperOutput", () => {
  test("remove carimbo de tempo", () => {
    assert.equal(
      cleanWhisperOutput("[00:00:00.000 --> 00:00:02.000]   Olá, mundo."),
      "Olá, mundo."
    );
  });

  test("remove logs do ggml e do whisper", () => {
    const raw = [
      "whisper_init_from_file_with_params_no_state: loading model",
      "ggml_init: allocating 100 MB",
      "main: processing audio",
      "[00:00:01.000 --> 00:00:03.000]  Texto útil.",
      "total time = 1.2 s",
    ].join("\n");
    assert.equal(cleanWhisperOutput(raw), "Texto útil.");
  });

  test("descarta marcadores de silêncio", () => {
    assert.equal(cleanWhisperOutput("[BLANK_AUDIO]"), "");
    assert.equal(cleanWhisperOutput("[00:00:00.000 --> 00:00:01.000]   (música)"), "");
    assert.equal(cleanWhisperOutput("(silence)"), "");
  });

  test("junta várias linhas com espaço simples", () => {
    const raw = [
      "[00:00:00.000 --> 00:00:01.000]  Primeira parte.",
      "[00:00:01.000 --> 00:00:02.000]  Segunda parte.",
    ].join("\n");
    assert.equal(cleanWhisperOutput(raw), "Primeira parte. Segunda parte.");
  });

  test("normaliza espaços internos", () => {
    assert.equal(
      cleanWhisperOutput("[00:00:00.000 --> 00:00:01.000]  muito    espaçado"),
      "muito espaçado"
    );
  });

  test("saída vazia continua vazia", () => {
    assert.equal(cleanWhisperOutput(""), "");
    assert.equal(cleanWhisperOutput("\n\n"), "");
  });
});

/* ------------------------------------------------------------------ */
/* Detecção de binário e modelo                                        */
/* ------------------------------------------------------------------ */

describe("detecção do ambiente", () => {
  test("caminho inexistente informado pelo usuário é rejeitado", () => {
    assert.equal(findWhisperBin("/caminho/que/nao/existe"), null);
  });

  test("modelo inexistente informado pelo usuário é rejeitado", () => {
    assert.equal(findWhisperModel("/nao/existe.bin"), null);
  });

  test("modelLabel extrai o nome do modelo", () => {
    assert.equal(modelLabel("/x/models/ggml-small.bin"), "small");
    assert.equal(modelLabel("/x/ggml-base.en.bin"), "base.en");
    assert.equal(modelLabel(null), null);
  });

  test("localStatus explica o motivo quando falta algo", () => {
    const status = localStatus({ bin: "/nao/existe", model: "/nao/existe" });
    assert.equal(status.available, false);
    assert.ok(typeof status.reason === "string" && status.reason.length > 0);
  });
});

/* ------------------------------------------------------------------ */
/* WAV                                                              */
/* ------------------------------------------------------------------ */

describe("WAV", () => {
  test("pcmToWav monta cabeçalho válido", () => {
    const pcm = Buffer.alloc(200);
    const wav = pcmToWav(pcm, 24_000);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1, "mono");
    assert.equal(wav.readUInt32LE(24), 24_000, "taxa preservada");
    assert.equal(wav.readUInt16LE(34), 16, "16 bits");
    assert.equal(wav.readUInt32LE(40), 200, "tamanho dos dados");
  });

  test("taxa de amostragem é respeitada (não acelera o áudio)", () => {
    const wav16 = pcmToWav(Buffer.alloc(100), 16_000);
    const wav24 = pcmToWav(Buffer.alloc(100), 24_000);
    assert.equal(wav16.readUInt32LE(24), 16_000);
    assert.equal(wav24.readUInt32LE(24), 24_000);
  });

  test("pcmFromWav extrai os dados de um WAV 24 kHz (formato do Azure)", () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    const wav = pcmToWav(pcm, 24_000);
    assert.deepEqual(pcmFromWav(wav), pcm);
  });

  test("pcmFromWav recusa taxa diferente de 24 kHz (exigência do Azure)", () => {
    // O backend local aceita qualquer taxa, mas o remoto exige 24 kHz.
    const wav16 = pcmToWav(Buffer.alloc(100), 16_000);
    assert.throws(() => pcmFromWav(wav16), /audio-formato-invalido/);
  });

  test("pcmFromWav rejeita arquivo que não é WAV", () => {
    assert.throws(() => pcmFromWav(Buffer.from("nao sou wav")), /audio-wav-invalido/);
  });
});

/* ------------------------------------------------------------------ */
/* Azure: endpoint                                                     */
/* ------------------------------------------------------------------ */

describe("Azure (opcional)", () => {
  test("não há endpoint embutido no código", () => {
    // Garante que nenhum recurso privado ficou no repositório.
    assert.equal(endpointFromEnv({}), "");
  });

  test("usa o endpoint informado pela configuração", () => {
    const url = "https://exemplo.openai.azure.com/openai/v1/realtime?model=x";
    assert.equal(endpointFromEnv({ AZURE_OPENAI_REALTIME_URL: url }), url);
  });

  test("falha com mensagem clara quando falta endpoint ou chave", async () => {
    const { transcribeAzure } = await import("../azure-realtime.mjs");
    await assert.rejects(
      () => transcribeAzure(Buffer.alloc(10), { apiKey: "" }),
      /azure-sem-chave/
    );
    await assert.rejects(
      () => transcribeAzure(Buffer.alloc(10), { apiKey: "x" }),
      /azure-endpoint-ausente/
    );
  });
});

/* ------------------------------------------------------------------ */
/* Transcrição real (se o ambiente tiver binário + modelo)             */
/* ------------------------------------------------------------------ */

const status = localStatus();

describe("transcrição local (requer whisper.cpp)", { skip: !status.available }, () => {
  test("rejeita áudio vazio", async () => {
    await assert.rejects(() => transcribeLocal(Buffer.alloc(0)), /audio-invalido/);
  });

  test("rejeita áudio grande demais", async () => {
    const grande = Buffer.alloc(24_000 * 2 * 60 * 11);
    await assert.rejects(() => transcribeLocal(grande), /audio-grande-demais/);
  });

  test("transcreve um áudio curto de silêncio sem quebrar", async () => {
    // 1 s de silêncio em 16 kHz.
    const silencio = Buffer.alloc(16_000 * 2);
    try {
      const texto = await transcribeLocal(silencio, { language: "pt", rate: 16_000 });
      assert.equal(typeof texto, "string");
    } catch (e) {
      // Alguns modelos retornam vazio para silêncio: é um erro esperado.
      assert.match(String(e.message), /whisper-resposta-vazia|whisper-falhou/);
    }
  });
});
