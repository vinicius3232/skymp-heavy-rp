// voice-helper — captura o microfone fora do CEF e manda os quadros pro
// voip-service do gamemode.
//
// Por que este processo existe: o navegador embutido do client SkyMP (CEF) não
// libera `getUserMedia`. A flag do Chromium que liberava foi *removida de
// propósito* na SkyrimPlatform 2.1, e revertê-la exporia o microfone do jogador
// a qualquer servidor SkyMP que ele conectasse depois — o client abre a URL que
// o servidor mandar. Ver docs/technical/VOICE_NATIVE_HELPER.md.
//
// A captura sai do navegador; a reprodução continua nele (tocar áudio recebido
// nunca foi bloqueado). O servidor vira relay: recebe daqui, decide por
// proximidade quem ouve e com que volume, e reenvia.
//
// ── Dois modos, e por que ambos existem ────────────────────────────────────
//
// **Pareado** (`--control-port` + `--pair`): o launcher sobe este processo ANTES
// do jogo e não conhece ticket nenhum — o ticket só existe depois que o jogador
// digita `/voz` dentro da partida. Quem o recebe é a CEF, que o entrega aqui por
// um canal de loopback autorizado pelo `pairingToken`. Nenhum segredo de
// servidor passa por `argv`, nenhum passa por arquivo.
//
// **Direto** (`--actor-id` + `--ticket`): o modo de bancada da Fase 1, mantido
// porque é o que o `tools/e2e-harness.js` e o roteiro manual usam. Remover o
// caminho legado antes de o caminho novo estar provado deixaria o projeto sem
// nenhum caminho provado.
//
// O lado do launcher está em `apps/launcher/electron/voice-dist.mjs`
// (`helperArgs`, `voiceConfigForClient`).

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#define MINIAUDIO_IMPLEMENTATION
#include <miniaudio.h>

#include <opus/opus.h>

#include <ixwebsocket/IXConnectionState.h>
#include <ixwebsocket/IXHttp.h>
#include <ixwebsocket/IXHttpServer.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

#include <nlohmann/json.hpp>

namespace {

// Formato do fio — tem que bater com AUDIO_* em skymp/gamemode/voip-service.js
// e com RELAY_SAMPLE_RATE em skymp/ui/index.html. Três lugares, um formato; se
// algum divergir o áudio sai em velocidade errada em vez de falhar limpo.
constexpr ma_uint32 kSampleRate = 48000;
constexpr ma_uint32 kChannels = 1;
constexpr ma_uint32 kFrameMs = 20;
constexpr ma_uint32 kSamplesPerFrame = kSampleRate / 1000 * kFrameMs;  // 960

// Opus, não PCM cru — Fase 2 do formato do fio (VOICE_NATIVE_HELPER.md §3).
//
// "A voz fica transparente" na documentação do próprio Opus é a 24 kbit/s pra
// fala; acima disso o ganho de qualidade não compensa o custo de banda que o
// PCM cru já provou ser caro (~1 Mbit/s de subida por locutor). A conta cai
// pra ~30 kbit/s com o overhead do base64, ainda ~30x menor que o PCM.
constexpr opus_int32 kOpusBitrate = 24000;

// Recomendação do próprio libopus para `max_data_bytes`: grande o bastante
// pra nunca truncar um quadro, mesmo em complexidade/bitrate mais alto do que
// o que pedimos hoje. Não é o tamanho típico do pacote — é o teto do buffer.
constexpr int kMaxOpusPacketBytes = 4000;

// Teto da fila entre a thread de áudio e a de rede, em quadros (~1s).
//
// Não é otimização: o callback do miniaudio roda numa thread de tempo real e
// não pode bloquear esperando a rede. Se o socket engasgar, a fila cresce; ao
// bater no teto descartamos o quadro mais ANTIGO. Numa conversa, áudio velho
// não tem valor — entregá-lo atrasado é pior do que não entregar.
constexpr size_t kMaxQueuedFrames = 50;

// Teto do corpo aceito no canal de controle. O corpo legítimo tem ~200 bytes;
// qualquer coisa maior é lixo ou tentativa de encher memória de um processo que
// roda a sessão inteira na máquina do jogador.
constexpr size_t kMaxControlBody = 4096;

// Tentativas de pareamento erradas antes de o canal parar de responder.
//
// O token tem 192 bits e não cai por força bruta; o teto existe para que uma
// tentativa em massa apareça no log em vez de rodar em silêncio, e para que um
// processo local barulhento não fique batendo aqui a partida inteira.
constexpr int kMaxPairingFailures = 10;

// Validade do pareamento, em segundos, contada do início do processo.
//
// Não são os 30 s do ticket: o ticket é credencial de servidor e é ele que tem
// vida curta. Este prazo cobre "o launcher subiu, o jogador entrou e em algum
// momento digitou `/voz`" — que pode ser meia hora depois de o jogo abrir. Um
// prazo curto aqui não fecharia furo nenhum (o canal é loopback e o segredo é
// desta execução) e produziria o sintoma mais caro que existe: a voz para de
// funcionar depois de um tempo de jogo, sem erro visível.
constexpr int64_t kDefaultPairTtlSeconds = 12 * 60 * 60;

std::atomic<bool> g_running{true};

void OnSignal(int) { g_running = false; }

int64_t NowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

// ── base64 ────────────────────────────────────────────────────────────────
// Escrito à mão em vez de puxar mais uma dependência: são 20 linhas e é o único
// uso de base64 no programa inteiro.
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string Base64Encode(const uint8_t* data, size_t len) {
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(kB64[(n >> 18) & 63]);
    out.push_back(kB64[(n >> 12) & 63]);
    out.push_back(kB64[(n >> 6) & 63]);
    out.push_back(kB64[n & 63]);
  }
  if (i < len) {
    uint32_t n = data[i] << 16;
    const bool two = (i + 1 < len);
    if (two) n |= data[i + 1] << 8;
    out.push_back(kB64[(n >> 18) & 63]);
    out.push_back(kB64[(n >> 12) & 63]);
    out.push_back(two ? kB64[(n >> 6) & 63] : '=');
    out.push_back('=');
  }
  return out;
}

