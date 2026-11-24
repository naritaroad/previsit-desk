<#
.SYNOPSIS
  Creates (or finds) the NEW remotely-managed Cloudflare Tunnel "previsit-desk", points
  <Hostname> at it, and hands the tunnel token to the host. Idempotent: run it again any time.

.DESCRIPTION
  What it does, in order (each step prints created / unchanged / skipped):
    1. find a tunnel named TunnelName (GET) or create it with config_src=cloudflare (POST)
    2. set the ingress  <Hostname> -> <Service>  plus a 404 catch-all (PUT .../configurations)
    3. upsert a proxied CNAME  <Hostname> -> <tunnel-id>.cfargotunnel.com  in the zone
    4. fetch the tunnel token and store it, never printing it:
         default            -> local file .cloudflared\previsit-desk.token with an owner-only ACL (git-ignored)
         -SaveTokenToHost   -> streamed over ssh into the host's .env (deploy\set-tunnel-token.sh)
  It never touches any other tunnel, any other DNS name, or any systemd unit on the host.
  An existing CNAME that points elsewhere is NOT overwritten unless -ReplaceDns is given.

  Credentials come from the environment only (nothing is stored in this file):
    CLOUDFLARE_API_TOKEN  API token with: Cloudflare Tunnel Write (account), DNS Write (zone),
                          and optionally Zone Read (hostname/zone sanity check)
    CF_ACCOUNT_ID         32-character account id
    CF_ZONE_ID            32-character zone id of the zone that contains -Hostname

  Switches:
    -DryRun   no network calls at all; prints the requests it would send (no credentials needed)
    -WhatIf   read-only calls (GET) are made, every write (POST/PUT/PATCH, file, ssh) is skipped

  Fallback without a domain: see DEPLOY.md, "trycloudflare fallback". Quick tunnels do not support
  Server-Sent Events, which the chat endpoint uses, so use a named tunnel with a real hostname.

.PARAMETER Hostname        Public hostname. Default: previsit.naritaroad.com
.PARAMETER TunnelName      Tunnel name. Default: previsit-desk
.PARAMETER Service         Origin as seen from the cloudflared container. Default: http://api:8088
.PARAMETER TokenFile       Local token file. Default: <repo>\.cloudflared\previsit-desk.token
.PARAMETER SaveTokenToHost Send the token to the host .env instead of a local file (needs -SshHost, -SshKey).
.PARAMETER SshHost         user@host. Env default: PREVISIT_SSH_HOST. Example: ubuntu@<LIGHTSAIL_IP>
.PARAMETER SshKey          Private key path. Env default: PREVISIT_SSH_KEY.
                           Example: C:\Users\<you>\.ssh\<key>.pem
.PARAMETER RemoteDir       Deploy directory on the host. Default: previsit-desk
.PARAMETER ReplaceDns      Allow replacing an existing CNAME for Hostname that points somewhere else.

.EXAMPLE
  deploy\cloudflare-tunnel.ps1 -DryRun
.EXAMPLE
  deploy\cloudflare-tunnel.ps1 -WhatIf
.EXAMPLE
  deploy\cloudflare-tunnel.ps1 -SaveTokenToHost -SshHost ubuntu@<LIGHTSAIL_IP> -SshKey "C:\Users\<you>\.ssh\<key>.pem"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Hostname = 'previsit.naritaroad.com',
  [string]$TunnelName = 'previsit-desk',
  [string]$Service = 'http://api:8088',
  [string]$TokenFile,
  [switch]$SaveTokenToHost,
  [string]$SshHost = $env:PREVISIT_SSH_HOST,
  [string]$SshKey = $env:PREVISIT_SSH_KEY,
  [string]$RemoteDir = 'previsit-desk',
  [switch]$ReplaceDns,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# ---- input validation ----
if ($Hostname -notmatch '^([a-z0-9-]+\.)+[a-z]{2,}$') { throw "Hostname '$Hostname' must be a lower-case DNS name." }
if ($TunnelName -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "TunnelName '$TunnelName' has unexpected characters." }
if ($Service -notmatch '^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?$') { throw "Service '$Service' must look like http://api:8088" }
if ($RemoteDir -notmatch '^[A-Za-z0-9_./-]+$' -or $RemoteDir.Contains('..')) { throw "RemoteDir '$RemoteDir' has unexpected characters." }

