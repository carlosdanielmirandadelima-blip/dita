/**
 * Verificação pós-instalação: avisa (sem falhar) quando o Whisper local ainda
 * não está pronto. Roda depois do `npm install`.
 */
const bin = process.env.DITA_WHISPER_BIN || "";
const modelo = process.env.DITA_WHISPER_MODEL || "";

if (!bin || !modelo) {
  console.log("\n  Dica: o Whisper local ainda não foi configurado.");
  console.log("  Rode ./install.sh para compilar o whisper.cpp e baixar um modelo,");
  console.log("  ou defina DITA_WHISPER_BIN e DITA_WHISPER_MODEL no ambiente.\n");
}
