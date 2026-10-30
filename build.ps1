# Builds everything that is generated from the source. Run it after any change:
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
#   dist\whatnot-unfollow-manager-<version>.zip  the file to upload to addons.mozilla.org for signing
#   install.html                                 the install page, from install.template.html
#   updates.json                                 where installed copies look for new versions
#
# Once Mozilla has signed that zip, take the signed file in:
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Signed <the downloaded .xpi>
# It checks that the file is this add-on at the version in manifest.json, made of
# exactly the files here plus Mozilla's signature, and copies it to xpi\, where the
# install page and updates.json point. Mozilla rewrites manifest.json when it signs
# (same content, reformatted), so that file is compared as data; the rest byte for byte.
#
# The zip is made with Windows' tar.exe because it writes forward-slash paths;
# Windows PowerShell 5.1's Compress-Archive writes backslashes, which Firefox and
# addons.mozilla.org reject.
param([string]$Signed)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding $false
$root = $PSScriptRoot
$name = 'whatnot-unfollow-manager'
$site = 'https://crande25.github.io/whatnot-unfollow-manager/'

$manifest = [IO.File]::ReadAllText((Join-Path $root 'manifest.json'), $utf8) | ConvertFrom-Json
$version = $manifest.version
$id = $manifest.browser_specific_settings.gecko.id
# Installed copies only ever check the update_url they were installed with.
if ($manifest.browser_specific_settings.gecko.update_url -ne "${site}updates.json") {
  throw "manifest.json must keep update_url at ${site}updates.json, or installed copies stop getting updates."
}

function Get-Sha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

# A zip's files as @{ 'path/in/zip' = sha256 of the content }, and its manifest.json.
function Read-Package([string]$Path) {
  $archive = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $files = @{}
    $packageManifest = $null
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith('/')) { continue }   # folder entries
      $stream = $entry.Open()
      $buffer = New-Object IO.MemoryStream
      try { $stream.CopyTo($buffer) } finally { $stream.Dispose() }
      $files[$entry.FullName] = Get-Sha256 $buffer.ToArray()
      if ($entry.FullName -eq 'manifest.json') { $packageManifest = $utf8.GetString($buffer.ToArray()) | ConvertFrom-Json }
    }
    [pscustomobject]@{ Files = $files; Manifest = $packageManifest }
  } finally { $archive.Dispose() }
}

# Parsed JSON as one string with object keys sorted, so formatting and key order don't count.
function ConvertTo-CanonicalJson($Value) {
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $members = $Value.PSObject.Properties | Sort-Object Name | ForEach-Object { (ConvertTo-Json $_.Name) + ':' + (ConvertTo-CanonicalJson $_.Value) }
    return '{' + ($members -join ',') + '}'
  }
  if ($Value -is [System.Array]) { return '[' + (($Value | ForEach-Object { ConvertTo-CanonicalJson $_ }) -join ',') + ']' }
  ConvertTo-Json $Value -Compress
}

# 1. The zip to sign: the add-on's own files and nothing else.
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist "$name-$version.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
& tar.exe -a -c -f $zip -C $root manifest.json src icons
if ($LASTEXITCODE) { throw "tar failed with exit code $LASTEXITCODE" }
"Built $zip"

# 2. A file Mozilla signed: it must be that zip plus the signature, nothing else.
$xpiDir = Join-Path $root 'xpi'
if ($Signed) {
  $Signed = (Resolve-Path -LiteralPath $Signed).Path
  $signedPackage = Read-Package $Signed
  $built = Read-Package $zip
  if (-not ($signedPackage.Files.ContainsKey('META-INF/mozilla.rsa') -or $signedPackage.Files.ContainsKey('META-INF/cose.sig'))) {
    throw "$Signed isn't signed by Mozilla. Upload $zip to addons.mozilla.org and use the .xpi it gives back."
  }
  if ($signedPackage.Manifest.browser_specific_settings.gecko.id -ne $id) { throw "$Signed is a different add-on." }
  if ($signedPackage.Manifest.version -ne $version) {
    throw "$Signed is version $($signedPackage.Manifest.version), but manifest.json is at $version."
  }
  $different = @($built.Files.Keys | Where-Object { $_ -ne 'manifest.json' -and $signedPackage.Files[$_] -ne $built.Files[$_] })
  if ((ConvertTo-CanonicalJson $signedPackage.Manifest) -ne (ConvertTo-CanonicalJson $built.Manifest)) { $different += 'manifest.json' }
  $different += @($signedPackage.Files.Keys | Where-Object { $_ -notlike 'META-INF/*' -and -not $built.Files.ContainsKey($_) })
  if ($different.Count) {
    throw "$Signed doesn't match the files here ($($different -join ', ')). Upload the zip this script just built, then try again."
  }
  New-Item -ItemType Directory -Force $xpiDir | Out-Null
  Copy-Item -LiteralPath $Signed -Destination (Join-Path $xpiDir "$name-$version.xpi") -Force
  "Added xpi\$name-$version.xpi"
}