// Comparação de segredo em tempo constante.
//
// `==` de std::string sai no primeiro byte diferente, e a diferença de tempo é
// medível por um processo local — que é exatamente o atacante que este canal
// tem. Comparar sempre o comprimento inteiro custa nanossegundos e remove o
// canal lateral.
bool SecretEquals(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
  }
  return diff == 0;
}

// ── fila entre a thread de áudio e a de rede ──────────────────────────────
class FrameQueue {
 public:
  void Push(std::vector<int16_t>&& frame) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (queue_.size() >= kMaxQueuedFrames) {
        queue_.pop_front();
        ++dropped_;
      }
      queue_.push_back(std::move(frame));
    }
    cv_.notify_one();
  }

  // Devolve false quando é hora de encerrar.
  bool Pop(std::vector<int16_t>& out) {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait_for(lock, std::chrono::milliseconds(100),
                 [this] { return !queue_.empty() || !g_running; });
    if (queue_.empty()) return g_running.load();
    out = std::move(queue_.front());
    queue_.pop_front();
    return true;
  }

  // Esvazia. Chamado ao trocar de sessão: quadros capturados na sessão anterior
  // não podem sair pelo socket da nova — seriam áudio de antes da reconexão
  // chegando depois dela.
  void Clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    queue_.clear();
  }

  void Wake() { cv_.notify_all(); }
  uint64_t dropped() const { return dropped_; }

 private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::vector<int16_t>> queue_;
  std::atomic<uint64_t> dropped_{0};
};

// Estado partilhado com o callback de áudio. Fica em ponteiro no
// ma_device_config::pUserData; nada aqui aloca no caminho quente além do
// vector do quadro pronto.
struct CaptureState {
  FrameQueue* queue = nullptr;
  std::vector<int16_t> accumulator;  // sobra entre callbacks
};

// Chamado pelo miniaudio numa thread de tempo real. Regra: nada de rede, nada
// de I/O, nada de lock demorado. Só acumula e empurra pra fila.
void OnCapture(ma_device* device, void* /*output*/, const void* input,
               ma_uint32 frameCount) {
  auto* state = static_cast<CaptureState*>(device->pUserData);
  if (state == nullptr || input == nullptr) return;

  const int16_t* samples = static_cast<const int16_t*>(input);
  state->accumulator.insert(state->accumulator.end(), samples, samples + frameCount);

  // O tamanho do buffer do WASAPI não é múltiplo de 20ms, então quase sempre
  // sobra um pedaço — ele fica no acumulador pro próximo callback. Cortar o
  // resto fora produziria estalos periódicos.
  while (state->accumulator.size() >= kSamplesPerFrame) {
    std::vector<int16_t> frame(state->accumulator.begin(),
                               state->accumulator.begin() + kSamplesPerFrame);
    state->accumulator.erase(state->accumulator.begin(),
                             state->accumulator.begin() + kSamplesPerFrame);
    state->queue->Push(std::move(frame));
  }
}

// ── credencial de uma sessão de voz ───────────────────────────────────────
// É isto que o pareamento produz, e é a ÚNICA coisa que o modo pareado tem em
// comum com o modo direto: depois daqui, os dois caminhos são o mesmo código.
struct SessionCredential {
  uint32_t actor_id = 0;
  std::string ticket;
  std::string host;
  uint16_t port = 0;
};

enum class Mode { kUnset, kPaired, kDirect };

struct Options {
  Mode mode = Mode::kUnset;

  // pareado
  std::string control_host = "127.0.0.1";
  uint16_t control_port = 0;
  std::string pairing_token;
  std::string log_level = "info";
  bool ptt = false;
  int64_t pair_ttl_seconds = kDefaultPairTtlSeconds;
  uint32_t parent_pid = 0;

  // direto (bancada)
  uint32_t actor_id = 0;
  std::string ticket;
  std::string host = "127.0.0.1";
  uint16_t port = 7778;

  // dispositivo de captura — vale para os dois modos
  int device_index = -1;   // -1 = padrao do sistema
  bool list_devices = false;

  bool valid = false;
  std::string error;
};

// Validação de ticket e host vindos do canal de controle.
//
// O canal é loopback e autenticado, mas o que chega por ele ainda é entrada:
// quem manda é a CEF, e a CEF renderiza o que o SERVIDOR mandar. Um servidor
// hostil não deve conseguir apontar este processo para um host arbitrário nem
// enfiar bytes de controle num JSON que vai virar linha de log.
bool IsSafeTicket(const std::string& t) {
  if (t.empty() || t.size() > 256) return false;
  for (const char c : t) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_';
    if (!ok) return false;
  }
  return true;
}

bool IsSafeHost(const std::string& h) {
  if (h.empty() || h.size() > 253) return false;
  for (const char c : h) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '.' || c == ':';
    if (!ok) return false;
  }
  return true;
}

bool IsLoopbackAddress(const std::string& ip) {
  return ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1";
}

