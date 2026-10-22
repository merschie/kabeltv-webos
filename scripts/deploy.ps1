# Baut die App und installiert sie auf den Fernsehern.
#
#   .\scripts\deploy.ps1                       # Gerät "tv"
#   .\scripts\deploy.ps1 -TvDevice tv, tv2     # mehrere Fernseher
#   .\scripts\deploy.ps1 -NoTv                 # nur bauen
#   .\scripts\deploy.ps1 -Store -NoTv          # Paket für den LG Content Store (ohne Senderlogos) in dist\store
#
# Voraussetzungen: Node.js, im webOS-CLI eingerichtete Geräte (ares-setup-device).

param(
    [switch]$NoTv,
    [switch]$Store,
    [string[]]$TvDevice = @('tv')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# webOS-CLI einmalig in einen festen Ordner installieren (npx reicht unter PowerShell keine Argumente durch)
$cliDir = "$env:LOCALAPPDATA\kabeltv\webos-cli"
if (-not (Test-Path "$cliDir\node_modules\.bin\ares-package.cmd")) {
    Write-Host '== webOS-CLI installieren'
    npm install --prefix $cliDir @webos-tools/cli --no-fund --no-audit --loglevel=error | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Installation des webOS-CLI fehlgeschlagen' }
}

function Ares([string]$tool) {
    & "$cliDir\node_modules\.bin\$tool.cmd" @args
    if ($LASTEXITCODE -ne 0) { throw "$tool fehlgeschlagen" }
}

$appinfo = Get-Content webos-app\appinfo.json -Raw | ConvertFrom-Json
$ipk = "dist\$($appinfo.id)_$($appinfo.version)_all.ipk"
Write-Host "== KabelBox TV $($appinfo.version)"

Write-Host '== App und Stream-Dienst paketieren'
New-Item -ItemType Directory -Force dist | Out-Null
if ($Store) {
    # Senderlogos sind Marken der Sender und gehören nicht in die Store-Version; die App zeigt dann den Namen
    $app = 'dist\store-app'
    if (Test-Path $app) { Remove-Item $app -Recurse -Force }
    Copy-Item webos-app $app -Recurse
    Remove-Item "$app\logos" -Recurse -Force
    Set-Content "$app\js\logos.js" 'window.KABELTV_LOGOS = [];' -Encoding UTF8
    New-Item -ItemType Directory -Force dist\store | Out-Null
    Ares ares-package $app service -o dist\store
    $ipk = "dist\store\$($appinfo.id)_$($appinfo.version)_all.ipk"
} else {
    Ares ares-package webos-app service -o dist
}

foreach ($tv in $TvDevice) {
    Write-Host "== App auf Fernseher '$tv' installieren"
    try {
        Ares ares-install --device $tv $ipk
        Ares ares-launch --device $tv $appinfo.id
    } catch {
        Write-Warning "Fernseher '$tv' nicht erreichbar (Developer Mode abgelaufen oder TV aus?): $_"
    }
}