$acct = $env:CF_ACCOUNT_ID
$zone = $env:CF_ZONE_ID
if (-not $DryRun) {
  if (-not $env:CLOUDFLARE_API_TOKEN) { throw 'Set CLOUDFLARE_API_TOKEN in this session (do not put it in a file in the repo).' }
  if ($acct -notmatch '^[0-9a-f]{32}$') { throw 'Set CF_ACCOUNT_ID (32 hex characters).' }
  if ($zone -notmatch '^[0-9a-f]{32}$') { throw 'Set CF_ZONE_ID (32 hex characters).' }
} else {
  if (-not $acct) { $acct = '<CF_ACCOUNT_ID>' }
  if (-not $zone) { $zone = '<CF_ZONE_ID>' }
}

# API base: always Cloudflare, except that a loopback URL is accepted so the logic can be tested against a local mock.
$ApiBase = 'https://api.cloudflare.com/client/v4'
if ($env:CF_API_BASE) {
  if ($env:CF_API_BASE -notmatch '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/client/v4$') { throw 'CF_API_BASE may only point to a loopback address (test hook).' }
  $ApiBase = $env:CF_API_BASE
}

# Token destination is validated now, before any API call can create something.
if ($SaveTokenToHost) {
  if (-not $SshHost -or $SshHost -notmatch '^([A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$') { throw 'SaveTokenToHost needs a valid -SshHost (user@host).' }
  if (-not $SshKey -or -not (Test-Path -LiteralPath $SshKey -PathType Leaf) -or $SshKey.Contains('"')) { throw 'SaveTokenToHost needs -SshKey pointing to the private key file.' }
}

function Write-Step { param([string]$Name, [string]$State, [string]$Detail = '') Write-Host ('{0,-10} {1,-10} {2}' -f $Name, $State, $Detail) }

function Invoke-Cf {
  param([string]$Method, [string]$Path, $Body = $null, [switch]$Write)
  $line = "$Method $Path"
  if ($DryRun) {
    Write-Host "[dry-run] $line"
    if ($null -ne $Body) { Write-Host ('          body: ' + (ConvertTo-Json -InputObject $Body -Depth 10 -Compress)) }
    return $null
  }
  if ($Write -and -not $PSCmdlet.ShouldProcess($line, 'Cloudflare API write')) { return $null }
  $params = @{
    Method      = $Method
    Uri         = ($ApiBase + $Path)
    Headers     = @{ Authorization = ('Bearer ' + $env:CLOUDFLARE_API_TOKEN) }
    ContentType = 'application/json'
  }
  if ($null -ne $Body) { $params.Body = (ConvertTo-Json -InputObject $Body -Depth 10 -Compress) }
  try {
    $resp = Invoke-RestMethod @params
  } catch {
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      try {
        $j = $_.ErrorDetails.Message | ConvertFrom-Json
        $msg = (@($j.errors | ForEach-Object { '[' + $_.code + '] ' + $_.message }) -join '; ')
      } catch { }
    }
    throw "Cloudflare API call failed: $line -> $msg"
  }
  if ($resp -and $resp.PSObject.Properties['success'] -and -not $resp.success) {
    throw ("Cloudflare API reported failure: $line -> " + (@($resp.errors | ForEach-Object { $_.message }) -join '; '))
  }
  return $resp
}

Write-Host "Hostname   : $Hostname"
Write-Host "Tunnel     : $TunnelName   origin $Service"
if ($DryRun) { Write-Host 'Mode       : DRY RUN (no network calls)' } elseif ($WhatIfPreference) { Write-Host 'Mode       : WhatIf (GET only)' }
Write-Host ''

# ---- 0. zone sanity check (needs Zone Read; skipped with a warning when the token lacks it) ----
if (-not $DryRun) {
  try {
    $z = Invoke-Cf GET "/zones/$zone"
    $zn = $z.result.name
    if ($zn -and -not ($Hostname -eq $zn -or $Hostname.EndsWith('.' + $zn))) { throw "Hostname $Hostname is not inside zone $zn (CF_ZONE_ID). Nothing was changed." }
    Write-Step 'zone' 'ok' $zn
  } catch {
    if ($_.Exception.Message -like '*is not inside zone*') { throw }
    Write-Warning "Could not read the zone (token without Zone Read?): zone/hostname check skipped."
  }
}

