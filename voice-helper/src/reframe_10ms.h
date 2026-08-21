// reframe_10ms.h — reenquadra blocos de PCM em quadros de 10ms.
//
// Existe por um achado do spike de LiveKit, rodando contra o SDK de verdade,
// não lendo documentação: `AudioSource::captureFrame` em modo de tempo real
// (`queue_size_ms = 0`) recusa qualquer tamanho que não seja EXATAMENTE 10ms —
//
//   InvalidState - direct capture requires 10ms frames: got 960, expected 480
//
// e o `AudioProcessingModule` (AEC) tem a mesma exigência. O projeto inteiro,
// porém, fala quadros de 20ms: `kFrameMs` em `voice-helper/src/main.cpp`,
// `AUDIO_*` em `skymp/gamemode/voip-service.js`, `RELAY_SAMPLE_RATE` em
// `skymp/ui/index.html`. A captura WASAPI (`OnCapture` em `main.cpp`) sempre
// entrega blocos de exatamente 20ms pela fila — ver o acumulador ali.
//
// Ver docs/technical/ADR_006_SKYVOICE_CLIENT_RTC.md ("20 ms versus 10 ms") e
// spikes/skyvoice-livekit-cpp/src/spike.cpp.
#pragma once

#include <cstdint>
#include <stdexcept>
#include <vector>

namespace skyvoice {

// Divide `samples` (exatamente `count` amostras) em quadros consecutivos de
// `samplesPerFrame10ms` amostras, na ordem em que chegaram — um corte, não
// uma reamostragem: os bytes que entram são os bytes que saem, só que em mais
// pedaços. Isso é deliberado (ver `docs/technical/VOICE_NATIVE_HELPER.md` §3:
// "os bytes que entraram são os bytes que saíram" é o que torna um formato
// cru verificável por conta, e reamostrar aqui reintroduziria exatamente a
// ambiguidade que o PCM cru existe para evitar).
//
// `samplesPerFrame10ms` é parâmetro, não constante: a 48kHz vale 480, mas
// `RunSession` já loga quando o dispositivo negocia outra taxa e o miniaudio
// reamostra — o chamador passa o valor certo pra taxa que está em uso.
//
// Lança se `count` não for múltiplo exato de `samplesPerFrame10ms`. Um bloco
// de 20ms que não é dois quadros de 10ms inteiros significa que a captura
// upstream mudou de formato sem que este arquivo soubesse — a esta altura,
// dividir o resto silenciosamente produziria áudio cortado ou embaralhado do
// outro lado; falhar alto aqui é o mesmo princípio do aviso de sample rate em
// `RunSession`.
inline std::vector<std::vector<int16_t>> ReframeTo10ms(
    const int16_t* samples, size_t count, size_t samplesPerFrame10ms) {
  if (samplesPerFrame10ms == 0 || count % samplesPerFrame10ms != 0) {
    throw std::invalid_argument(
        "ReframeTo10ms: bloco de entrada nao e multiplo exato do quadro de 10ms");
  }

  std::vector<std::vector<int16_t>> out;
  out.reserve(count / samplesPerFrame10ms);
  for (size_t offset = 0; offset < count; offset += samplesPerFrame10ms) {
    out.emplace_back(samples + offset, samples + offset + samplesPerFrame10ms);
  }
  return out;
}

}  // namespace skyvoice