void PrintUsage(const char* argv0) {
  std::fprintf(stderr,
    "voice-helper — captura o microfone e envia pro voip-service do SkyMP\n"
    "\n"
    "Modo pareado (o que o launcher usa):\n"
    "  %s --control-port <porta> --pair <segredo> [--ptt] [--parent-pid <pid>]\n"
    "\n"
    "  --control-host  so 127.0.0.1 (padrao). O canal nunca escuta a rede.\n"
    "  --control-port  porta de loopback do canal de controle\n"
    "  --pair          segredo desta execucao do launcher (>= 16 chars)\n"
    "  --pair-ttl      validade do pareamento em segundos (padrao 43200)\n"
    "  --ptt           declara que este cliente fala push-to-talk\n"
    "  --parent-pid    pid do launcher; o helper sai quando ele morrer\n"
    "  --log-level     info (padrao) ou debug\n"
    "\n"
    "  Neste modo NAO se passa ticket na linha de comando: ele nao existe ainda\n"
    "  quando o launcher sobe o helper. Quem o entrega e a CEF, por POST em\n"
    "  http://127.0.0.1:<porta>/ticket com {pair, actorId, ticket, host, port}.\n"
    "\n"
    "Modo direto (bancada, Fase 1):\n"
    "  %s --actor-id <id> --ticket <token> [--host <host>] [--port <porta>]\n"
    "\n"
    "  --actor-id  formID do ator, decimal ou 0x-hex (ex.: 0xFF000A12)\n"
    "  --ticket    token de uso unico emitido pelo servidor (comando /voz)\n"
    "  --host      host do voip-service (padrao: 127.0.0.1)\n"
    "  --port      porta do voip-service (padrao: 7778)\n"
    "\n"
    "O ticket vale 30 segundos e so pode ser usado uma vez.\n"
    "\n"
    "Dispositivo de captura (vale nos dois modos):\n"
    "  --list-devices    lista os microfones disponiveis, com indice, e sai\n"
    "  --device <indice> usa o microfone daquele indice em vez do padrao do SO\n"
    "\n"
    "Ver voice-helper/README.md.\n",
    argv0, argv0);
}

Options ParseArgs(int argc, char** argv) {
  Options opt;
  bool saw_paired = false;
  bool saw_direct = false;

  auto number = [](const char* s, unsigned long& out, int base = 10) {
    try {
      out = std::stoul(s, nullptr, base);
      return true;
    } catch (const std::exception&) {
      return false;
    }
  };

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const bool has_next = (i + 1 < argc);
    unsigned long n = 0;

    if (arg == "--control-host" && has_next) {
      opt.control_host = argv[++i];
      saw_paired = true;
    } else if (arg == "--control-port" && has_next) {
      if (!number(argv[++i], n) || n == 0 || n > 65535) {
        opt.error = "--control-port invalido";
        return opt;
      }
      opt.control_port = static_cast<uint16_t>(n);
      saw_paired = true;
    } else if (arg == "--pair" && has_next) {
      opt.pairing_token = argv[++i];
      saw_paired = true;
    } else if (arg == "--pair-ttl" && has_next) {
      if (!number(argv[++i], n) || n == 0) {
        opt.error = "--pair-ttl invalido";
        return opt;
      }
      opt.pair_ttl_seconds = static_cast<int64_t>(n);
      saw_paired = true;
    } else if (arg == "--parent-pid" && has_next) {
      if (!number(argv[++i], n)) {
        opt.error = "--parent-pid invalido";
        return opt;
      }
      opt.parent_pid = static_cast<uint32_t>(n);
    } else if (arg == "--ptt") {
      opt.ptt = true;
    } else if (arg == "--log-level" && has_next) {
      opt.log_level = argv[++i];
    } else if (arg == "--actor-id" && has_next) {
      // stoul base 0: aceita 0xFF000A12 e decimal. FormIDs passam de 2^31,
      // então o tipo tem que ser sem sinal — com int, 0xFF000A12 estoura.
      if (!number(argv[++i], n, 0)) {
        opt.error = "--actor-id invalido";
        return opt;
      }
      opt.actor_id = static_cast<uint32_t>(n);
      saw_direct = true;
    } else if (arg == "--ticket" && has_next) {
      opt.ticket = argv[++i];
      saw_direct = true;
    } else if (arg == "--host" && has_next) {
      opt.host = argv[++i];
      saw_direct = true;
    } else if (arg == "--port" && has_next) {
      if (!number(argv[++i], n) || n == 0 || n > 65535) {
        opt.error = "--port invalido";
        return opt;
      }
      opt.port = static_cast<uint16_t>(n);
      saw_direct = true;
    } else if (arg == "--list-devices") {
      opt.list_devices = true;
    } else if (arg == "--device" && has_next) {
      long parsed = 0;
      try {
        parsed = std::stol(argv[++i]);
      } catch (const std::exception&) {
        opt.error = "--device invalido";
        return opt;
      }
      if (parsed < 0) {
        opt.error = "--device invalido";
        return opt;
      }
      opt.device_index = static_cast<int>(parsed);
    } else if (arg == "--help" || arg == "-h") {
      return opt;
    } else {
      opt.error = "argumento desconhecido: " + arg;
      return opt;
    }
  }

  // `--list-devices` não abre microfone nem sessão de voz nenhuma — só
  // enumera e sai. Não faz sentido também exigir `--pair` ou `--ticket` pra
  // isso, então ele passa por cima da checagem de modo.
  if (opt.list_devices) {
    opt.valid = true;
    return opt;
  }

  // Os dois modos juntos seriam ambíguos: um traz o ticket pronto e o outro
  // espera por ele. Falhar aqui é melhor do que escolher um e ignorar metade
  // do que o operador pediu.
  if (saw_paired && saw_direct) {
    opt.error = "modo pareado (--pair) e modo direto (--ticket) sao exclusivos";
    return opt;
  }

  if (saw_paired) {
    opt.mode = Mode::kPaired;
    // Loopback não é configurável de fato: aceitar um bind de rede aqui seria
    // abrir um canal por onde qualquer máquina manda este processo falar.
    if (opt.control_host != "127.0.0.1" && opt.control_host != "localhost") {
      opt.error = "--control-host so aceita 127.0.0.1";
      return opt;
    }
    opt.control_host = "127.0.0.1";
    if (opt.control_port == 0) {
      opt.error = "--control-port e obrigatorio no modo pareado";
      return opt;
    }
    if (opt.pairing_token.size() < 16) {
      opt.error = "--pair curto demais para ser segredo (>= 16 chars)";
      return opt;
    }
    opt.valid = true;
    return opt;
  }

  if (saw_direct) {
    opt.mode = Mode::kDirect;
    if (opt.actor_id == 0 || opt.ticket.empty()) {
      opt.error = "--actor-id e --ticket sao obrigatorios no modo direto";
      return opt;
    }
    opt.valid = true;
    return opt;
  }

  return opt;  // sem argumento nenhum: uso
}

