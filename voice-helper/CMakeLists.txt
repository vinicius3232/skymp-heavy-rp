cmake_minimum_required(VERSION 3.21)

# Projeto deliberadamente separado do resto do monorepo: o gamemode é JS puro
# carregado direto pelo SkyMP e não tem etapa de build. Amarrar um toolchain C++
# ao `npm test` faria todo contribuidor precisar de MSVC pra rodar teste de
# JavaScript. Este diretório se compila sozinho.
project(voice-helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(unofficial-miniaudio CONFIG QUIET)
if(NOT unofficial-miniaudio_FOUND)
  # A port do miniaudio no vcpkg ja exportou o alvo com nomes diferentes ao
  # longo do tempo. Sendo header-only, achar o cabecalho basta.
  find_path(MINIAUDIO_INCLUDE_DIR miniaudio.h REQUIRED)
endif()

find_package(ixwebsocket CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(voice-helper src/main.cpp)

if(unofficial-miniaudio_FOUND)
  target_link_libraries(voice-helper PRIVATE unofficial::miniaudio::miniaudio)
else()
  target_include_directories(voice-helper PRIVATE ${MINIAUDIO_INCLUDE_DIR})
endif()

target_link_libraries(voice-helper PRIVATE
  ixwebsocket::ixwebsocket
  nlohmann_json::nlohmann_json
)

if(WIN32)
  # WASAPI vem do backend do miniaudio; estas sao as libs de socket e de
  # enumeracao de dispositivo que ele e o ixwebsocket precisam no Windows.
  #
  # bcrypt: o ixwebsocket arrasta mbedtls (TLS), e o entropy_poll do mbedcrypto
  # chama BCryptGenRandom, que mora em bcrypt.lib. Sem ela o link falha com
  # LNK2019 mesmo sem usarmos TLS em lugar nenhum — o objeto entra na lib
  # inteira, nao so o que a gente chama. Descoberto no primeiro build de
  # verdade, 07/08/2026; ver VOICE_NATIVE_HELPER.md §8.3.
  target_link_libraries(voice-helper PRIVATE ws2_32 ole32 winmm bcrypt)
  target_compile_definitions(voice-helper PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
  )
endif()

if(MSVC)
  target_compile_options(voice-helper PRIVATE /W4)
else()
  target_compile_options(voice-helper PRIVATE -Wall -Wextra)
endif()

# Alvo separado, de propósito: reframe_10ms.h não depende de miniaudio nem de
# ixwebsocket, e amarrar o teste ao executável principal obrigaria linkar
# WASAPI só pra verificar um corte de vetor. Sem framework de teste — é um
# arquivo, `assert`/prints bastam.
add_executable(reframe-10ms-test src/reframe_10ms.test.cpp)
target_compile_features(reframe-10ms-test PRIVATE cxx_std_17)
if(MSVC)
  target_compile_options(reframe-10ms-test PRIVATE /W4)
else()
  target_compile_options(reframe-10ms-test PRIVATE -Wall -Wextra)
endif()

enable_testing()
add_test(NAME reframe_10ms COMMAND reframe-10ms-test)
