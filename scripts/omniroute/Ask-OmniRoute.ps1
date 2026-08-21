param(
  [Parameter(Position = 0)]
  [string]$Prompt,
  [string]$Model = "kiro/qwen3-coder-next",
  [string[]]$Files,
  [string]$System,
  [int]$MaxTokens = 4096,
  [int]$Port = 20128,
  [int]$MaxFileKB = 256,
  [switch]$Check
)

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$baseUrl = "http://localhost:$Port"

function Invoke-Gateway {
  param([hashtable]$Body)

  # Windows PowerShell 5.1 sends a string body as latin-1 and decodes the reply
  # the same way. Source files here carry accented comments, so both directions
  # have to be forced to UTF-8 by hand: bytes out, explicit decode in. Passing
  # the JSON as a plain string gets "Invalid JSON body" from the gateway.
  $payload = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8))

  $resp = Invoke-WebRequest -Uri "$baseUrl/v1/messages" -Method Post -TimeoutSec 300 `
    -Headers @{ "anthropic-version" = "2023-06-01" } `
    -ContentType "application/json; charset=utf-8" -Body $payload -UseBasicParsing

  [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
}

if ($Check) {
  # The catalog lists every model the gateway knows about, not the ones whose
  # credentials still work. Only a real call separates the two, and tool calling
  # is what actually matters here, so the probe carries a tool.
  $candidates = @(
    "kiro/claude-sonnet-4.5", "kiro/claude-haiku-4.5", "kiro/qwen3-coder-next",
    "kiro/glm-5", "kiro/deepseek-3.2", "kiro/minimax-m2.5",
    "gemini/gemini-3.6-flash", "gemini/gemini-3.5-flash", "gemini/gemini-3.5-flash-lite",
    "oc/big-pickle"
  )

  Write-Host "Conexoes:" -ForegroundColor Cyan
  & omniroute providers list 2>$null | Select-Object -Last 8
  Write-Host ""
  Write-Host "Chamada real com tool calling:" -ForegroundColor Cyan

  foreach ($c in $candidates) {
    $probe = @{
      model      = $c
      max_tokens = 256
      tools      = @(@{
          name         = "grep"
          description  = "Search code"
          input_schema = @{ type = "object"; properties = @{ pattern = @{ type = "string" } }; required = @("pattern") }
        })
      messages   = @(@{ role = "user"; content = "Use the grep tool to search for transaction-service." })
    }
    try {
      $res = Invoke-Gateway -Body $probe
      $usedTool = @($res.content | Where-Object { $_.type -eq "tool_use" }).Count -gt 0
      $mark = if ($usedTool) { "ok  (tool)" } else { "ok  (sem tool)" }
      Write-Host ("  {0,-32} {1}" -f $c, $mark) -ForegroundColor Green
    } catch {
      Write-Host ("  {0,-32} morto" -f $c) -ForegroundColor DarkGray
    }
  }
  return
}

if (-not $Prompt) {
  Write-Error "Informe -Prompt, ou use -Check para descobrir quais modelos respondem."
}

$sb = New-Object System.Text.StringBuilder

foreach ($f in $Files) {
  $resolved = Resolve-Path -LiteralPath (Join-Path $rootDir $f) -ErrorAction SilentlyContinue
  if (-not $resolved) {
    $resolved = Resolve-Path -LiteralPath $f -ErrorAction SilentlyContinue
  }
  if (-not $resolved) {
    Write-Error "File not found: $f"
  }

  $item = Get-Item -LiteralPath $resolved.Path
  if ($item.Length -gt ($MaxFileKB * 1KB)) {
    Write-Error "$f is $([math]::Round($item.Length/1KB)) KB, over the -MaxFileKB limit of $MaxFileKB."
  }

  $rel = $resolved.Path.Replace($rootDir, "").TrimStart("\", "/")
  [void]$sb.AppendLine("--- $rel ---")
  [void]$sb.AppendLine((Get-Content -LiteralPath $resolved.Path -Raw))
  [void]$sb.AppendLine()
}

[void]$sb.AppendLine($Prompt)

$body = @{
  model      = $Model
  max_tokens = $MaxTokens
  messages   = @(@{ role = "user"; content = $sb.ToString() })
}
if ($System) {
  $body.system = $System
}

try {
  $r = Invoke-Gateway -Body $body
} catch {
  Write-Error "$Model failed: $($_.Exception.Message). Check that OmniRoute is up (omniroute serve), and run this script with -Check to see which models still answer."
}

# Reasoning models return thinking blocks alongside the answer. Only the text
# blocks are the response; printing the thinking doubles the output for nothing.
($r.content | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join "`n"

Write-Host ""
Write-Host "[$($r.model) | in $($r.usage.input_tokens) / out $($r.usage.output_tokens)]" -ForegroundColor DarkGray