// ── canal de controle ─────────────────────────────────────────────────────
//
// Um servidor HTTP de uma rota só, em loopback, que existe para transportar uma
// credencial de curta duração do processo que a recebeu (a CEF) para o processo
// que precisa dela (este). Ele não expõe estado, não lê disco e não responde
// nada além de aceito/recusado.
class ControlChannel {
 public:
  ControlChannel(const Options& opt)
      : token_(opt.pairing_token),
        ttl_(opt.pair_ttl_seconds),
        started_at_(NowSeconds()),
        server_(static_cast<int>(opt.control_port), opt.control_host) {}

  bool Start() {
    server_.setOnConnectionCallback(
        [this](ix::HttpRequestPtr req, std::shared_ptr<ix::ConnectionState> state) {
          return Handle(req, state);
        });
    auto res = server_.listen();
    if (!res.first) {
      std::fprintf(stderr, "[helper] Canal de controle nao subiu: %s\n",
                   res.second.c_str());
      return false;
    }
    server_.start();
    return true;
  }

  void Stop() { server_.stop(); }

  // Espera a próxima credencial. Devolve false quando é hora de encerrar.
  //
  // "Próxima" e não "a": o jogador pode rodar `/voz` de novo depois de uma
  // reconexão, e cada `/voz` emite um ticket novo. Recusar o segundo faria a
  // voz não voltar depois de qualquer queda — exatamente o caso do §18 do
  // roteiro de testes.
  bool WaitForCredential(SessionCredential& out) {
    std::unique_lock<std::mutex> lock(mutex_);
    // `wait_for` em laço, e não `wait` com predicado: `g_running` é derrubado
    // por dois lados que NÃO seguram este mutex — o handler de SIGINT e a
    // thread que vigia o launcher. Um `wait` sem prazo dorme para sempre
    // esperando um `notify` que nenhum dos dois pode dar de forma segura.
    //
    // O sintoma era exato: matar o launcher imprimia "soltando o microfone" e o
    // processo continuava vivo, à espera de um pareamento que nunca viria.
    // Medido em 2026-08-14 — a guarda de órfão deixava um órfão.
    while (g_running && !pending_.has_value()) {
      cv_.wait_for(lock, std::chrono::milliseconds(200));
    }
    if (!pending_.has_value()) return false;
    out = *pending_;
    pending_.reset();
    return true;
  }

  // Acordado por quem estiver esperando, no encerramento.
  void Wake() { cv_.notify_all(); }

 private:
  ix::HttpResponsePtr Deny(int code, const char* motivo) {
    // Corpo mínimo e sem eco da entrada: o que chegou aqui pode ter vindo de um
    // processo que não é a CEF, e devolver o que ele mandou é como um canal de
    // teste vira um canal de conversa.
    return std::make_shared<ix::HttpResponse>(
        code, "", ix::HttpErrorCode::Ok, ix::WebSocketHttpHeaders(),
        std::string("{\"ok\":false,\"reason\":\"") + motivo + "\"}");
  }