# 3. updates.json and install.html, from the signed files in xpi\.
$releases = @()
if (Test-Path -LiteralPath $xpiDir) {
  $releases = @(Get-ChildItem -LiteralPath $xpiDir -Filter "$name-*.xpi" -File | ForEach-Object {
    $package = Read-Package $_.FullName
    [pscustomobject]@{
      Version    = $package.Manifest.version
      MinFirefox = $package.Manifest.browser_specific_settings.gecko.strict_min_version
      File       = "xpi/$($_.Name)"
      Hash       = Get-Sha256 ([IO.File]::ReadAllBytes($_.FullName))
    }
  } | Sort-Object { [version]$_.Version })
}

# Firefox's update manifest format:
# https://extensionworkshop.com/documentation/manage/updating-your-extension/
$lines = @('{', '  "addons": {', "    `"$id`": {", '      "updates": [')
for ($i = 0; $i -lt $releases.Count; $i++) {
  $r = $releases[$i]
  $lines += '        {'
  $lines += "          `"version`": `"$($r.Version)`","
  $lines += "          `"update_link`": `"$site$($r.File)`","
  $lines += "          `"update_hash`": `"sha256:$($r.Hash)`","
  $lines += "          `"applications`": { `"gecko`": { `"strict_min_version`": `"$($r.MinFirefox)`" } }"
  $lines += '        }' + $(if ($i -lt $releases.Count - 1) { ',' } else { '' })
}
$lines += '      ]', '    }', '  }', '}'
$updates = ($lines -join "`n") + "`n"
$null = $updates | ConvertFrom-Json   # throws if the JSON is malformed
[IO.File]::WriteAllText((Join-Path $root 'updates.json'), $updates, $utf8)

# The install page shows the newest signed version, or says none is signed yet.
$latest = $releases | Select-Object -Last 1
$template = [IO.File]::ReadAllText((Join-Path $root 'install.template.html'), $utf8)
foreach ($marker in '{{VERSION}}', '{{XPI}}', '<!--IF SIGNED-->', '<!--END SIGNED-->', '<!--IF UNSIGNED-->', '<!--END UNSIGNED-->') {
  if (-not $template.Contains($marker)) { throw "install.template.html has no $marker." }
}
$show, $hide = if ($latest) { 'SIGNED', 'UNSIGNED' } else { 'UNSIGNED', 'SIGNED' }
$page = [regex]::Replace($template, "(?ms)^[ \t]*<!--IF $hide-->.*?<!--END $hide-->[ \t]*\r?\n", '')
$page = [regex]::Replace($page, "(?m)^[ \t]*<!--(IF|END) $show-->[ \t]*\r?\n", '')
if ($latest) { $page = $page.Replace('{{VERSION}}', $latest.Version).Replace('{{XPI}}', $latest.File) }
else { $page = $page.Replace('{{VERSION}}', $version) }
if ($page -match '\{\{|<!--(IF|END) ') { throw 'install.template.html has a placeholder or marker in the wrong place.' }
[IO.File]::WriteAllText((Join-Path $root 'install.html'), $page, $utf8)

if ($latest) {
  "Wrote install.html and updates.json for version $($latest.Version) ($($releases.Count) signed version(s) in xpi\)."
  if ($latest.Version -ne $version) {
    "manifest.json is at $version, which isn't signed yet. Upload the zip, then run: build.ps1 -Signed <the .xpi>"
  }
} else {
  "Wrote install.html and updates.json. Nothing is signed yet, so the page says $version is waiting for Mozilla's signature."
}
