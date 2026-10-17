import WebSocket from "ws";

// Endpoint do Azure: sempre vem da configuração do usuário.
// Antes havia aqui o endpoint de um recurso específico (com o nome do
// proprietário do projeto), o que vazava informação privada no código.
const DEFAULT_ENDPOINT = "";
const MAX_AUDIO_BYTES = 24_000 * 2 * 60 * 10;

export function endpointFromEnv(env = process.env) {
  return (env.AZURE_OPENAI_REALTIME_URL || "").trim() || DEFAULT_ENDPOINT;
}

export function pcmFromWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("audio-wav-invalido");
  }

  let format;
  let data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new Error("audio-wav-invalido");
    if (id === "fmt " && size >= 16) {
      format = {
        codec: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(start, end);
    }
    offset = end + (size % 2);
  }

  if (!format || format.codec !== 1 || format.channels !== 1 || format.rate !== 24_000 || format.bits !== 16 || !data?.length) {
    throw new Error("audio-formato-invalido");
  }
  return data;
}

export async function transcribeAzure(pcm, { apiKey, endpoint, language = "pt", timeoutMs = 90_000 } = {}) {
  if (!apiKey?.trim()) throw new Error("azure-sem-chave");
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > MAX_AUDIO_BYTES) throw new Error("audio-invalido");

  const resolved = endpoint || endpointFromEnv();
  if (!resolved) throw new Error("azure-endpoint-ausente");
  const websocketUrl = new URL(resolved);
  if (websocketUrl.protocol !== "https:" && websocketUrl.protocol !== "wss:") throw new Error("azure-url-invalida");
  websocketUrl.protocol = "wss:";

  return new Promise((resolve, reject) => {
    let settled = false;
    let configured = false;
    const ws = new WebSocket(websocketUrl, { headers: { "api-key": apiKey.trim() } });
    const timer = setTimeout(() => finish(new Error("azure-timeout")), timeoutMs);

    function finish(error, text) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      if (error) reject(error);
      else resolve(text);
    }

    function sendAudio() {
      const chunkSize = 48_000;
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm.subarray(offset, offset + chunkSize).toString("base64"),
        }));
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }

    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (event.type === "session.created") {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24_000 },
                transcription: {
                  model: "gpt-realtime-whisper",
                  language: language.split("-")[0] || "pt",
                  delay: "minimal",
                },
                turn_detection: null,
              },
            },
          },
        }));
      } else if (event.type === "session.updated" && !configured) {
        configured = true;
        sendAudio();
      } else if (event.type === "conversation.item.input_audio_transcription.completed") {
        const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
        finish(text ? null : new Error("azure-resposta-vazia"), text);
      } else if (event.type === "conversation.item.input_audio_transcription.failed") {
        finish(new Error(event.error?.message || "azure-transcricao-falhou"));
      } else if (event.type === "error") {
        finish(new Error(event.error?.message || "azure-erro"));
      }
    });
    ws.on("unexpected-response", (_request, response) => finish(new Error(`azure-http-${response.statusCode}`)));
    ws.on("error", (error) => finish(error));
    ws.on("close", () => {
      if (!settled) finish(new Error("azure-conexao-fechada"));
    });
  });
}