  ix::HttpResponsePtr Handle(ix::HttpRequestPtr req,
                             std::shared_ptr<ix::ConnectionState> state) {
    // 1. Só loopback. O bind já é 127.0.0.1, mas a checagem é barata e o dia em
    //    que alguém "só para testar" trocar o bind, ela continua valendo.
    if (state && !IsLoopbackAddress(state->getRemoteIp())) {
      std::fprintf(stderr, "[helper] Pareamento recusado: origem nao-loopback.\n");
      return Deny(403, "loopback only");
    }

    // 2. Rota e método. Sem query string na comparação — `/ticket?x=1` é a
    //    mesma rota.
    const std::string uri = req ? req->uri : "";
    const std::string path = uri.substr(0, uri.find('?'));
    if (path != "/ticket") return Deny(404, "no such route");
    if (!req || req->method != "POST") return Deny(405, "POST only");

    if (req->body.size() > kMaxControlBody) return Deny(413, "body too large");

    // 3. Prazo. Ver kDefaultPairTtlSeconds para por que ele não é curto.
    if (NowSeconds() - started_at_ > ttl_) {
      std::fprintf(stderr, "[helper] Pareamento recusado: prazo expirado.\n");
      return Deny(403, "pairing expired");
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (failures_ >= kMaxPairingFailures) return Deny(429, "too many attempts");
    }

    nlohmann::json body = nlohmann::json::parse(req->body, nullptr, false);
    if (body.is_discarded() || !body.is_object()) return Fail("json invalido");

    // 4. O segredo. Comparação em tempo constante, e ANTES de olhar qualquer
    //    outro campo — um processo sem o token não deve conseguir descobrir
    //    nada sobre a forma do resto do corpo pelo motivo da recusa.
    const std::string pair = body.value("pair", std::string());
    if (!SecretEquals(pair, token_)) return Fail("pareamento invalido");

    SessionCredential cred;
    // `actorId` chega como número (é assim que o servidor o emite para a CEF),
    // mas aceitar string também evita que uma diferença de serialização
    // silencie a voz inteira.
    if (body["actorId"].is_number_unsigned()) {
      cred.actor_id = body["actorId"].get<uint32_t>();
    } else if (body["actorId"].is_number_integer()) {
      const int64_t v = body["actorId"].get<int64_t>();
      if (v <= 0 || v > 0xFFFFFFFFLL) return Fail("actorId fora de faixa");
      cred.actor_id = static_cast<uint32_t>(v);
    } else if (body["actorId"].is_string()) {
      try {
        cred.actor_id = static_cast<uint32_t>(
            std::stoul(body["actorId"].get<std::string>(), nullptr, 0));
      } catch (const std::exception&) {
        return Fail("actorId ilegivel");
      }
    } else {
      return Fail("actorId ausente");
    }
    if (cred.actor_id == 0) return Fail("actorId invalido");

    cred.ticket = body.value("ticket", std::string());
    if (!IsSafeTicket(cred.ticket)) return Fail("ticket invalido");

    cred.host = body.value("host", std::string("127.0.0.1"));
    if (cred.host.empty()) cred.host = "127.0.0.1";
    if (!IsSafeHost(cred.host)) return Fail("host invalido");

    const int64_t porta = body.value("port", static_cast<int64_t>(7778));
    if (porta <= 0 || porta > 65535) return Fail("port invalido");
    cred.port = static_cast<uint16_t>(porta);

    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending_ = cred;
      failures_ = 0;  // um pareamento certo limpa o histórico de erros
    }
    cv_.notify_all();

    // O log NÃO leva o ticket. Ele é credencial viva por 30 s, e um log é o
    // lugar mais fácil de ler de fora do processo.
    std::printf("[helper] Pareado: ator 0x%x, voip %s:%u.\n", cred.actor_id,
                cred.host.c_str(), static_cast<unsigned>(cred.port));
    std::fflush(stdout);

    return std::make_shared<ix::HttpResponse>(
        200, "", ix::HttpErrorCode::Ok, ix::WebSocketHttpHeaders(),
        std::string("{\"ok\":true}"));
  }

  // Recusa que CONTA. Separada do `Deny` porque erro de rota e erro de segredo
  // não são a mesma coisa: só o segundo é tentativa de entrar.
  ix::HttpResponsePtr Fail(const char* motivo) {
    int n;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      n = ++failures_;
    }
    std::fprintf(stderr, "[helper] Pareamento recusado (%s). Tentativa %d/%d.\n",
                 motivo, n, kMaxPairingFailures);
    if (n >= kMaxPairingFailures) {
      std::fprintf(stderr,
                   "[helper] Teto de tentativas atingido; o canal de controle "
                   "para de aceitar pareamento nesta execucao.\n");
    }
    return Deny(403, "denied");
  }

  const std::string token_;
  const int64_t ttl_;
  const int64_t started_at_;
  ix::HttpServer server_;

  std::mutex mutex_;
  std::condition_variable cv_;
  // `optional` em vez de fila: se duas credenciais chegarem antes de a sessão
  // subir, a que vale é a última — a anterior já queimou ou vai queimar.
  std::optional<SessionCredential> pending_;
  int failures_ = 0;
};

// ── guarda de órfão ───────────────────────────────────────────────────────
//
// `detached: false` no `spawn` do Electron NÃO mata o filho quando o pai morre
// no Windows — só impede que ele ganhe um console próprio. Se o launcher for
// derrubado pelo gerenciador de tarefas ou travar, este processo continuaria
// vivo com o microfone aberto e sem janela nenhuma.
//
// Esta thread é a rede de segurança para isso: ela espera o handle do pai ser
// sinalizado (o que só acontece quando ele termina) e derruba o helper junto.
void WatchParent(uint32_t parent_pid, FrameQueue* queue) {
#ifdef _WIN32
  if (parent_pid == 0) return;
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
  if (parent == nullptr) {
    const DWORD err = GetLastError();
    // Distinguir os dois motivos importa, e custou um teste para descobrir:
    //
    //   ERROR_INVALID_PARAMETER — não existe processo com esse pid. O launcher
    //   morreu entre o `spawn` e esta thread, e sair é o comportamento certo.
    //
    //   ERROR_ACCESS_DENIED — o processo existe e não podemos observá-lo.
    //   Encerrar aqui seria matar a voz de quem não tem problema nenhum; o que
    //   se perde é a guarda, não a sessão. Segue sem ela, dizendo isso em voz
    //   alta.
    if (err == ERROR_ACCESS_DENIED) {
      std::fprintf(stderr,
                   "[helper] Sem permissao para observar o launcher (pid %u); "
                   "seguindo SEM guarda de orfao.\n",
                   parent_pid);
      return;
    }
    std::fprintf(stderr,
                 "[helper] Launcher (pid %u) nao existe (erro %lu); encerrando.\n",
                 parent_pid, static_cast<unsigned long>(err));
    g_running = false;
    if (queue) queue->Wake();
    return;
  }
  while (g_running) {
    const DWORD r = WaitForSingleObject(parent, 250);
    if (r == WAIT_OBJECT_0 || r == WAIT_FAILED) {
      std::fprintf(stderr, "[helper] Launcher encerrou; soltando o microfone.\n");
      g_running = false;
      if (queue) queue->Wake();
      break;
    }
  }
  CloseHandle(parent);
#else
  (void)parent_pid;
  (void)queue;
#endif
}

