// opus_roundtrip.test.cpp — encode e decodifica com o libopus de verdade.
//
// Alvo de CMake separado, como `reframe-10ms-test`: exercita exatamente a
// configuração que `RunSession` usa em produção (OPUS_APPLICATION_VOIP,
// 48kHz mono, quadro de 960 amostras / 20ms, 24 kbit/s), sem precisar de
// microfone nem de rede — só o codec, que é a peça nova e a que mais importa
// verificar por EFEITO, não por "compilou". O papel de ouvinte real (CEF via
// WebCodecs) foi verificado à parte, num Chromium de verdade, e está
// registrado em ADR_006/VOICE_NATIVE_HELPER.md; este teste prova a metade C++.
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

#include <opus/opus.h>

namespace {

int g_failures = 0;

void Check(bool condition, const char* description) {
  if (condition) {
    std::printf("  ok: %s\n", description);
  } else {
    std::printf("  FALHOU: %s\n", description);
    ++g_failures;
  }
}

constexpr int kSampleRate = 48000;
constexpr int kChannels = 1;
constexpr int kSamplesPerFrame = 960;  // 20ms a 48kHz — o que RunSession usa
constexpr opus_int32 kBitrate = 24000;
constexpr int kMaxPacketBytes = 4000;

// Goertzel: energia numa frequência só. Mesmo método do
// `spikes/skyvoice-livekit-cpp/src/spike.cpp` — RMS sozinho não prova que
// chegou o SINAL certo, porque ruído na mesma potência dá o mesmo RMS.
double Goertzel(const std::vector<double>& x, double freq, double sample_rate) {
  const double w = 2.0 * 3.14159265358979323846 * freq / sample_rate;
  const double coeff = 2.0 * std::cos(w);
  double s1 = 0.0, s2 = 0.0;
  for (const double v : x) {
    const double s0 = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return std::sqrt(std::max(0.0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

}  // namespace

int main() {
  int err = OPUS_OK;
  OpusEncoder* enc = opus_encoder_create(kSampleRate, kChannels, OPUS_APPLICATION_VOIP, &err);
  Check(err == OPUS_OK && enc != nullptr, "encoder cria com a config de producao (VOIP, 48kHz, mono)");
  opus_encoder_ctl(enc, OPUS_SET_BITRATE(kBitrate));
  opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));

  OpusDecoder* dec = opus_decoder_create(kSampleRate, kChannels, &err);
  Check(err == OPUS_OK && dec != nullptr, "decoder cria com a mesma taxa e canais");

  // 10 quadros de 20ms = 200ms de um tom de 440Hz, amplitude 0.3 — os mesmos
  // números que o spike de LiveKit e a Fase 1 do helper já usam, pra manter
  // as bancadas comparáveis.
  constexpr int kFrames = 10;
  constexpr double kFreq = 440.0;
  constexpr double kAmplitude = 0.3;

  std::vector<int16_t> original(kSamplesPerFrame * kFrames);
  for (size_t i = 0; i < original.size(); ++i) {
    const double t = static_cast<double>(i) / kSampleRate;
    original[i] = static_cast<int16_t>(kAmplitude * 32767.0 * std::sin(2.0 * 3.14159265358979323846 * kFreq * t));
  }

  std::vector<int16_t> decoded;
  decoded.reserve(original.size());
  bool todos_encodaram = true;
  bool todos_decodaram_960 = true;
  bool nenhum_pacote_estourou_o_teto = true;

  for (int f = 0; f < kFrames; ++f) {
    const int16_t* frame_in = original.data() + f * kSamplesPerFrame;

    std::vector<unsigned char> packet(kMaxPacketBytes);
    const opus_int32 encoded_bytes = opus_encode(enc, frame_in, kSamplesPerFrame,
                                                  packet.data(), static_cast<opus_int32>(packet.size()));
    if (encoded_bytes < 0) { todos_encodaram = false; continue; }
    if (encoded_bytes > kMaxPacketBytes) nenhum_pacote_estourou_o_teto = false;
    packet.resize(static_cast<size_t>(encoded_bytes));

    std::vector<int16_t> frame_out(kSamplesPerFrame);
    const int decoded_samples = opus_decode(dec, packet.data(), static_cast<opus_int32>(packet.size()),
                                             frame_out.data(), kSamplesPerFrame, 0);
    if (decoded_samples != kSamplesPerFrame) todos_decodaram_960 = false;
    decoded.insert(decoded.end(), frame_out.begin(), frame_out.begin() + std::max(0, decoded_samples));
  }

  Check(todos_encodaram, "todo quadro de 960 amostras codifica sem erro");
  Check(nenhum_pacote_estourou_o_teto, "nenhum pacote passa de 4000 bytes (o teto que RunSession usa)");
  Check(todos_decodaram_960, "todo pacote decodifica de volta em exatamente 960 amostras");
  Check(decoded.size() == original.size(), "a sequencia decodificada tem o mesmo tamanho da original");

  // Fidelidade: Opus é com perdas, então não se compara amostra a amostra —
  // se compara ENERGIA NA FREQUÊNCIA CERTA, do mesmo jeito que o spike de
  // LiveKit prova sinal, não silêncio.
  std::vector<double> original_d(original.begin(), original.end());
  std::vector<double> decoded_d(decoded.begin(), decoded.end());
  for (auto& v : original_d) v /= 32768.0;
  for (auto& v : decoded_d) v /= 32768.0;

  const double energia_440_original = Goertzel(original_d, kFreq, kSampleRate);
  const double energia_440_decodificada = Goertzel(decoded_d, kFreq, kSampleRate);
  const double energia_1khz_controle = Goertzel(decoded_d, 1000.0, kSampleRate);

  std::printf("  medido: energia 440Hz original=%.4f decodificada=%.4f controle(1kHz)=%.4f\n",
              energia_440_original, energia_440_decodificada, energia_1khz_controle);

  Check(energia_440_decodificada > energia_440_original * 0.7,
        "a energia em 440Hz sobrevive ao encode/decode com perda (>70% da original)");
  Check(energia_440_decodificada > energia_1khz_controle * 10.0,
        "440Hz domina sobre o controle em 1kHz — chegou o SINAL, nao so energia qualquer");

  double soma_quadrados = 0.0;
  for (const double v : decoded_d) soma_quadrados += v * v;
  const double rms_decodificado = std::sqrt(soma_quadrados / decoded_d.size());
  std::printf("  medido: RMS decodificado=%.4f (teorico de uma senoide 0.3 = %.4f)\n",
              rms_decodificado, kAmplitude / std::sqrt(2.0));
  Check(rms_decodificado > 0.15 && rms_decodificado < 0.30,
        "RMS decodificado fica perto do teorico (0.212), nao silencio nem estouro");

  opus_encoder_destroy(enc);
  opus_decoder_destroy(dec);

  if (g_failures == 0) {
    std::printf("opus_roundtrip: todos os testes passaram.\n");
    return 0;
  }
  std::printf("opus_roundtrip: %d teste(s) FALHARAM.\n", g_failures);
  return 1;
}