# ---- 1. tunnel: find by exact name, else create ----
$tunnelId = '<tunnel-id>'
$token = $null
$tunnel = $null
$existed = $false
$list = Invoke-Cf GET ("/accounts/$acct/cfd_tunnel?name=" + [uri]::EscapeDataString($TunnelName) + '&is_deleted=false')
if ($list -and $list.result) {
  $match = @($list.result | Where-Object { $_.name -eq $TunnelName })
  if ($match.Count -ge 1) { $tunnel = $match[0] }
}
# ---- 1b. DNS pre-check (read-only): a conflict must stop us BEFORE anything is created ----
$recs = Invoke-Cf GET ("/zones/$zone/dns_records?name=" + [uri]::EscapeDataString($Hostname))
$existing = @()
if ($recs -and $recs.result) { $existing = @($recs.result) }
$other = @($existing | Where-Object { $_.type -ne 'CNAME' })
if ($other.Count -gt 0) { throw ("A non-CNAME record already exists for $Hostname (" + (($other | ForEach-Object { $_.type }) -join ', ') + '). Remove or rename it in the Cloudflare dashboard; this script will not delete records. Nothing was changed.') }
if ($existing.Count -gt 0 -and -not $ReplaceDns) {
  $knownTarget = $null
  if ($tunnel) { $knownTarget = $tunnel.id + '.cfargotunnel.com' }
  if ($existing[0].content -ne $knownTarget) {
    throw "CNAME $Hostname already points to $($existing[0].content), not to this tunnel. If that is not another service you care about, re-run with -ReplaceDns. Nothing was changed."
  }
}

if ($tunnel) {
  $cs = $tunnel.PSObject.Properties['config_src']
  if ($cs -and $cs.Value -and $cs.Value -ne 'cloudflare') { throw "Tunnel '$TunnelName' exists but is managed locally (config_src=$($cs.Value)); this script only manages remotely-managed tunnels." }
  $tunnelId = $tunnel.id
  $existed = $true
  Write-Step 'tunnel' 'unchanged' "$TunnelName ($tunnelId) already exists"
} else {
  $created = Invoke-Cf POST "/accounts/$acct/cfd_tunnel" @{ name = $TunnelName; config_src = 'cloudflare' } -Write
  if ($created) {
    $tunnelId = $created.result.id
    if ($created.result.PSObject.Properties['token']) { $token = $created.result.token }
    Write-Step 'tunnel' 'created' "$TunnelName ($tunnelId)"
  } else {
    Write-Step 'tunnel' 'would-create' $TunnelName
  }
}

# ---- 2. ingress ----
$desired = @(
  @{ hostname = $Hostname; service = $Service; originRequest = @{} },
  @{ service = 'http_status:404' }
)
$ingressUnchanged = $false
if ($existed) {
  $cfg = Invoke-Cf GET "/accounts/$acct/cfd_tunnel/$tunnelId/configurations"
  if ($cfg -and $cfg.result -and $cfg.result.PSObject.Properties['config'] -and $cfg.result.config -and $cfg.result.config.PSObject.Properties['ingress']) {
    $have = @($cfg.result.config.ingress | ForEach-Object { '{0}|{1}' -f $_.hostname, $_.service })
    $want = @($desired | ForEach-Object { '{0}|{1}' -f $_.hostname, $_.service })
    if (($have -join ';') -eq ($want -join ';')) { $ingressUnchanged = $true }
  }
}
if ($ingressUnchanged) {
  Write-Step 'ingress' 'unchanged' "$Hostname -> $Service"
} else {
  $put = Invoke-Cf PUT "/accounts/$acct/cfd_tunnel/$tunnelId/configurations" @{ config = @{ ingress = $desired } } -Write
  if ($put) { Write-Step 'ingress' 'updated' "$Hostname -> $Service (+ catch-all 404)" } else { Write-Step 'ingress' 'skipped' "$Hostname -> $Service" }
}

