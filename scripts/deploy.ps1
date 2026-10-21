# Baut die App, bringt den Proxy auf den Unraid-Server und installiert die App auf dem Fernseher.
#
#   .\scripts\deploy.ps1            # alles
#   .\scripts\deploy.ps1 -NoTv      # nur Proxy auf dem Server
#
# Voraussetzungen: Node.js, SSH-Schlüssel für den Server, im webOS-CLI eingerichtetes Gerät (ares-setup-device).

param(
    [switch]$NoTv,
    [string]$Server = '192.168.177.80',
    [string]$SshKey = "$env:USERPROFILE\.ssh\id_ed25519_unraid",
    [string]$Share = '\\192.168.177.80\appdata\kabeltv',
    [string]$RemoteDir = '/mnt/user/appdata/kabeltv',
    [string]$FritzHost = '192.168.177.1',
    [int]$Port = 8095,
    [string]$TvDevice = 'tv'
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
Write-Host "== Kabel TV $($appinfo.version)"

Write-Host '== App paketieren'
New-Item -ItemType Directory -Force dist | Out-Null
Ares ares-package webos-app -o dist

Write-Host "== Dateien nach $Share kopieren"
robocopy proxy "$Share\proxy" server.js epg.js package.json Dockerfile /NJH /NJS /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Kopieren von proxy fehlgeschlagen' }
robocopy webos-app "$Share\webos-app" /MIR /NJH /NJS /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Kopieren von webos-app fehlgeschlagen' }
Copy-Item docker-compose.yml, README.md $Share -Force

Write-Host '== Container neu bauen und starten'
$remote = @(
    "cd $RemoteDir",
    'docker build -q -f proxy/Dockerfile -t kabeltv-proxy . >/dev/null',
    'docker rm -f kabeltv-proxy >/dev/null 2>&1 || true',
    "docker run -d --name kabeltv-proxy --restart unless-stopped --network host -e FRITZ_HOST=$FritzHost -e PORT=$Port --tmpfs /tmp/kabeltv kabeltv-proxy >/dev/null",
    'sleep 2',
    "curl -sf localhost:$Port/api/status >/dev/null && echo 'Proxy läuft auf Port $Port' || { docker logs kabeltv-proxy; exit 1; }"
) -join ' && '
ssh -o BatchMode=yes -i $SshKey "root@$Server" $remote
if ($LASTEXITCODE -ne 0) { throw 'Deploy auf dem Server fehlgeschlagen' }

if ($NoTv) { return }

Write-Host '== App auf dem Fernseher installieren'
try {
    Ares ares-install --device $TvDevice $ipk
    Ares ares-launch --device $TvDevice $appinfo.id
} catch {
    Write-Warning "Fernseher nicht erreichbar (Developer Mode abgelaufen oder TV aus?): $_"
}
