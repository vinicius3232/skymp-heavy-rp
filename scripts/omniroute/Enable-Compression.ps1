param(
  [string]$Token,
  [ValidateSet("hybrid", "caveman", "rtk", "none")]
  [string]$Engine = "hybrid",
  [double]$Aggressiveness = 0.5,
  [string]$SampleFile = "skymp/gamemode/commands.js",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$envFile = Join-Path $env:USERPROFILE ".omniroute\.env"

function Get-EnvValue {
  param([string]$Name)
  if (-not (Test-Path -LiteralPath $envFile)) { return $null }
  $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  $v = ($line -split "=", 2)[1].Trim()
  if ($v) { return $v } else { return $null }
}

# Set-Content -Encoding utf8 emits a BOM on Windows PowerShell 5.1. A BOM at the
# top of .env corrupts the first key for whoever parses it, and a BOM in a JSON
# file makes the CLI die with "Unexpected token". Both files here must be written
# as UTF-8 *without* BOM, which only the .NET writer does.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-TextNoBom {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Set-EnvValue {
  param([string]$Name, [string]$Value)
  $lines = @()
  if (Test-Path -LiteralPath $envFile) {
    $lines = @(Get-Content -LiteralPath $envFile)
  }
  if ($lines | Where-Object { $_ -match "^\s*$Name\s*=" }) {
    $lines = $lines | ForEach-Object {
      if ($_ -match "^\s*$Name\s*=") { "$Name=$Value" } else { $_ }
    }
  } else {
    $lines += "$Name=$Value"
  }
  Write-TextNoBom -Path $envFile -Content (($lines -join "`n") + "`n")
}

# --- 1. token -----------------------------------------------------------------

if (-not $Token) {
  $Token = Get-EnvValue -Name "OMNIROUTE_API_KEY"
}

if (-not $Token) {
  Write-Host "Nenhum OMNIROUTE_API_KEY encontrado em $envFile." -ForegroundColor Yellow
  Write-Host "Crie um token com escopo 'write' no painel e cole abaixo." -ForegroundColor Yellow
  if (-not $NoBrowser) {
    & omniroute open api-manager 2>$null | Out-Null
  }
  $secure = Read-Host -Prompt "Token (nao aparece na tela)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if (-not $Token) {
  Write-Error "Sem token nao da para configurar a compressao."
}

Set-EnvValue -Name "OMNIROUTE_API_KEY" -Value $Token
$env:OMNIROUTE_API_KEY = $Token
Write-Host "Token gravado em $envFile" -ForegroundColor Green

# --- 2. amostra real ----------------------------------------------------------

$samplePath = Join-Path $rootDir $SampleFile
if (-not (Test-Path -LiteralPath $samplePath)) {
  Write-Error "Arquivo de amostra nao encontrado: $SampleFile"
}

$sampleJson = Join-Path $env:TEMP "omniroute-compression-sample.json"
Write-TextNoBom -Path $sampleJson -Content (@{
    model    = "kiro/qwen3-coder-next"
    messages = @(@{ role = "user"; content = (Get-Content -LiteralPath $samplePath -Raw) })
  } | ConvertTo-Json -Depth 6)

Write-Host "Amostra: $SampleFile ($([math]::Round((Get-Item $samplePath).Length/1KB)) KB)"

# --- 3. medir, configurar, medir ----------------------------------------------

Write-Host ""
Write-Host "--- ANTES (engine: $(& omniroute compression engine get 2>$null | Select-Object -Last 1)) ---" -ForegroundColor Cyan
& omniroute compression preview --file $sampleJson 2>&1 | Select-Object -Last 12

Write-Host ""
Write-Host "--- configurando ---" -ForegroundColor Cyan
& omniroute compression configure --engine $Engine --caveman-aggressiveness $Aggressiveness 2>&1 | Select-Object -Last 6
if ($LASTEXITCODE -ne 0) {
  Write-Error "configure falhou. Se der 401, o token nao tem escopo 'write'."
}

Write-Host ""
Write-Host "--- DEPOIS ---" -ForegroundColor Cyan
& omniroute compression status 2>&1 | Select-Object -Last 8
& omniroute compression preview --file $sampleJson 2>&1 | Select-Object -Last 12

Remove-Item -LiteralPath $sampleJson -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Compare os dois preview. Se o numero de tokens nao caiu, a compressao" -ForegroundColor Yellow
Write-Host "nao esta agindo - independente do que o status disser. Para reverter:" -ForegroundColor Yellow
Write-Host "  omniroute compression configure --engine none" -ForegroundColor Yellow
