// SPIKE — cliente LiveKit em C++, o caminho que o voice-helper vai seguir.
//
// Isto NÃO é produção e não vive dentro do `voice-helper/`. Ele existe para
// responder, com um SFU de verdade do outro lado, três perguntas que nenhuma
// leitura de cabeçalho responde:
//
//   1. o `client-sdk-cpp` pré-compilado linka e roda contra o nosso toolchain?
//   2. `publish` de A chega em B como ÁUDIO, e não só como evento?
//   3. `mute()`/`unmute()` do PTT produzem silêncio e volta de sinal MEDIDOS,
//      sem reconectar à sala?
//
// Por que ele é dirigido por stdin em vez de fazer tudo sozinho: quem decide
// audiência é o Voice Core, que é JavaScript. Um spike que medisse sozinho só
// conseguiria provar o transporte. Recebendo comandos, o mesmo binário serve
// para o spike de transporte, para o de microfone humano e para o de plano de
// controle — onde o `livekit-gateway.js` concede a assinatura ENTRE duas
// medições e a diferença entre elas é a prova.
//
// Nenhum segredo entra por argv (regra dura do projeto): a configuração, os
// tokens inclusive, chega por UMA linha de JSON no stdin. Ver run-spike.mjs.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <livekit/livekit.h>
#include <nlohmann/json.hpp>

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 1;

// 10 ms, e NÃO os 20 ms do caminho legado.
//
// Isto foi descoberto rodando, não lendo: com `queue_size_ms = 0` (modo de
// tempo real), `AudioSource::captureFrame` recusa qualquer outro tamanho —
//
//   InvalidState - direct capture requires 10ms frames: got 960, expected 480
//
// Importa muito além do spike. O projeto inteiro fala 20 ms: `kFrameMs` no
// `voice-helper/src/main.cpp`, o `AUDIO_*` do `voip-service.js` e o
// `RELAY_SAMPLE_RATE` do `index.html`. A migração do helper vai ter que
// reenquadrar de 20 ms para 10 ms na fronteira do LiveKit — ou usar
// `queue_size_ms > 0`, que amortece mas adiciona atraso. O `AudioProcessingModule`
// (AEC) tem a mesma exigência de 10 ms, então 10 é o número da casa.
constexpr int kFrameMs = 10;
constexpr int kSamplesPerFrame = kSampleRate / 1000 * kFrameMs;  // 480
constexpr double kPi = 3.14159265358979323846;

// O tom de referência. 440 Hz por nenhum motivo musical: é a frequência que o
// spike Node já usa, e manter as duas bancadas na mesma nota deixa os números
// comparáveis entre os dois transportes.
constexpr double kToneHz = 440.0;
constexpr double kControlHz = 1000.0;
constexpr double kToneAmplitude = 0.3;

std::atomic<bool> g_running{true};

// ── medição ───────────────────────────────────────────────────────────────
//
// Acumula o que chega de UMA faixa remota. Tudo aqui é medida de EFEITO: o
// projeto já foi mordido por um `UpdateSubscriptions` que devolvia 200 e não
// assinava nada, então "o objeto de assinatura existe" não conta como prova.
class Meter {
 public:
  void OnFrame(const livekit::AudioFrame& frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    ++frames_;
    samples_.insert(samples_.end(), frame.data().begin(), frame.data().end());
  }

  // Zera e devolve o que foi acumulado desde o último corte. Medir por janela,
  // e não desde o início, é o que permite comparar "antes" e "depois" de uma
  // ordem — que é a única forma de evidência que este projeto aceita.
  struct Window {
    uint64_t frames = 0;
    size_t samples = 0;
    double rms = 0.0;
    double tone_energy = 0.0;
    double control_energy = 0.0;
  };

  Window Cut() {
    std::vector<int16_t> taken;
    Window w;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      w.frames = frames_;
      frames_ = 0;
      taken.swap(samples_);
    }
    w.samples = taken.size();
    if (taken.empty()) return w;

