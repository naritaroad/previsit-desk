<#
.SYNOPSIS
  Sends the locally built image and the deploy files to the host. Never sends .env or any secret.

.DESCRIPTION
  1. docker save -> gzip (done in .NET, because the Windows PowerShell 5.1 pipeline corrupts binary
     data, so `docker save | gzip | ssh` cannot be used as a plain pipe here)
  2. scp the .tar.gz plus compose.prod.yaml and the host scripts to RemoteDir
  3. on the host: verify SHA-256, `docker load` (sudo when the user may not use docker), delete the archive
  Nothing is started: run remote-up.sh on the host afterwards (the script prints the command).
  The only host-side changes are: the deploy directory, the copied files and one extra image tag.
  Supports -WhatIf (prints every step, changes nothing).

.PARAMETER SshHost    user@host (or an ssh alias). Env default: PREVISIT_SSH_HOST.
                      Example: ubuntu@<LIGHTSAIL_IP>
.PARAMETER SshKey     Path to the private key. Env default: PREVISIT_SSH_KEY.
                      Example: C:\Users\<you>\.ssh\<key>.pem
.PARAMETER RemoteDir  Deploy directory on the host, relative to the ssh user's home or absolute. Default: previsit-desk
.PARAMETER ImageTag   Tag to ship. Default: the tag in <repo>\.tmp\last-image-tag.txt (written by build-image.ps1).
.PARAMETER FilesOnly  Copy only the compose file and scripts (no image). Use this before the first
                      deployment so the host directory exists and you can create .env there.

.EXAMPLE
  deploy\ship.ps1 -SshHost ubuntu@<LIGHTSAIL_IP> -SshKey "C:\Users\<you>\.ssh\<key>.pem" -WhatIf
.EXAMPLE
  deploy\ship.ps1 -SshHost ubuntu@<LIGHTSAIL_IP> -SshKey "C:\Users\<you>\.ssh\<key>.pem"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SshHost = $env:PREVISIT_SSH_HOST,
  [string]$SshKey = $env:PREVISIT_SSH_KEY,
  [string]$RemoteDir = 'previsit-desk',
  [string]$ImageTag,
  [switch]$FilesOnly
)

$ErrorActionPreference = 'Stop'
$ImageName = 'previsit-desk'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# ---- validate inputs (they end up inside a remote shell command, so be strict) ----
if (-not $SshHost) { throw 'SshHost is required (user@host), or set PREVISIT_SSH_HOST.' }
if ($SshHost -notmatch '^([A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$') { throw "SshHost '$SshHost' has unexpected characters." }
if (-not $SshKey) { throw 'SshKey is required, or set PREVISIT_SSH_KEY.' }
if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) { throw "SshKey file not found: $SshKey" }
if ($SshKey.Contains('"')) { throw 'SshKey path must not contain a double quote.' }
if ($RemoteDir -notmatch '^[A-Za-z0-9_./-]+$' -or $RemoteDir.Contains('..')) { throw "RemoteDir '$RemoteDir' has unexpected characters." }

if (-not $FilesOnly) {
  if (-not $ImageTag) {
    $tagFile = Join-Path $Repo '.tmp\last-image-tag.txt'
    if (-not (Test-Path $tagFile)) { throw 'No -ImageTag given and .tmp\last-image-tag.txt is missing. Run deploy\build-image.ps1 first.' }
    $ImageTag = (Get-Content $tagFile -TotalCount 1).Trim()
  }
  if ($ImageTag -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw "ImageTag '$ImageTag' has unexpected characters." }
}

$sshOpts = @('-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15')
$hostScripts = @('remote-common.sh', 'remote-up.sh', 'rollback.sh', 'host-preflight.sh', 'set-tunnel-token.sh', 'backup-db.sh')
$filesToSend = @('compose.prod.yaml') + $hostScripts

function Invoke-Remote {
  param([string]$Command)
  & ssh @sshOpts $SshHost $Command
  if ($LASTEXITCODE -ne 0) { throw "ssh command failed (exit $LASTEXITCODE)" }
}
function Send-Files {
  param([string[]]$Paths)
  & scp @sshOpts @Paths "${SshHost}:$RemoteDir/"
  if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }
}