// ── dispositivo de captura ────────────────────────────────────────────────
//
// Sem `--device`, o helper sempre abriu "o microfone padrão do Windows" —
// que já é o certo para a maioria, mas não dá escolha a quem tem mais de um
// microfone (headset + placa de captura, por exemplo). Enumerar não abre
// dispositivo nenhum: é um `ma_context` que só lista o que o SO já enumerou.

// Lista os microfones disponíveis, com o índice que `--device` espera, e sai
// sem abrir nenhum. Não depende de `--pair` nem `--ticket` — por isso mora
// fora de `RunSession`, que é o caminho que já assume uma sessão de voz.
int ListCaptureDevices() {
  ma_context context;
  if (ma_context_init(nullptr, 0, nullptr, &context) != MA_SUCCESS) {
    std::fprintf(stderr, "[helper] Falha ao inicializar o contexto de audio.\n");
    return 1;
  }

  ma_device_info* capture_infos = nullptr;
  ma_uint32 capture_count = 0;
  if (ma_context_get_devices(&context, nullptr, nullptr, &capture_infos, &capture_count) != MA_SUCCESS) {
    std::fprintf(stderr, "[helper] Falha ao enumerar dispositivos de captura.\n");
    ma_context_uninit(&context);
    return 1;
  }

  if (capture_count == 0) {
    std::fprintf(stderr, "[helper] Nenhum dispositivo de captura encontrado.\n");
  } else {
    std::fprintf(stderr, "Microfones disponiveis:\n");
    for (ma_uint32 i = 0; i < capture_count; ++i) {
      std::fprintf(stderr, "  [%u]%s %s\n", i,
                   capture_infos[i].isDefault ? " (padrao)" : "     ",
                   capture_infos[i].name);
    }
    std::fprintf(stderr, "Use --device <indice> pra escolher um. Sem --device, usa o padrao do SO.\n");
  }

  ma_context_uninit(&context);
  return 0;
}

// Traduz um índice de `--list-devices` para o `ma_device_id` que o miniaudio
// entende. O `ma_context` é fechado aqui dentro — `ma_device_id` é uma union
// simples, copiável por valor, então sobrevive ao `ma_context_uninit`.
bool ResolveCaptureDevice(int index, ma_device_id* out_id, std::string& error) {
  ma_context context;
  if (ma_context_init(nullptr, 0, nullptr, &context) != MA_SUCCESS) {
    error = "falha ao inicializar o contexto de audio";
    return false;
  }
  ma_device_info* capture_infos = nullptr;
  ma_uint32 capture_count = 0;
  const ma_result r = ma_context_get_devices(&context, nullptr, nullptr, &capture_infos, &capture_count);
  if (r != MA_SUCCESS) {
    ma_context_uninit(&context);
    error = "falha ao enumerar dispositivos de captura";
    return false;
  }
  if (index < 0 || static_cast<ma_uint32>(index) >= capture_count) {
    ma_context_uninit(&context);
    error = "--device fora do intervalo (use --list-devices pra ver os indices)";
    return false;
  }
  *out_id = capture_infos[static_cast<ma_uint32>(index)].id;
  ma_context_uninit(&context);
  return true;
}

