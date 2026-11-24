<#
.SYNOPSIS
  Post-deploy smoke test over HTTPS: GET /api/v1/health and GET / with status codes. Read-only.

.DESCRIPTION
  Exit code 0 when every check passes, 1 otherwise. Sends no credentials and no data.
    health  : status 200 and a JSON body with ok = true
    web     : status 200, text/html, and the page looks like the single-page app shell
  Also prints whether Cloudflare answered (cf-ray header) and the TLS status.

.PARAMETER BaseUrl     Default https://previsit.naritaroad.com . A loopback URL (http://127.0.0.1:18088) also works.
.PARAMETER TimeoutSec  Per-request timeout. Default 20.
.PARAMETER ExtraPath   Additional paths that must return 200 (for example /safety).

.EXAMPLE
  deploy\smoke.ps1
.EXAMPLE
  deploy\smoke.ps1 -BaseUrl http://127.0.0.1:18088
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'https://previsit.naritaroad.com',
  [int]$TimeoutSec = 20,
  [string[]]$ExtraPath = @()
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$BaseUrl = $BaseUrl.TrimEnd('/')
if ($BaseUrl -notmatch '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$') { throw "BaseUrl '$BaseUrl' must look like https://host[:port]" }
$isLoopback = $BaseUrl -match '^http://(127\.0\.0\.1|localhost)(:|$)'
if ($BaseUrl.StartsWith('http://') -and -not $isLoopback) { throw 'Plain http is only allowed for loopback addresses.' }

# GET without throwing on 4xx/5xx; returns status, headers, body, milliseconds.
function Get-Http {
  param([string]$Url)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = [pscustomobject]@{ Url = $Url; Status = 0; Type = ''; Body = ''; CfRay = ''; Error = ''; Ms = 0 }
  try {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutSec * 1000
    $req.AllowAutoRedirect = $false
    $req.UserAgent = 'previsit-smoke/1.0'
    try { $resp = $req.GetResponse() } catch [Net.WebException] {
      if ($_.Exception.Response) { $resp = $_.Exception.Response } else { throw }
    }
    $r.Status = [int]$resp.StatusCode
    $r.Type = [string]$resp.ContentType
    $r.CfRay = [string]$resp.Headers['cf-ray']
    $sr = New-Object IO.StreamReader($resp.GetResponseStream())
    try { $r.Body = $sr.ReadToEnd() } finally { $sr.Dispose() }
    $resp.Close()
  } catch {
    $r.Error = $_.Exception.Message
  }
  $sw.Stop()
  $r.Ms = [int]$sw.ElapsedMilliseconds
  return $r
}

$results = @()
function Add-Result {
  param([string]$Name, $Resp, [bool]$Pass, [string]$Note)
  $script:results += [pscustomobject]@{ Check = $Name; Pass = $Pass; Status = $Resp.Status; Ms = $Resp.Ms; Note = $Note }
}

# 1. health
$h = Get-Http ($BaseUrl + '/api/v1/health')
$okJson = $false
if ($h.Status -eq 200) { try { $okJson = [bool]((ConvertFrom-Json $h.Body).ok) } catch { $okJson = $false } }
$note = if ($h.Error) { $h.Error } elseif ($h.Status -eq 200 -and -not $okJson) { 'body is not {"ok":true}' } elseif ($h.Status -eq 503) { 'API is up but the database is not reachable' } else { '' }
Add-Result 'GET /api/v1/health' $h ($h.Status -eq 200 -and $okJson) $note

# 2. web shell
$w = Get-Http ($BaseUrl + '/')
$looksLikeApp = ($w.Body -match '(?i)<!doctype html') -and ($w.Body -match '(?i)<div id="root"|<script')
$note = if ($w.Error) { $w.Error } elseif ($w.Status -eq 200 -and $w.Type -notmatch 'text/html') { "content-type is '$($w.Type)'" } elseif ($w.Status -eq 200 -and -not $looksLikeApp) { 'body does not look like the app shell' } else { '' }
Add-Result 'GET /' $w ($w.Status -eq 200 -and $w.Type -match 'text/html' -and $looksLikeApp) $note

# 3. extras
foreach ($p in $ExtraPath) {
  if ($p -notmatch '^/[A-Za-z0-9/_.~-]*$') { throw "ExtraPath '$p' has unexpected characters." }
  $e = Get-Http ($BaseUrl + $p)
  Add-Result "GET $p" $e ($e.Status -eq 200) $e.Error
}

Write-Host "Smoke test: $BaseUrl"
foreach ($x in $results) {
  $tag = if ($x.Pass) { 'PASS' } else { 'FAIL' }
  Write-Host ('{0}  {1,-22} status={2,-3} {3,5} ms  {4}' -f $tag, $x.Check, $x.Status, $x.Ms, $x.Note)
}
if ($h.CfRay -or $w.CfRay) { Write-Host 'info: answered through Cloudflare (cf-ray present)' } elseif (-not $isLoopback) { Write-Host 'info: no cf-ray header; the request may not have gone through Cloudflare' }

$failed = @($results | Where-Object { -not $_.Pass })
if ($failed.Count -gt 0) { Write-Host "$($failed.Count) check(s) failed."; exit 1 }
Write-Host 'All checks passed.'
exit 0
