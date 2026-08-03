param(
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$installerRoot = $PSScriptRoot
$repositoryRoot = (Resolve-Path (Join-Path $installerRoot "..\..")).Path
$pluginRoot = Join-Path $repositoryRoot "plugins\levnet-moodle-integration"
$payloadRoot = Join-Path $installerRoot "payload"
$payloadZip = Join-Path $installerRoot "payload.zip"
$artifactRoot = Join-Path $repositoryRoot "artifacts\windows"
$serverExe = Join-Path $pluginRoot "bin\levnet-moodle-integration-win-x64.exe"

if (-not (Test-Path -LiteralPath $serverExe)) {
  throw "Build the Windows server first with npm run build:windows."
}

if (Test-Path -LiteralPath $payloadRoot) { Remove-Item -LiteralPath $payloadRoot -Recurse -Force }
if (Test-Path -LiteralPath $payloadZip) { Remove-Item -LiteralPath $payloadZip -Force }
New-Item -ItemType Directory -Path (Join-Path $payloadRoot ".agents\plugins") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $payloadRoot "plugins") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $installerRoot "marketplace.json") -Destination (Join-Path $payloadRoot ".agents\plugins\marketplace.json")
Copy-Item -LiteralPath $pluginRoot -Destination (Join-Path $payloadRoot "plugins\levnet-moodle-integration") -Recurse
Copy-Item -LiteralPath (Join-Path $pluginRoot ".mcp.windows.json") -Destination (Join-Path $payloadRoot "plugins\levnet-moodle-integration\.mcp.json") -Force

Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $payloadZip -CompressionLevel Optimal
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
dotnet publish (Join-Path $installerRoot "LevnetMoodleInstaller.csproj") -c $Configuration -r win-x64 --self-contained true -o $artifactRoot

Remove-Item -LiteralPath $payloadRoot -Recurse -Force
Remove-Item -LiteralPath $payloadZip -Force
Write-Output (Join-Path $artifactRoot "Levnet-Moodle-Setup.exe")
