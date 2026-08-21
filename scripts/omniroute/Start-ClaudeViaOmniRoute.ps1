param(
  [string]$Model,
  [int]$Port = 20128,
  [string]$Profile = "skymp-omniroute",
  [switch]$ListModels,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$profileDir = Join-Path $env:USERPROFILE ".claude\profiles\$Profile"
$profileFile = Join-Path $profileDir "settings.json"
$baseUrl = "http://localhost:$Port"

if (-not (Test-Path -LiteralPath $profileFile)) {
  Write-Error "Profile not found at $profileFile. Recreate it or run: omniroute setup-claude --only <model-id>"
}

try {
  $catalog = Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec 10
} catch {
  Write-Error "OmniRoute is not answering on $baseUrl. Start it with: omniroute serve"
}

if ($ListModels) {
  # capabilities.tool_calling is true for every entry in the catalog, embedding
  # and image models included, so it filters nothing. Context length is the only
  # field that actually separates chat models from the rest.
  $catalog.data | Where-Object { $_.context_length -ge 100000 } |
    Select-Object -ExpandProperty id | Sort-Object -Unique
  return
}

$settings = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json

if ($Model) {
  if (-not ($catalog.data.id -contains $Model)) {
    Write-Error "Model '$Model' is not in the OmniRoute catalog. Run this script with -ListModels to see the options."
  }
  $settings.model = $Model
  $settings.env.ANTHROPIC_MODEL = $Model
  $settings | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $profileFile -Encoding utf8
}

$active = $settings.env.ANTHROPIC_MODEL

# The catalog lists models the gateway knows about, not models whose credentials
# still work. Quota exhaustion and dead upstreams only show up on a real call.
# max_tokens has to leave room for reasoning. The Gemini models spend the whole
# budget thinking on a small cap, return no choices, and the gateway turns that
# into a 502 that looks like a dead credential.
$probeBody = @{
  model      = $active
  max_tokens = 256
  messages   = @(@{ role = "user"; content = "Reply with the single word: ok" })
} | ConvertTo-Json -Depth 5

try {
  Invoke-RestMethod -Uri "$baseUrl/v1/messages" -Method Post -TimeoutSec 90 `
    -Headers @{ "anthropic-version" = "2023-06-01" } `
    -ContentType "application/json" -Body $probeBody | Out-Null
} catch {
  Write-Error "$active answered the catalog but failed a live call: $($_.Exception.Message). Pick another with -Model, or check `omniroute keys list`."
}

Write-Host "OmniRoute $baseUrl -> $active (profile: $Profile)"

Push-Location $rootDir
try {
  $launchArgs = @("launch", "--port", $Port, "--profile", $Profile)
  if ($ClaudeArgs) {
    $launchArgs += $ClaudeArgs
  }
  & omniroute @launchArgs
} finally {
  Pop-Location
}
