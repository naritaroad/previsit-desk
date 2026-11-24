# Acceptance check: names, characters and brand words from the source project must not appear anywhere
# in this repository (NOTICE.md and CHANGELOG.md may mention the provenance). Exit code 1 on any hit.
# The pattern uses \uXXXX escapes for non-ASCII so this file stays pure ASCII (PowerShell 5.1 safe).
# Usage:  powershell -File scripts/check-forbidden-names.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pattern = 'tazuna|\u624b\u7db1|tracen|\u30c8\u30ec\u30bb\u30f3|\u7279\u96f7\u68ee|umamusume|\u30a6\u30de\u5a18|\u8cfd\u99ac\u5a18|\u99ac\u5a18|hayakawa|vrm|three-vrm|trainer|\u8a13\u7df4\u54e1|\u5b78\u5712'
$skipNames = @('NOTICE.md', 'CHANGELOG.md', 'check-forbidden-names.ps1')
$skipDirs = '\\(target|node_modules|dist|\.git|\.agent-context|scratch)\\'

# Tracked and untracked-but-not-ignored files only (so .env, target/, node_modules/ never count).
$files = git ls-files --cached --others --exclude-standard | Where-Object { $_ }
$hits = 0
foreach ($rel in $files) {
    $path = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    if ($skipNames -contains (Split-Path -Leaf $path)) { continue }
    if ($path -match $skipDirs) { continue }
    $ext = [IO.Path]::GetExtension($path).ToLower()
    if ($ext -in '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.pdf', '.zip') { continue }
    $m = Select-String -LiteralPath $path -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
    foreach ($x in $m) {
        $hits++
        '{0}:{1}: {2}' -f $rel, $x.LineNumber, $x.Line.Trim()
    }
}
if ($hits -gt 0) { "FORBIDDEN NAMES: $hits hit(s)"; exit 1 }
'FORBIDDEN NAMES: 0 hits'
exit 0
