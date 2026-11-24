<#
.SYNOPSIS
  Builds the PreVisit Desk image locally for linux/amd64 and records the tag for ship.ps1.

.DESCRIPTION
  Never build on the 2 GB host: compiling Rust there is not acceptable. This script runs on the
  development machine (Docker Desktop). It
    1. lints the Dockerfile (docker buildx build --check),
    2. builds previsit-desk:<tag> and previsit-desk:latest-local,
    3. checks that no .env or key file is inside the image and tries `check-data` (warning only),
    4. writes <repo>\.tmp\last-image-tag.txt (ignored by git) for ship.ps1.

  Tag = yyyyMMdd-HHmm, plus -g<short sha> (and -dirty) when the folder is a git repository.

.PARAMETER Tag        Use this tag instead of the generated one.
.PARAMETER Platform   Target platform. The host is x86_64, so the default is linux/amd64.
.PARAMETER NoCache    Pass --no-cache to the build.
.PARAMETER Pull       Pass --pull (refresh the pinned base tags).
.PARAMETER LintOnly   Only run the Dockerfile lint, do not build.
.PARAMETER SkipChecks Skip the post-build checks.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\build-image.ps1
#>
[CmdletBinding()]
param(
  [string]$Tag,
  [string]$Platform = 'linux/amd64',
  [switch]$NoCache,
  [switch]$Pull,
  [switch]$LintOnly,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$ImageName = 'previsit-desk'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Run a native command, capture stdout, ignore stderr, never throw (PowerShell 5.1 turns native stderr into errors under 'Stop').
function Get-NativeOutput {
  param([string]$File, [string[]]$Arguments)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $File @Arguments 2>$null
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
  } finally { $ErrorActionPreference = $old }
}

function Invoke-Native {
  param([string]$File, [string[]]$Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments[0]) failed with exit code $LASTEXITCODE" }
}

# --- docker reachable? ---
$dk = Get-NativeOutput 'docker' @('info', '--format', '{{.ServerVersion}}')
if ($dk.Code -ne 0) { throw 'docker daemon is not reachable. Start Docker Desktop first.' }

# --- inputs present? (the app sources are written by other people; fail early and clearly) ---
$required = @('Dockerfile', '.dockerignore', 'backend\Cargo.toml', 'backend\Cargo.lock', 'backend\migrations',
              'web\package.json', 'web\package-lock.json', 'data\seed', 'LICENSE', 'NOTICE.md')
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $Repo $_)) })
if ($missing.Count -gt 0) { throw ('Missing build inputs: ' + ($missing -join ', ')) }

# --- tag ---
if (-not $Tag) {
  $Tag = Get-Date -Format 'yyyyMMdd-HHmm'
  if ((Test-Path (Join-Path $Repo '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $rev = Get-NativeOutput 'git' @('-C', $Repo, 'rev-parse', '--short=7', 'HEAD')
    if ($rev.Code -eq 0 -and $rev.Out) {
      $Tag = "$Tag-g$($rev.Out)"
      $st = Get-NativeOutput 'git' @('-C', $Repo, 'status', '--porcelain')
      if ($st.Out) { $Tag = "$Tag-dirty" }
    }
  }
}
if ($Tag -notmatch '^[A-Za-z0-9_.-]{1,64}$') { throw "Invalid tag '$Tag' (allowed: letters, digits, _ . -)" }
$vcsRef = 'unknown'
if ($Tag -match '-g([0-9a-f]{7})') { $vcsRef = $Matches[1] }

Push-Location $Repo
try {
  Write-Host "== Dockerfile lint (docker buildx build --check)"
  Invoke-Native 'docker' @('buildx', 'build', '--check', '--platform', $Platform, '.')
  if ($LintOnly) { Write-Host 'Lint passed. (-LintOnly: not building)'; return }

  Write-Host "== Build $ImageName`:$Tag for $Platform"
  $buildDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  # provenance/sbom off: one plain image manifest loads cleanly with `docker load` on any engine version.
  $buildArgs = @('buildx', 'build', '--platform', $Platform, '--load', '--provenance=false', '--sbom=false',
                 '-t', "$ImageName`:$Tag", '-t', "$ImageName`:latest-local",
                 '--build-arg', "VCS_REF=$vcsRef", '--build-arg', "BUILD_DATE=$buildDate", '--build-arg', "IMAGE_VERSION=$Tag")
  if ($NoCache) { $buildArgs += '--no-cache' }
  if ($Pull) { $buildArgs += '--pull' }
  $buildArgs += '.'
  Invoke-Native 'docker' $buildArgs

  $info = & docker image inspect "$ImageName`:$Tag" --format '{{.Architecture}} {{.Size}}'
  $parts = $info -split ' '
  Write-Host ("Built {0}:{1}  arch={2}  size={3} MB" -f $ImageName, $Tag, $parts[0], [math]::Round([int64]$parts[1] / 1MB, 1))
  if ($parts[0] -ne 'amd64') { throw "Image architecture is $($parts[0]); the host needs amd64." }

  if (-not $SkipChecks) {
    Write-Host '== Post-build checks'
    $leak = & docker run --rm --entrypoint sh "$ImageName`:$Tag" -c "find /app -name '.env*' -o -name '*.pem' -o -name '*.token' | head"
    if ($leak) { throw "Secret-like files found inside the image:`n$leak" }
    Write-Host 'OK: no .env / key files under /app'

    $uid = (& docker run --rm --entrypoint id "$ImageName`:$Tag" -u).Trim()
    if ($uid -ne '10001') { throw "Container runs as uid $uid, expected 10001" }
    Write-Host 'OK: runs as uid 10001'

    # check-data validates the rule files and the handbook. Dummy values below are not secrets; they only satisfy config loading.
    Write-Host 'Running: previsit-api check-data (warning only if it fails)'
    & docker run --rm -e DATABASE_URL=postgres://u:p@127.0.0.1:1/x -e LLM_MODEL=mock `
        -e CLINICIAN_USERNAME=smoke -e CLINICIAN_PASSWORD=smoke-test-only "$ImageName`:$Tag" check-data
    if ($LASTEXITCODE -ne 0) { Write-Warning "check-data exited with $LASTEXITCODE. Read the output above before shipping." }
  }

  $tmp = Join-Path $Repo '.tmp'
  if (-not (Test-Path $tmp)) { $null = New-Item -ItemType Directory -Path $tmp }
  Set-Content -Path (Join-Path $tmp 'last-image-tag.txt') -Value $Tag -Encoding Ascii
  Write-Host ''
  Write-Host "Tag recorded in .tmp\last-image-tag.txt: $Tag"
  Write-Host 'Next: deploy\ship.ps1 -SshHost <user@host> -SshKey <key.pem>   (see DEPLOY.md section 5)'
}
finally { Pop-Location }
