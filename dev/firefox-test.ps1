# Smoke test in a throwaway headless Firefox (never your own profile):
#  1. installs the add-on as a temporary add-on and opens whatnot.com,
#  2. checks the panel while signed out and adds an account to the keep list
#     through Whatnot's real (public) API,
#  3. swaps Whatnot's GraphQL endpoint for a fake one inside the test page
#     (a signed-in account with 12 follows, one that always fails) and runs a
#     full bulk unfollow, retry and reload. No real account is touched.
#
#   powershell -ExecutionPolicy Bypass -File dev\firefox-test.ps1 [-AddonPath dist\whatnot-unfollow-manager-1.0.0.zip]
#
# Talks to Firefox over Marionette (its built-in remote protocol); needs only
# Firefox and Windows PowerShell 5.1.
param(
  [string]$AddonPath = (Split-Path $PSScriptRoot -Parent),
  [string]$Firefox = "$env:ProgramFiles\Mozilla Firefox\firefox.exe"
)
$ErrorActionPreference = 'Stop'
$AddonPath = (Resolve-Path -LiteralPath $AddonPath).Path
$TestRoot = Join-Path $env:TEMP 'wum-firefox-test'   # kept short: long profile paths break Firefox
$Port = 2829
$script:MsgId = 0
$script:Failures = 0
$dot = [char]0x00B7   # the panel's separator; this file stays ASCII-only for Windows PowerShell

# ---------- Marionette client ----------

function Read-Packet {
  $lenText = ''
  while ($true) {
    $b = $script:Stream.ReadByte()
    if ($b -lt 0) { throw 'Marionette connection closed' }
    if ($b -eq 58) { break }   # ':'
    $lenText += [char]$b
  }
  $len = [int]$lenText
  $buf = New-Object byte[] $len
  $read = 0
  while ($read -lt $len) {
    $n = $script:Stream.Read($buf, $read, $len - $read)
    if ($n -le 0) { throw 'Marionette connection closed' }
    $read += $n
  }
  [System.Text.Encoding]::UTF8.GetString($buf)
}

function Send-Command([string]$Command, $Params) {
  $script:MsgId++
  $json = ConvertTo-Json -InputObject @(0, $script:MsgId, $Command, $Params) -Compress -Depth 20
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $header = [System.Text.Encoding]::ASCII.GetBytes("$($bytes.Length):")
  $script:Stream.Write($header, 0, $header.Length)
  $script:Stream.Write($bytes, 0, $bytes.Length)
  while ($true) {
    $raw = Read-Packet
    if ($raw -match ('^\[1,' + $script:MsgId + ',')) { return $raw }
  }
}

function Invoke-Mn([string]$Command, $Params = @{}) {
  $resp = ConvertFrom-Json (Send-Command $Command $Params)
  if ($resp[2]) { throw "$Command failed: $($resp[2].error): $($resp[2].message)" }
  $resp[3]
}

# Runs JS in the page and parses the JSON string it returns.
function Invoke-Page([string]$Body) {
  ConvertFrom-Json (Invoke-Mn 'WebDriver:ExecuteScript' @{ script = $Body; args = @() }).value
}

function Save-Screenshot([string]$Path) {
  $raw = Send-Command 'WebDriver:TakeScreenshot' @{ full = $false; hash = $false }
  if ($raw -match '"value":"([^"]+)"') { [System.IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String($Matches[1])) }
}

# Firefox on Windows hands off to a second process, so find the test browser
# by its profile path and then its child processes.
function Get-TestPids {
  $all = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'")
  $pids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($p in $all) { if ($p.CommandLine -like "*$TestRoot*") { [void]$pids.Add([int]$p.ProcessId) } }
  do {
    $added = $false
    foreach ($p in $all) { if ($pids.Contains([int]$p.ParentProcessId) -and $pids.Add([int]$p.ProcessId)) { $added = $true } }
  } while ($added)
  , $pids
}