# ---- 3. DNS CNAME ----
$target = "$tunnelId.cfargotunnel.com"
$dnsBody = @{ type = 'CNAME'; name = $Hostname; content = $target; proxied = $true; ttl = 1; comment = 'previsit-desk tunnel' }
if ($existing.Count -eq 0) {
  $r = Invoke-Cf POST "/zones/$zone/dns_records" $dnsBody -Write
  if ($r) { Write-Step 'dns' 'created' "$Hostname -> $target (proxied)" } else { Write-Step 'dns' 'skipped' "$Hostname -> $target" }
} else {
  $rec = $existing[0]
  if ($rec.content -eq $target -and $rec.proxied) {
    Write-Step 'dns' 'unchanged' "$Hostname -> $target (proxied)"
  } elseif (-not $ReplaceDns) {
    throw "CNAME $Hostname already points to $($rec.content) (proxied=$($rec.proxied)); it is the right target but not proxied. Re-run with -ReplaceDns to switch the proxy on."
  } else {
    $r = Invoke-Cf PATCH ("/zones/$zone/dns_records/" + $rec.id) $dnsBody -Write
    if ($r) { Write-Step 'dns' 'updated' "${Hostname}: $($rec.content) -> $target" } else { Write-Step 'dns' 'skipped' "$Hostname -> $target" }
  }
}

# ---- 4. token ----
if (-not $token -and $tunnelId -ne '<tunnel-id>') {
  $t = Invoke-Cf GET "/accounts/$acct/cfd_tunnel/$tunnelId/token"
  if ($t) { $token = $t.result }
} elseif (-not $token -and $DryRun) {
  $null = Invoke-Cf GET "/accounts/$acct/cfd_tunnel/$tunnelId/token"
}
if ($token) {
  if ($token -isnot [string] -or $token -notmatch '^[A-Za-z0-9+/=_-]{40,}$') { throw 'Unexpected token format returned by the API; not saving it.' }
}

if ($SaveTokenToHost) {
  if (-not $token) {
    Write-Step 'token' 'skipped' 'no token available (dry run or WhatIf)'
  } elseif ($PSCmdlet.ShouldProcess("$SshHost`:$RemoteDir/.env", 'write TUNNEL_TOKEN over ssh')) {
    $sshExe = (Get-Command ssh -ErrorAction Stop).Source
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $sshExe
    $psi.Arguments = ('-i "{0}" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 {1} "cd {2} && ./set-tunnel-token.sh"' -f $SshKey, $SshHost, $RemoteDir)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $bytes = [Text.Encoding]::ASCII.GetBytes($token + "`n")
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.Close()
    $so = $p.StandardOutput.ReadToEnd()
    $se = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "Writing the token on the host failed (exit $($p.ExitCode)): $se" }
    Write-Step 'token' 'saved' ($so.Trim())
  }
} else {
  if (-not $TokenFile) { $TokenFile = Join-Path $Repo '.cloudflared\previsit-desk.token' }
  if (-not $token) {
    Write-Step 'token' 'skipped' "no token available (dry run or WhatIf); would write $TokenFile"
  } elseif ($PSCmdlet.ShouldProcess($TokenFile, 'write tunnel token (owner-only ACL)')) {
    $dir = Split-Path -Parent $TokenFile
    if ($dir -and -not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir }
    # Create the empty file and lock the ACL BEFORE the secret is written into it.
    [IO.File]::WriteAllText($TokenFile, '')
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # A brand-new FileSecurity replaces the whole DACL (no inherited entries, only the current user);
    # it touches neither owner nor audit settings, so no special privilege is needed.
    $fs = New-Object System.Security.AccessControl.FileSecurity
    $fs.SetAccessRuleProtection($true, $false)
    $fs.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
    [IO.File]::SetAccessControl($TokenFile, $fs)
    [IO.File]::WriteAllText($TokenFile, $token, (New-Object Text.UTF8Encoding($false)))
    Write-Step 'token' 'saved' "$TokenFile (owner-only; copy it to the host .env as TUNNEL_TOKEN=..., or re-run with -SaveTokenToHost)"
  }
}

# ---- status (never prints secrets) ----
if ($tunnelId -ne '<tunnel-id>' -and -not $DryRun) {
  $s = Invoke-Cf GET "/accounts/$acct/cfd_tunnel/$tunnelId"
  if ($s) {
    $conns = 0
    if ($s.result.PSObject.Properties['connections'] -and $s.result.connections) { $conns = @($s.result.connections).Count }
    Write-Step 'status' $s.result.status "connections=$conns (inactive is normal until the cloudflared container runs)"
  }
}
Write-Host ''
Write-Host "Public URL once the stack is up: https://$Hostname/"