// ── encoder Opus ──────────────────────────────────────────────────────────
//
// RAII de propósito: `RunSession` tem vários `return` cedo (falha ao abrir
// microfone, falha ao iniciar captura, auth recusada...) e sem isto cada um
// precisaria lembrar de `opus_encoder_destroy` — o tipo de duplicação que vira
// vazamento na primeira alteração que esquece um dos pontos de saída.
class OpusEncoderGuard {
 public:
  OpusEncoderGuard(ma_uint32 sample_rate, ma_uint32 channels, opus_int32 bitrate) {
    int err = OPUS_OK;
    enc_ = opus_encoder_create(static_cast<opus_int32>(sample_rate),
                               static_cast<int>(channels), OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK) {
      enc_ = nullptr;
      error_ = opus_strerror(err);
      return;
    }
    opus_encoder_ctl(enc_, OPUS_SET_BITRATE(bitrate));
    // VOIP como aplicação já assume fala, não música — mas declarar o sinal
    // explicitamente evita depender do padrão implícito de uma libopus futura.
    opus_encoder_ctl(enc_, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
  }

  ~OpusEncoderGuard() {
    if (enc_) opus_encoder_destroy(enc_);
  }

  OpusEncoderGuard(const OpusEncoderGuard&) = delete;
  OpusEncoderGuard& operator=(const OpusEncoderGuard&) = delete;

  bool ok() const { return enc_ != nullptr; }
  const std::string& error() const { return error_; }
  OpusEncoder* get() const { return enc_; }

 private:
  OpusEncoder* enc_ = nullptr;
  std::string error_;
};

// ── uma sessão de voz ─────────────────────────────────────────────────────
//
// Abre o microfone, conecta, autentica e transmite até cair. Devolve quando a
// sessão termina — por queda, por recusa, ou porque o processo está saindo.
//
// O microfone é aberto AQUI, e não no início do processo. No modo pareado o
// helper sobe junto com o jogo e pode ficar horas sem ninguém rodar `/voz`;
// manter o WASAPI aberto esse tempo todo seria um microfone ligado sem sessão
// de voz nenhuma — indefensável, e o tipo de coisa que se descobre pelo ícone
// de microfone do Windows.
struct SessionResult {
  bool auth_failed = false;
  uint64_t frames_sent = 0;
};

SessionResult RunSession(const SessionCredential& cred, bool declara_ptt,
                         FrameQueue& queue, CaptureState& capture_state,
                         std::atomic<bool>& sessao_ativa,
                         const ma_device_id* capture_device_id = nullptr) {
  SessionResult result;

  OpusEncoderGuard opus_encoder(kSampleRate, kChannels, kOpusBitrate);
  if (!opus_encoder.ok()) {
    std::fprintf(stderr, "[helper] Falha ao criar o encoder Opus: %s\n",
                 opus_encoder.error().c_str());
    return result;
  }

  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.format = ma_format_s16;
  config.capture.channels = kChannels;
  // Compartilhado, não exclusivo: em modo exclusivo o helper tomaria o
  // dispositivo do resto do sistema, e o jogador perderia o áudio do Discord,
  // do navegador e de qualquer outra coisa enquanto joga.
  config.capture.shareMode = ma_share_mode_shared;
  // nullptr = o padrão do SO, igual sempre foi. Só passa a apontar pra outro
  // quando o operador pediu `--device`.
  config.capture.pDeviceID = capture_device_id;
  config.sampleRate = kSampleRate;
  config.dataCallback = OnCapture;
  config.pUserData = &capture_state;

  ma_device device;
  if (ma_device_init(nullptr, &config, &device) != MA_SUCCESS) {
    std::fprintf(stderr, "[helper] Falha ao abrir o microfone%s.\n",
                 capture_device_id ? " escolhido (--device)" : " padrao");
    return result;
  }

  // O que o miniaudio realmente conseguiu negociar pode não ser o que pedimos.
  // O servidor e a UI assumem 48kHz mono fixo, então divergência aqui viraria
  // áudio em velocidade errada do outro lado — falhar alto é melhor.
  if (device.capture.internalSampleRate != kSampleRate) {
    std::fprintf(stderr,
      "[helper] Aviso: dispositivo em %u Hz; miniaudio esta reamostrando pra %u Hz.\n",
      device.capture.internalSampleRate, kSampleRate);
  }

  // Mesma porta e mesmo handshake por ticket que o index.html já usa. Inventar
  // um segundo sistema de autenticação pra mesma coisa seria dobrar a
  // superfície de ataque em troca de nada.
  const std::string url =
      "ws://" + cred.host + ":" + std::to_string(cred.port);
  ix::WebSocket ws;
  ws.setUrl(url);
  ws.disableAutomaticReconnection();  // ticket e de uso unico: reconectar sozinho falharia

  std::atomic<bool> authed{false};
  std::atomic<bool> encerrada{false};

  ws.setOnMessageCallback([&](const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Open) {
      std::printf("[helper] Conectado em %s; autenticando como sender.\n", url.c_str());
      // `role: "sender"` é o que permite este processo coexistir com o
      // index.html do MESMO jogador. Sem o campo o servidor assume "listener"
      // (o padrão de compatibilidade), e as duas conexões brigariam pelo mesmo
      // slot — quem autenticasse por último derrubaria o outro. O ticket também
      // é por papel: o `/voz` emite um pra UI e um pro helper.
      // Ver docs/technical/VOICE_NATIVE_HELPER.md §10.
      //
      // `ptt` declara que este cliente é governado por push-to-talk. Um cliente
      // que não declara recebe do servidor uma concessão de microfone aberto,
      // por compatibilidade com o helper da Fase 1 (voip-service.js §auth) —
      // que é justamente a dívida que o launcher fecha ao passar `--ptt`.
      nlohmann::json auth{{"type", "auth"},
                          {"actorId", cred.actor_id},
                          {"ticket", cred.ticket},
                          {"role", "sender"}};
      if (declara_ptt) auth["ptt"] = true;
      ws.send(auth.dump());
    } else if (msg->type == ix::WebSocketMessageType::Message) {
      nlohmann::json parsed = nlohmann::json::parse(msg->str, nullptr, false);
      if (parsed.is_discarded() || !parsed.contains("type")) return;
      const std::string type = parsed["type"].get<std::string>();
      if (type == "auth_ok") {
        authed = true;
        std::printf("[helper] Autenticado%s. Capturando.\n",
                    declara_ptt ? " (PTT)" : "");
      } else if (type == "auth_failed") {
        result.auth_failed = true;
        std::fprintf(stderr,
          "[helper] Auth recusada. O ticket vale 30s e so serve uma vez — "
          "rode /voz de novo.\n");
        encerrada = true;
        queue.Wake();
      }
      // proximity_update / audio_frame chegam aqui tambem e sao ignorados de
      // proposito: quem toca audio e o navegador do jogo, nao este processo.
    } else if (msg->type == ix::WebSocketMessageType::Error) {
      std::fprintf(stderr, "[helper] Erro de socket: %s\n",
                   msg->errorInfo.reason.c_str());
      encerrada = true;
      queue.Wake();
    } else if (msg->type == ix::WebSocketMessageType::Close) {
      std::fprintf(stderr, "[helper] Conexao fechada pelo servidor.\n");
      encerrada = true;
      queue.Wake();
    }
  });

  ws.start();

  if (ma_device_start(&device) != MA_SUCCESS) {
    std::fprintf(stderr, "[helper] Falha ao iniciar a captura.\n");
    ma_device_uninit(&device);
    ws.stop();
    return result;
  }

  sessao_ativa = true;
  uint64_t seq = 0;
  std::vector<int16_t> frame;