function Start-Firefox {
  $profileDir = Join-Path $TestRoot 'profile'
  if (Test-Path $profileDir) { Remove-Item -LiteralPath $profileDir -Recurse -Force }
  New-Item -ItemType Directory -Force $profileDir | Out-Null
  Set-Content -LiteralPath (Join-Path $profileDir 'user.js') -Encoding ascii -Value @(
    "user_pref(`"marionette.port`", $Port);"
    'user_pref("browser.shell.checkDefaultBrowser", false);'
    'user_pref("browser.startup.homepage_override.mstone", "ignore");'
    'user_pref("browser.aboutwelcome.enabled", false);'
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);'
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);'
    'user_pref("app.update.disabledForTesting", true);'
  )
  $null = Start-Process -FilePath $Firefox -ArgumentList @('-no-remote', '-profile', $profileDir, '-headless', '-marionette')
  $deadline = (Get-Date).AddSeconds(60)
  while ($true) {
    try { $script:Tcp = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $Port); break }
    catch { if ((Get-Date) -gt $deadline) { throw 'Firefox did not start (Marionette port not open)' }; Start-Sleep -Milliseconds 300 }
  }
  $script:Tcp.ReceiveTimeout = 200000
  $script:Stream = $script:Tcp.GetStream()
  [void](Read-Packet)   # hello
  [void](Invoke-Mn 'WebDriver:NewSession' @{})
  [void](Invoke-Mn 'WebDriver:SetTimeouts' @{ script = 180000; pageLoad = 90000 })
  [void](Invoke-Mn 'WebDriver:SetWindowRect' @{ width = 1280; height = 900 })
}

function Stop-Firefox {
  try { [void](Send-Command 'Marionette:Quit' @{ flags = @('eAttemptQuit') }) } catch { }
  try { $script:Tcp.Close() } catch { }
  for ($i = 0; $i -lt 40 -and (Get-TestPids).Count -gt 0; $i++) { Start-Sleep -Milliseconds 250 }
  foreach ($id in (Get-TestPids)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

function Check([string]$Name, $Actual, $Expected) {
  if ("$Actual" -eq "$Expected") { "PASS  $Name" }
  else { $script:Failures++; "FAIL  $Name`n        expected: $Expected`n        actual:   $Actual" }
}

# ---------- Page scripts ----------

# Waits for Whatnot's app to load; reports Cloudflare's bot check if that is
# what came up instead (it sometimes does for automated browsers).
$readyScript = @'
return (async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const page = window.wrappedJSObject || window;
  for (let i = 0; i < 80 && !page.__whatnot__; i++) await sleep(250);
  const text = document.body ? document.body.innerText : '';
  return JSON.stringify({ app: Boolean(page.__whatnot__), botCheck: /security verification|Just a moment/i.test(text) });
})();
'@

$signedOutScript = @'
return (async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let host = null;
  for (let i = 0; i < 60 && !(host = document.getElementById('whatnot-unfollow-manager')); i++) await sleep(250);
  if (!host) return JSON.stringify({ host: false });
  const sh = host.shadowRoot;
  const q = (s) => sh.querySelector(s);
  q('.launcher').click();
  for (let i = 0; i < 60 && !/Not signed in|Signed in|Couldn't/.test(q('.summary').textContent); i++) await sleep(250);
  const out = { host: true, summary: q('.summary').textContent };
  [...sh.querySelectorAll('.tabs button')].find((b) => b.textContent.startsWith('Keep list')).click();
  const keepTab = sh.querySelectorAll('.tab')[1];
  const input = keepTab.querySelector('input[type=text]');
  input.value = '@whatnot';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 60 && !/Added|no Whatnot|already|Couldn't|talk|answer|refused/.test(keepTab.querySelector('.keep-msg').textContent); i++) await sleep(250);
  out.addMsg = keepTab.querySelector('.keep-msg').textContent;
  return JSON.stringify(out);
})();
'@

$mockedRunScript = @'
return (async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Fake GraphQL endpoint, installed in the page's own world where the
  // add-on's bridge makes its requests.
  const mock = document.createElement('script');
  mock.textContent = `(() => {
    const realFetch = window.fetch;
    const users = Array.from({ length: 12 }, (_, i) => ({ id: btoa('PublicUserNode:' + (5000 + i)), username: 'mock_' + String(i + 1).padStart(2, '0'), displayName: i % 2 ? 'Mock Seller ' + (i + 1) : '', isFollowing: true, profileImage: null }));
    const following = new Set(users.map((u) => u.id));
    window.__mockCalls = [];
    const reply = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('/services/graphql/')) return realFetch.apply(this, arguments);
      const body = JSON.parse(init.body);
      const v = body.variables || {};
      window.__mockCalls.push(body.operationName + (v.active === false ? ':unfollow:' + atob(v.id) : ''));
      await new Promise((r) => setTimeout(r, 30));
      switch (body.operationName) {
        case 'CurrentUser': return reply({ data: { currentUser: { id: btoa('UserNode:4242'), username: 'mock_buyer', followingCount: following.size } } });
        case 'GetUser': return reply({ data: { getUser: v.username === 'mock_buyer' ? { id: btoa('PublicUserNode:4242'), username: 'mock_buyer', displayName: '', followingCount: following.size, profileImage: null } : null } });
        case 'Following': {
          const list = users.filter((u) => following.has(u.id));
          const start = v.after ? Number(v.after) : 0;
          const page = list.slice(start, start + v.first);
          const end = start + page.length;
          return reply({ data: { userFollowing: { pageInfo: { endCursor: String(end), hasNextPage: end < list.length }, edges: page.map((node) => ({ node })) } } });
        }
        case 'FollowUser':
          if (v.id === users[3].id) return reply({ data: { followUser: null }, errors: [{ message: 'User not found' }] });
          if (v.active) following.add(v.id); else following.delete(v.id);
          return reply({ data: { followUser: { success: true, user: { id: v.id, isFollowing: v.active } } } });
      }
      return realFetch.apply(this, arguments);
    };
  })();`;
  document.documentElement.append(mock);

  let host = null;
  for (let i = 0; i < 60 && !(host = document.getElementById('whatnot-unfollow-manager')); i++) await sleep(250);
  const sh = host.shadowRoot;
  const q = (s) => sh.querySelector(s);
  const tab = (name) => [...sh.querySelectorAll('.tabs button')].find((b) => b.textContent.startsWith(name));
  const footBtn = (label) => [...q('footer').querySelectorAll('button')].find((b) => !b.hidden && b.textContent.startsWith(label));
  const waitFor = async (re, el) => { for (let i = 0; i < 160 && !re.test(el().textContent); i++) await sleep(250); };
  const out = {};
  // Same page as the signed-out check: "Check again" reloads the list, this
  // time from the fake endpoint. (A second page load can trigger the bot check.)
  if (q('.panel').hidden) q('.launcher').click();
  tab('Following').click();
  const again = [...q('.status').querySelectorAll('button')].find((b) => b.textContent === 'Check again');
  if (!again) return JSON.stringify({ loaded: 'no "Check again" button; panel says: ' + q('.summary').textContent });
  again.click();
  await waitFor(/Signed in|Couldn't|Not signed/, () => q('.summary'));
  out.loaded = q('.summary').textContent;
  tab('Options').click();
  sh.querySelector('input[type=radio][value=fast]').click();
  tab('Following').click();
  const rows = [...sh.querySelectorAll('.tab')[0].querySelectorAll('.list .row')];
  if (rows.length < 2) {
    out.counts = 'no rows; panel says: ' + q('.status').innerText.replace(/\s+/g, ' ');
    out.calls = Array.from((window.wrappedJSObject || window).__mockCalls || []).join(', ');
    return JSON.stringify(out);
  }
  rows[0].querySelector('.keep').click();
  rows[1].querySelector('.keep').click();
  await sleep(200);
  footBtn('Unfollow').click();
  footBtn('Yes, unfollow').click();
  await waitFor(/Finished|Stopped|failures/, () => q('footer .note'));
  out.counts = q('footer .counts').textContent;
  out.failedRows = [...sh.querySelectorAll('.row.failed')].map((r) => r.querySelector('.handle').textContent + ' (' + r.title + ')').join(', ');
  const calls = Array.from((window.wrappedJSObject || window).__mockCalls);
  out.keptNeverCalled = !calls.some((c) => /PublicUserNode:500[01]$/.test(c));
  footBtn('Retry').click();
  await sleep(300);
  await waitFor(/Finished/, () => q('footer .note'));
  out.afterRetry = q('footer .counts').textContent;
  footBtn('Reload list').click();
  await sleep(300);
  await waitFor(/Signed in/, () => q('.summary'));
  out.afterReload = q('.summary').textContent;
  tab('Options').click();
  out.undo = sh.querySelectorAll('.tab')[2].querySelector('fieldset:last-child p').textContent.replace(/\(.*\) /, '');
  tab('Following').click();
  return JSON.stringify(out);
})();
'@

# ---------- Run ----------

"Add-on: $AddonPath"
"Firefox: $Firefox"
try {
  Start-Firefox
  $installed = Invoke-Mn 'Addon:Install' @{ path = $AddonPath; temporary = $true }
  Check 'installs as a temporary add-on' $installed.value '{853460fc-11ee-444b-893a-cb8bcbfa229c}'

  [void](Invoke-Mn 'WebDriver:Navigate' @{ url = 'https://www.whatnot.com/user/whatnot' })
  $ready = Invoke-Page $readyScript
  if (-not $ready.app) {
    if ($ready.botCheck) { throw "Whatnot's bot check (Cloudflare) stopped the headless test browser. Wait a few minutes and run the test again." }
    throw 'whatnot.com did not finish loading'
  }
  $a = Invoke-Page $signedOutScript
  Check 'panel appears on whatnot.com' $a.host 'True'
  Check 'signed-out state' $a.summary 'Not signed in to Whatnot.'
  Check 'keep list: add by username (real API)' $a.addMsg 'Added @whatnot.'

  $b = Invoke-Page $mockedRunScript
  Check 'loads the (fake) Following list' $b.loaded "Signed in as @mock_buyer $dot following 12 $dot keeping 0"
  Check 'bulk unfollow skips kept accounts' $b.keptNeverCalled 'True'
  Check 'bulk unfollow result' $b.counts "Unfollowed 9 of 10 $dot 1 failed"
  if ($b.calls) { "        fake API calls: $($b.calls)" }
  Check 'failed account is marked with the reason' $b.failedRows '@mock_04 (User not found)'
  Check 'retry of the failed account' $b.afterRetry "Unfollowed 0 of 1 $dot 1 failed"
  Check 'reload shows who is still followed' $b.afterReload "Signed in as @mock_buyer $dot following 3 $dot keeping 2"
  Check 'undo record' $b.undo 'Your last run unfollowed 9 accounts.'

  $shot = Join-Path $env:TEMP 'wum-firefox-test.png'
  Save-Screenshot $shot
  "Screenshot: $shot"
} catch {
  $script:Failures++
  "ERROR  $($_.Exception.Message)"
} finally {
  Stop-Firefox
  Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:Failures) { "$($script:Failures) check(s) failed"; exit 1 } else { 'All checks passed' }
