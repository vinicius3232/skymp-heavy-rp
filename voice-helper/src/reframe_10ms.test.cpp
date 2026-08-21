// reframe_10ms.test.cpp — testa reframe_10ms.h isoladamente.
//
// Alvo de CMake separado e de propósito: esta lógica não depende de miniaudio
// nem de ixwebsocket, e amarrar o teste ao executável principal obrigaria
// linkar WASAPI e o cliente de WebSocket só para verificar um corte de
// vetor. `assert` simples em vez de um framework de teste — é um arquivo, e
// puxar Catch2/gtest pra isto pesaria mais que o que se está testando.
#include <cassert>
#include <cstdio>
#include <cstdint>
#include <numeric>
#include <vector>

#include "reframe_10ms.h"

using skyvoice::ReframeTo10ms;

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

std::vector<int16_t> Quadro20ms(int16_t base) {
  // 960 amostras (20ms a 48kHz), cada uma com um valor distinto e
  // rastreável — assim um reordenamento ou um corte no lugar errado aparece
  // como um número errado em vez de "parece silêncio".
  std::vector<int16_t> v(960);
  for (size_t i = 0; i < v.size(); ++i) v[i] = static_cast<int16_t>(base + static_cast<int>(i));
  return v;
}

}  // namespace

int main() {
  {
    const auto entrada = Quadro20ms(0);
    const auto saida = ReframeTo10ms(entrada.data(), entrada.size(), 480);

    Check(saida.size() == 2, "960 amostras a 480/quadro vira exatamente 2 quadros");
    Check(saida[0].size() == 480 && saida[1].size() == 480,
          "os dois quadros de saida tem 480 amostras cada");

    bool primeira_metade_intacta = true;
    for (size_t i = 0; i < 480; ++i) {
      if (saida[0][i] != entrada[i]) primeira_metade_intacta = false;
    }
    Check(primeira_metade_intacta, "o primeiro quadro de 10ms e a primeira metade, sem reordenar");

    bool segunda_metade_intacta = true;
    for (size_t i = 0; i < 480; ++i) {
      if (saida[1][i] != entrada[480 + i]) segunda_metade_intacta = false;
    }
    Check(segunda_metade_intacta, "o segundo quadro de 10ms e a segunda metade, sem reordenar");
  }

  {
    // Nenhuma amostra perdida nem duplicada: soma de entrada bate com a soma
    // dos dois quadros de saida concatenados. Uma prova mais barata que
    // comparar amostra a amostra de novo, mas pegando um erro diferente —
    // duplicação ou perda no meio do corte, não só na borda.
    const auto entrada = Quadro20ms(1000);
    const auto saida = ReframeTo10ms(entrada.data(), entrada.size(), 480);
    const long long soma_entrada = std::accumulate(entrada.begin(), entrada.end(), 0LL);
    const long long soma_saida =
        std::accumulate(saida[0].begin(), saida[0].end(), 0LL) +
        std::accumulate(saida[1].begin(), saida[1].end(), 0LL);
    Check(soma_entrada == soma_saida, "nenhuma amostra perdida ou duplicada no corte");
  }

  {
    // Um bloco que já é múltiplo de 480 mas não de 960 (por exemplo, se um
    // dia a captura mudar de 20ms pra 30ms) ainda tem que reenquadrar certo —
    // a função não deveria assumir "sempre dois quadros".
    std::vector<int16_t> entrada(1440);  // 30ms a 48kHz
    for (size_t i = 0; i < entrada.size(); ++i) entrada[i] = static_cast<int16_t>(i);
    const auto saida = ReframeTo10ms(entrada.data(), entrada.size(), 480);
    Check(saida.size() == 3, "1440 amostras a 480/quadro vira 3 quadros, nao trava em 2");
  }

  {
    // Bloco que NÃO é múltiplo exato do quadro de 10ms: tem que falhar alto,
    // não descartar o resto em silêncio.
    std::vector<int16_t> entrada(1000);  // nao e multiplo de 480
    bool lancou = false;
    try {
      ReframeTo10ms(entrada.data(), entrada.size(), 480);
    } catch (const std::invalid_argument&) {
      lancou = true;
    }
    Check(lancou, "bloco que nao e multiplo exato de 10ms lanca, em vez de cortar o resto");
  }

  {
    // Taxa de amostragem diferente de 48kHz (o dispositivo pode negociar
    // outra, e o RunSession já loga esse caso) — 480 é específico de 48kHz;
    // a 44.1kHz o quadro de 10ms tem 441 amostras.
    std::vector<int16_t> entrada(882);  // 20ms a 44.1kHz
    for (size_t i = 0; i < entrada.size(); ++i) entrada[i] = static_cast<int16_t>(i);
    const auto saida = ReframeTo10ms(entrada.data(), entrada.size(), 441);
    Check(saida.size() == 2 && saida[0].size() == 441 && saida[1].size() == 441,
          "o tamanho do quadro de 10ms e parametro, nao fixo em 480");
  }

  if (g_failures == 0) {
    std::printf("reframe_10ms: todos os testes passaram.\n");
    return 0;
  }
  std::printf("reframe_10ms: %d teste(s) FALHARAM.\n", g_failures);
  return 1;
}
