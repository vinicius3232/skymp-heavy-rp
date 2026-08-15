cmake_minimum_required(VERSION 3.21)

# SPIKE, e por isso separado do `voice-helper/`.
#
# Ele arrasta o SDK C++ do LiveKit, que o helper de produção ainda NÃO arrasta.
# Misturar os dois faria o único caminho de captura provado do projeto passar a
# depender de um SDK que ainda não provou nada — exatamente a troca que esta
# rodada existe para evitar.
project(skyvoice-livekit-cpp-spike LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Onde o SDK pré-compilado foi descompactado.
#
# Ele NÃO é versionado neste repositório: são 26 MB de DLL e o release oficial
# é a fonte. Ver README.md para o download e o SHA-256 conferido.
set(LIVEKIT_SDK_ROOT "" CACHE PATH
    "Raiz do livekit-sdk-windows-x64-<versao> descompactado")

if(NOT LIVEKIT_SDK_ROOT)
  message(FATAL_ERROR
    "Defina -DLIVEKIT_SDK_ROOT=<caminho do SDK descompactado>. Ver README.md.")
endif()

find_package(LiveKit REQUIRED CONFIG
             PATHS "${LIVEKIT_SDK_ROOT}/lib/cmake/LiveKit" NO_DEFAULT_PATH)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(skyvoice-spike src/spike.cpp)

target_link_libraries(skyvoice-spike PRIVATE
  LiveKit::livekit
  nlohmann_json::nlohmann_json
)

if(MSVC)
  target_compile_options(skyvoice-spike PRIVATE /W4)
  target_compile_definitions(skyvoice-spike PRIVATE
    WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
endif()

# As DLLs precisam estar ao lado do executável: o loader do Windows não olha
# dentro de lib/cmake. Copiar no build evita o modo de falha mais chato que
# existe aqui — o exe some sem mensagem nenhuma por falta de livekit_ffi.dll.
add_custom_command(TARGET skyvoice-spike POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${LIVEKIT_SDK_ROOT}/bin/livekit.dll"
          "${LIVEKIT_SDK_ROOT}/bin/livekit_ffi.dll"
          "$<TARGET_FILE_DIR:skyvoice-spike>"
  COMMENT "Copiando as DLLs do LiveKit para junto do executavel")