  while (g_running && !encerrada) {
    if (!queue.Pop(frame) || frame.empty()) continue;

    // Quadros capturados antes do auth_ok são descartados: o servidor os
    // ignoraria de qualquer forma, e guardá-los só adicionaria atraso à
    // primeira sílaba que alguém de fato ouvir.
    if (!authed) { frame.clear(); continue; }

    // `frame.size()` é sempre exatamente `kSamplesPerFrame` (960 = 20ms a
    // 48kHz) — é a garantia do acumulador em `OnCapture`, e 960 é um dos
    // tamanhos de quadro que o Opus aceita nativamente a 48kHz. Nenhum
    // reenquadramento entra aqui (isso é outra fronteira — ver
    // `reframe_10ms.h` e `ADR_006_SKYVOICE_CLIENT_RTC.md`).
    std::array<unsigned char, kMaxOpusPacketBytes> opus_buf;
    const opus_int32 encoded = opus_encode(
        opus_encoder.get(), frame.data(), static_cast<int>(frame.size()),
        opus_buf.data(), static_cast<opus_int32>(opus_buf.size()));
    if (encoded < 0) {
      // Um quadro que falha ao codificar não pode derrubar a sessão inteira —
      // é o mesmo princípio do `decodeRelayFrame` do lado do ouvinte, que
      // descarta um quadro ilegível em vez de fechar o socket.
      std::fprintf(stderr, "[helper] Falha ao codificar quadro em Opus: %s\n",
                   opus_strerror(encoded));
      frame.clear();
      continue;
    }

    const std::string data =
        Base64Encode(opus_buf.data(), static_cast<size_t>(encoded));

    // `codec` explícito, não implícito por porta ou versão: um `voice-helper`
    // antigo em campo (como o que já foi baixado e testado contra produção)
    // continua mandando PCM cru sem este campo, e `decodeRelayFrame` do lado
    // do ouvinte decide pelo que está no quadro, não pela versão do binário.
    nlohmann::json out{{"type", "audio_frame"}, {"seq", seq++},
                        {"codec", "opus"}, {"data", data}};
    ws.send(out.dump());
    frame.clear();

    if (++result.frames_sent % 250 == 0) {  // ~5s
      std::printf("[helper] %llu quadros enviados (%llu descartados na fila).\n",
                  static_cast<unsigned long long>(result.frames_sent),
                  static_cast<unsigned long long>(queue.dropped()));
      std::fflush(stdout);
    }
  }

  sessao_ativa = false;
  // O microfone fecha COM a sessão. É a mesma regra da abertura tardia, do
  // outro lado: acabou a sessão de voz, acabou a captura.
  ma_device_uninit(&device);
  ws.stop();
  queue.Clear();
  return result;
}

}  // namespace

int main(int argc, char** argv) {
  const Options opt = ParseArgs(argc, argv);
  if (!opt.valid) {
    if (!opt.error.empty()) std::fprintf(stderr, "[helper] %s\n", opt.error.c_str());
    PrintUsage(argv[0]);
    return 2;
  }

  if (opt.list_devices) {
    // Enumerar não precisa de rede, de sinal nem de fila — sai direto.
    return ListCaptureDevices();
  }

  ma_device_id resolved_device_id{};
  const ma_device_id* capture_device_id = nullptr;
  if (opt.device_index >= 0) {
    std::string device_error;
    if (!ResolveCaptureDevice(opt.device_index, &resolved_device_id, device_error)) {
      std::fprintf(stderr, "[helper] %s\n", device_error.c_str());
      return 2;
    }
    capture_device_id = &resolved_device_id;
  }

  std::signal(SIGINT, OnSignal);
  std::signal(SIGTERM, OnSignal);

  ix::initNetSystem();

  FrameQueue queue;
  CaptureState capture_state;
  capture_state.queue = &queue;
  capture_state.accumulator.reserve(kSamplesPerFrame * 4);
  std::atomic<bool> sessao_ativa{false};

  std::thread guarda;
  if (opt.parent_pid != 0) {
    guarda = std::thread(WatchParent, opt.parent_pid, &queue);
  }

  int exit_code = 0;

  if (opt.mode == Mode::kDirect) {
    // Bancada: a credencial já veio pronta, uma sessão só, Ctrl+C pra sair.
    SessionCredential cred{opt.actor_id, opt.ticket, opt.host, opt.port};
    std::printf("[helper] Modo direto (bancada). Ctrl+C pra sair.\n");
    const SessionResult r = RunSession(cred, opt.ptt, queue, capture_state, sessao_ativa, capture_device_id);
    std::printf("[helper] Encerrando. %llu quadros enviados.\n",
                static_cast<unsigned long long>(r.frames_sent));
    exit_code = r.auth_failed ? 1 : 0;
  } else {
    ControlChannel canal(opt);
    if (!canal.Start()) {
      // Porta ocupada quase sempre significa OUTRO helper vivo — de uma sessão
      // anterior que não morreu. Subir mesmo assim daria dois processos com o
      // microfone e um pareamento que vai para o errado.
      ix::uninitNetSystem();
      g_running = false;
      if (guarda.joinable()) guarda.join();
      return 1;
    }
    std::printf(
        "[helper] Canal de controle em http://127.0.0.1:%u/ticket. "
        "Aguardando /voz.\n",
        static_cast<unsigned>(opt.control_port));
    std::fflush(stdout);

    // O laço é a reconexão: cada `/voz` do jogador produz uma credencial nova, e
    // entre uma sessão e outra este processo fica vivo, sem microfone aberto e
    // sem socket.
    while (g_running) {
      SessionCredential cred;
      if (!canal.WaitForCredential(cred)) break;
      const SessionResult r = RunSession(cred, opt.ptt, queue, capture_state, sessao_ativa, capture_device_id);
      std::printf("[helper] Sessao encerrada. %llu quadros enviados.%s\n",
                  static_cast<unsigned long long>(r.frames_sent),
                  g_running ? " Aguardando novo /voz." : "");
      std::fflush(stdout);
    }

    canal.Wake();
    canal.Stop();
  }

  g_running = false;
  queue.Wake();
  if (guarda.joinable()) guarda.join();
  ix::uninitNetSystem();
  return exit_code;
}
