# Installs the clipsync agent from a GitHub release, on Windows:
#
#   irm https://clip.rfh.et/install.ps1 | iex
#
# The Worker serves this file with its own address and the releases repo
# filled in (apps/worker/src/routes/install.ts). It downloads the Windows
# build, checks it against the release's SHA256SUMS, links this device by QR
# if it is not enrolled yet, then runs `clipsync install`, which copies it to
# %LOCALAPPDATA%\Programs\clipsync and starts it at every logon. That folder
# is added to your user PATH. Re-run it to upgrade. Needs no administrator.
#
#   $env:CLIPSYNC_VERSION = 'v0.3.0'   a release tag instead of the latest
#   $env:CLIPSYNC_LINK = '0'           install without enrolling; `clipsync link` later
#   $env:CLIPSYNC_DOWNLOAD_BASE = ...  where to fetch the archive and SHA256SUMS
#
# Works in Windows PowerShell 5.1 and PowerShell 7. One script block, so a
# download cut short runs nothing.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # the progress bar slows downloads in 5.1

  $url = if ($env:CLIPSYNC_URL) { $env:CLIPSYNC_URL } else { '__CLIPSYNC_URL__' }
  $repo = '__CLIPSYNC_REPO__'
  $version = if ($env:CLIPSYNC_VERSION) { $env:CLIPSYNC_VERSION } else { 'latest' }
  $archive = 'clipsync-windows-x64.zip'

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'clipsync needs 64-bit Windows' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    Write-Host 'note         no ARM64 build yet; the x64 one runs under Windows emulation'
  }

  $base = if ($env:CLIPSYNC_DOWNLOAD_BASE) { $env:CLIPSYNC_DOWNLOAD_BASE }
    elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" }
    else { "https://github.com/$repo/releases/download/$version" }

  # Windows PowerShell 5.1 may still default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('clipsync-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "downloading  $archive ($version)"
    $zip = Join-Path $tmp $archive
    $sums = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $zip
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

    # "<hash>  <name>", or "<hash> *<name>" from a tool in binary mode.
    $expected = $null
    foreach ($line in Get-Content $sums) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)$' -and $Matches[2] -eq $archive) { $expected = $Matches[1].ToLower() }
    }
    if (-not $expected) { throw "SHA256SUMS lists no $archive" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($actual -ne $expected) { throw "checksum mismatch for ${archive}: expected $expected, got $actual" }
    Write-Host "verified     sha256 $actual"

    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $exe = Join-Path $tmp 'clipsync.exe'
    Write-Host "version      $(& $exe --version)"

    # Enrol from the downloaded copy, before the service exists: `install`
    # then starts it with credentials in place.
    if ((& $exe status | Out-String) -match '(?m)^Not configured') {
      if ($env:CLIPSYNC_LINK -eq '0') {
        Write-Host "enrol        skipped -- run 'clipsync link --url $url' when ready"
      } else {
        Write-Host ''
        Write-Host 'Link this device: scan the QR below with a device that is already set up.'
        Write-Host ''
        & $exe link --url $url
        if ($LASTEXITCODE -ne 0) { throw 'linking did not finish' }
      }
    }

    Write-Host ''
    & $exe install
    if ($LASTEXITCODE -ne 0) { throw 'clipsync install failed' }

    $dir = Join-Path $env:LOCALAPPDATA 'Programs\clipsync'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = if ($userPath) { $userPath -split ';' | Where-Object { $_ } } else { @() }
    if ($entries -notcontains $dir) {
      [Environment]::SetEnvironmentVariable('Path', (@($entries) + $dir) -join ';', 'User')
      $env:Path = "$env:Path;$dir"
      Write-Host ''
      Write-Host "Added $dir to your PATH; new terminals will find clipsync."
    }
  } finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
  }
}
