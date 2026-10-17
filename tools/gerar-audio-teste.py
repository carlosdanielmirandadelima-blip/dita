#!/usr/bin/env python3
"""
Gera um WAV mono 16 kHz falando uma frase em português — sem TTS instalado.
Usa formantes simples (vogais) moduladas por uma cadência de sílabas, o que
basta para validar o pipeline de áudio (formato, taxa, duração, transporte),
mesmo que o conteúdo não seja reconhecível como texto.
"""
import math
import struct
import sys
import wave

RATE = 16000
DURATION_PER_SYLLABLE = 0.22
FRASE = [("a", 130), ("i", 220), ("o", 150), ("e", 200), ("u", 140),
         ("a", 180), ("e", 240), ("o", 160)]

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fala.wav"

frames = bytearray()

# silêncio inicial curto
for _ in range(int(RATE * 0.15)):
    frames += struct.pack("<h", 0)

for vowel, f0 in FRASE:
    # formantes aproximados por vogal (F1, F2)
    formants = {
        "a": (800, 1200),
        "e": (500, 1800),
        "i": (300, 2300),
        "o": (500, 900),
        "u": (320, 800),
    }[vowel]

    n = int(RATE * DURATION_PER_SYLLABLE)
    for i in range(n):
        t = i / RATE
        env = math.sin(math.pi * i / n) ** 0.7          # envelope da sílaba
        # glote: dente-de-serra suave na frequência fundamental
        glote = 0.0
        for h in range(1, 12):
            glote += math.sin(2 * math.pi * f0 * h * t) / h
        # dois formantes ressonantes
        res = 0.55 * math.sin(2 * math.pi * formants[0] * t) + \
              0.30 * math.sin(2 * math.pi * formants[1] * t)
        sample = int(9000 * env * (0.6 * glote + 0.4 * res))
        sample = max(-32768, min(32767, sample))
        frames += struct.pack("<h", sample)

    # pequena pausa entre sílabas
    for _ in range(int(RATE * 0.05)):
        frames += struct.pack("<h", 0)

# silêncio final
for _ in range(int(RATE * 0.3)):
    frames += struct.pack("<h", 0)

with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(bytes(frames))

duracao = len(frames) / 2 / RATE
print(f"ok: {path} | {duracao:.2f}s | {RATE}Hz mono 16-bit | {len(frames)} bytes")