    double sum_sq = 0.0;
    for (const int16_t v : taken) {
      const double s = v / 32768.0;
      sum_sq += s * s;
    }
    w.rms = std::sqrt(sum_sq / static_cast<double>(taken.size()));
    w.tone_energy = Goertzel(taken, kToneHz);
    w.control_energy = Goertzel(taken, kControlHz);
    return w;
  }

 private:
  // Goertzel: energia numa frequência só, sem FFT e sem dependência nova.
  //
  // Ele existe porque RMS sozinho não prova que chegou o SINAL certo — ruído
  // branco na mesma potência dá o mesmo RMS. Comparar a energia em 440 Hz com
  // a de 1 kHz (onde não há nada) é o que separa "chegou áudio" de "chegou o
  // áudio que A mandou".
  static double Goertzel(const std::vector<int16_t>& x, double freq) {
    const double w = 2.0 * kPi * freq / kSampleRate;
    const double coeff = 2.0 * std::cos(w);
    double s1 = 0.0;
    double s2 = 0.0;
    for (const int16_t v : x) {
      const double s0 = v / 32768.0 + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return std::sqrt(std::max(0.0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
  }

  std::mutex mutex_;
  uint64_t frames_ = 0;
  std::vector<int16_t> samples_;
};

// ── delegate ──────────────────────────────────────────────────────────────
//
// O ouvinte precisa saber QUANDO a faixa foi assinada para pendurar o callback
// de quadro. Com `auto_subscribe = false` isso só acontece depois de o Voice
// Core mandar — que é exatamente o instante que o spike de plano de controle
// quer observar.
class ListenerDelegate : public livekit::RoomDelegate {
 public:
  ListenerDelegate(Meter* meter, std::string speaker_identity)
      : meter_(meter), speaker_identity_(std::move(speaker_identity)) {}

  void onTrackSubscribed(livekit::Room& room,
                         const livekit::TrackSubscribedEvent& ev) override {
    if (!ev.track || ev.track->kind() != livekit::TrackKind::KIND_AUDIO) return;
    subscribed_ = true;
    std::fprintf(stderr, "[spike] B assinou faixa %s de %s\n",
                 ev.track->sid().c_str(), speaker_identity_.c_str());
    room.setOnAudioFrameCallback(
        speaker_identity_, ev.track->name(),
        [this](const livekit::AudioFrame& f) { meter_->OnFrame(f); });
  }

  void onTrackUnsubscribed(livekit::Room&,
                           const livekit::TrackUnsubscribedEvent&) override {
    subscribed_ = false;
    std::fprintf(stderr, "[spike] B perdeu a assinatura.\n");
  }

  void onDisconnected(livekit::Room&,
                      const livekit::DisconnectedEvent&) override {
    std::fprintf(stderr, "[spike] B desconectou.\n");
  }

  bool subscribed() const { return subscribed_.load(); }

 private:
  Meter* meter_;
  std::string speaker_identity_;
  std::atomic<bool> subscribed_{false};
};

// ── gerador de tom ────────────────────────────────────────────────────────
//
// Um seno não é "PCM inventado" no sentido que a diretriz proíbe: o que está
// sob teste é o caminho RTC, e o seno é o único sinal cuja chegada dá para
// AFIRMAR por medida em vez de por opinião. O microfone real é o spike
// seguinte (--mic), e é ele que precisa de ouvido humano.
void ToneThread(std::shared_ptr<livekit::AudioSource> source) {
  double phase = 0.0;
  const double step = 2.0 * kPi * kToneHz / kSampleRate;
  auto next = std::chrono::steady_clock::now();

  while (g_running) {
    livekit::AudioFrame frame =
        livekit::AudioFrame::create(kSampleRate, kChannels, kSamplesPerFrame);
    auto& data = frame.data();
    for (int i = 0; i < kSamplesPerFrame; ++i) {
      data[static_cast<size_t>(i)] =
          static_cast<int16_t>(std::sin(phase) * kToneAmplitude * 32767.0);
      phase += step;
      if (phase > 2.0 * kPi) phase -= 2.0 * kPi;
    }
    try {
      source->captureFrame(frame, kFrameMs * 2);
    } catch (const std::exception& e) {
      std::fprintf(stderr, "[spike] captureFrame falhou: %s\n", e.what());
      return;
    }
    // Ritmo de tempo real. Sem isto o spike despejaria a fila inteira de uma
    // vez e a medição de "quadros por segundo" no ouvinte não significaria nada.
    next += std::chrono::milliseconds(kFrameMs);
    std::this_thread::sleep_until(next);
  }
}

void PrintResult(const nlohmann::json& j) {
  // Uma linha, prefixada, em stdout. O runner Node lê isto; tudo o mais vai
  // para stderr, para que log e resultado não se misturem.
  std::printf("RESULT %s\n", j.dump().c_str());
  std::fflush(stdout);
}

}  // namespace

int main() {
  // Configuração por stdin, UMA linha de JSON. Nenhum token em argv.
  std::string config_line;
  if (!std::getline(std::cin, config_line)) {
    std::fprintf(stderr, "[spike] Nada no stdin; esperava a linha de config.\n");
    return 2;
  }

  nlohmann::json cfg = nlohmann::json::parse(config_line, nullptr, false);
  if (cfg.is_discarded() || !cfg.is_object()) {
    std::fprintf(stderr, "[spike] Config invalida.\n");
    return 2;
  }

  const std::string url = cfg.value("url", std::string());
  const std::string token_a = cfg.value("tokenA", std::string());
  const std::string token_b = cfg.value("tokenB", std::string());
  const std::string identity_a = cfg.value("identityA", std::string());
  const std::string track_name = cfg.value("trackName", std::string("skyvoice-mic"));
  const bool auto_subscribe = cfg.value("autoSubscribe", true);
  const bool use_mic = cfg.value("mic", false);
  const bool use_playout = cfg.value("playout", false);

  if (url.empty() || token_a.empty() || token_b.empty() || identity_a.empty()) {
    std::fprintf(stderr, "[spike] Config incompleta.\n");
    return 2;
  }

  if (!livekit::initialize(livekit::LogLevel::Warn)) {
    std::fprintf(stderr, "[spike] livekit::initialize falhou.\n");
    return 2;
  }

  Meter meter;
  ListenerDelegate listener(&meter, identity_a);

  livekit::Room room_a;
  livekit::Room room_b;
  room_b.setDelegate(&listener);

  livekit::RoomOptions opt_a;
  livekit::RoomOptions opt_b;
  // O ouvinte é quem herda a decisão do Voice Core. Com `auto_subscribe=false`
  // ele entra na sala e NÃO ouve ninguém até o servidor mandar — que é o
  // desenho de produção (§18) e o que o spike de plano de controle mede.
  opt_b.auto_subscribe = auto_subscribe;

  if (!room_a.connect(url, token_a, opt_a)) {
    std::fprintf(stderr, "[spike] A nao conectou.\n");
    return 1;
  }
  if (!room_b.connect(url, token_b, opt_b)) {
    std::fprintf(stderr, "[spike] B nao conectou.\n");
    return 1;
  }
  std::fprintf(stderr, "[spike] A e B conectados em %s.\n", url.c_str());

  // ── o lado que fala ─────────────────────────────────────────────────────
  std::shared_ptr<livekit::AudioSource> tone_source;
  std::shared_ptr<livekit::PlatformAudio> platform_a;
  std::shared_ptr<livekit::LocalAudioTrack> track;
  std::thread tone_thread;

  try {
    if (use_mic) {
      // Microfone REAL, pelo Audio Device Module do WebRTC — com AEC, supressão
      // de ruído e AGC, que o caminho legado nunca teve.
      platform_a = std::make_shared<livekit::PlatformAudio>();
      const auto devices = platform_a->recordingDevices();
      std::fprintf(stderr, "[spike] %zu dispositivo(s) de captura:\n", devices.size());
      for (const auto& d : devices) {
        std::fprintf(stderr, "  [%u] %s\n", d.index, d.name.c_str());
      }
      if (devices.empty()) {
        std::fprintf(stderr, "[spike] Nenhum microfone; nao da para rodar --mic.\n");
        return 1;
      }
      auto src = platform_a->createAudioSource(livekit::PlatformAudioOptions{});
      track = livekit::LocalAudioTrack::createLocalAudioTrack(track_name, src);
    } else {
      // queue_size_ms = 0: modo de tempo real. A thread do tom já entrega no
      // ritmo do relógio; um buffer aqui só adicionaria atraso e mascararia
      // um produtor fora de compasso, que é justamente o que se quer ver.
      tone_source = std::make_shared<livekit::AudioSource>(kSampleRate, kChannels, 0);
      track = livekit::LocalAudioTrack::createLocalAudioTrack(track_name, tone_source);
    }

    livekit::TrackPublishOptions pub;
    pub.source = livekit::TrackSource::SOURCE_MICROPHONE;

    auto local = room_a.localParticipant().lock();
    if (!local) {
      std::fprintf(stderr, "[spike] A sem localParticipant.\n");
      return 1;
    }
    local->publishTrack(track, pub);
    std::fprintf(stderr, "[spike] A publicou '%s'.\n", track_name.c_str());
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[spike] Falha ao publicar: %s\n", e.what());
    return 1;
  }

  if (tone_source) tone_thread = std::thread(ToneThread, tone_source);

  // ── o lado que ouve ─────────────────────────────────────────────────────
  std::shared_ptr<livekit::PlatformAudio> platform_b;
  if (use_playout) {
    try {
      // Playout real: o que B recebe sai no fone. É o que o spike humano usa.
      platform_b = std::make_shared<livekit::PlatformAudio>();
      const auto devices = platform_b->playoutDevices();
      std::fprintf(stderr, "[spike] %zu dispositivo(s) de saida:\n", devices.size());
      for (const auto& d : devices) {
        std::fprintf(stderr, "  [%u] %s\n", d.index, d.name.c_str());
      }
    } catch (const std::exception& e) {
      std::fprintf(stderr, "[spike] Playout indisponivel: %s\n", e.what());
    }
  }

  PrintResult({{"event", "ready"},
               {"trackSid", track ? track->sid() : std::string()},
               {"autoSubscribe", auto_subscribe}});

  // ── laço de comandos ────────────────────────────────────────────────────
  //
  // MEASURE <ms> — corta uma janela e devolve o que chegou nela
  // MUTE / UNMUTE — o PTT, pela operação oficial (sem reconectar)
  // QUIT
  std::string line;
  int exit_code = 0;
  while (g_running && std::getline(std::cin, line)) {
    if (line.rfind("MEASURE", 0) == 0) {
      int ms = 2000;
      try {
        ms = std::stoi(line.substr(7));
      } catch (const std::exception&) {
        ms = 2000;
      }
      meter.Cut();  // descarta o acumulado: a janela começa AGORA
      std::this_thread::sleep_for(std::chrono::milliseconds(ms));
      const Meter::Window w = meter.Cut();
      PrintResult({{"event", "measure"},
                   {"windowMs", ms},
                   {"frames", w.frames},
                   {"samples", w.samples},
                   {"rms", w.rms},
                   {"toneEnergy", w.tone_energy},
                   {"controlEnergy", w.control_energy},
                   {"subscribed", listener.subscribed()}});
    } else if (line == "MUTE") {
      try {
        track->mute();
        PrintResult({{"event", "muted"}});
      } catch (const std::exception& e) {
        PrintResult({{"event", "error"}, {"op", "mute"}, {"message", e.what()}});
        exit_code = 1;
      }
    } else if (line == "UNMUTE") {
      try {
        track->unmute();
        PrintResult({{"event", "unmuted"}});
      } catch (const std::exception& e) {
        PrintResult({{"event", "error"}, {"op", "unmute"}, {"message", e.what()}});
        exit_code = 1;
      }
    } else if (line == "QUIT") {
      break;
    }
  }

  g_running = false;
  if (tone_thread.joinable()) tone_thread.join();
  room_a.disconnect();
  room_b.disconnect();
  livekit::shutdown();
  return exit_code;
}