# ---- scripts must have LF endings or bash on the host fails with "^M: bad interpreter" ----
foreach ($f in $filesToSend) {
  $p = Join-Path $PSScriptRoot $f
  if (-not (Test-Path $p)) { throw "Missing deploy file: $p" }
  if ([IO.File]::ReadAllText($p).Contains("`r")) { throw "$f contains CR characters; convert to LF line endings (.gitattributes keeps *.sh as LF)." }
}
# never ship secrets: refuse if somebody put a secret-looking file in the list
if ($filesToSend -match '\.env|\.pem|\.token|\.key') { throw 'Refusing to send secret-looking files.' }

# The image must exist locally before anything is done on the host.
# `docker image ls -q` prints the id or nothing and writes nothing to stderr (PowerShell 5.1 turns native stderr into errors).
if (-not $FilesOnly) {
  $imageId = & docker image ls -q "$ImageName`:$ImageTag"
  if (-not $imageId) { throw "Local image $ImageName`:$ImageTag not found. Run deploy\build-image.ps1." }
}

Write-Host "Target : $SshHost : $RemoteDir"
if (-not $FilesOnly) { Write-Host "Image  : $ImageName`:$ImageTag" }

# ---- 1. host directory ----
if ($PSCmdlet.ShouldProcess("$SshHost`:$RemoteDir", 'create directory (mode 700)')) {
  Invoke-Remote "mkdir -p '$RemoteDir' && chmod 700 '$RemoteDir'"
}

# ---- 2. image ----
if (-not $FilesOnly) {
  if ($PSCmdlet.ShouldProcess("$ImageName`:$ImageTag", 'docker save, gzip, scp, docker load on host')) {
    $work = Join-Path ([IO.Path]::GetTempPath()) ("previsit-ship-" + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $work
    try {
      $tar = Join-Path $work "image-$ImageTag.tar"
      $gz = "$tar.gz"
      Write-Host 'docker save ...'
      & docker save -o $tar "$ImageName`:$ImageTag"
      if ($LASTEXITCODE -ne 0) { throw 'docker save failed' }

      Write-Host 'gzip ...'
      $in = [IO.File]::OpenRead($tar)
      try {
        $out = [IO.File]::Create($gz)
        try {
          $z = New-Object IO.Compression.GZipStream($out, [IO.Compression.CompressionLevel]::Optimal)
          try { $in.CopyTo($z) } finally { $z.Dispose() }
        } finally { $out.Dispose() }
      } finally { $in.Dispose() }
      Remove-Item -LiteralPath $tar -Force

      $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $gz).Hash.ToLower()
      $mb = [math]::Round((Get-Item -LiteralPath $gz).Length / 1MB, 1)
      Write-Host "archive: $mb MB  sha256=$sha"

      # free space check on the host before sending (needs about 1000 MB: archive + unpacked layers).
      # Remote commands below use single quotes only: Windows PowerShell 5.1 does not escape embedded double quotes for native programs.
      Invoke-Remote ("cd '$RemoteDir' && df -Pm . | awk 'NR==2 && `$4 < 1000 {exit 1}'")

      Write-Host 'scp ...'
      Send-Files @($gz)

      $remoteFile = "image-$ImageTag.tar.gz"
      $load = "cd '$RemoteDir' && echo '$sha  $remoteFile' | sha256sum -c - && " +
              "{ D=docker; docker info >/dev/null 2>&1 || D='sudo -n docker'; gunzip -c '$remoteFile' | `$D load; } && rm -f '$remoteFile'"
      Write-Host 'docker load on host ...'
      Invoke-Remote $load
    }
    finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# ---- 3. compose file and host scripts ----
if ($PSCmdlet.ShouldProcess("$SshHost`:$RemoteDir", ('copy ' + ($filesToSend -join ', ')))) {
  Send-Files ($filesToSend | ForEach-Object { Join-Path $PSScriptRoot $_ })
  Invoke-Remote ("cd '$RemoteDir' && chmod 755 *.sh && chmod 644 compose.prod.yaml && if [ -f .env ]; then printf '.env present, mode %s\n' `$(stat -c %a .env); else echo '.env NOT present yet (create it: DEPLOY.md section 6)'; fi")
}

Write-Host ''
Write-Host 'Done. Nothing was started. Next, on the host:'
if ($FilesOnly) {
  Write-Host "  ssh -i `"$SshKey`" $SshHost `"cd $RemoteDir && ./host-preflight.sh`""
} else {
  Write-Host "  ssh -i `"$SshKey`" $SshHost `"cd $RemoteDir && ./remote-up.sh --check-only --tag $ImageTag`""
  Write-Host "  ssh -i `"$SshKey`" $SshHost `"cd $RemoteDir && ./remote-up.sh --tag $ImageTag`""
}
