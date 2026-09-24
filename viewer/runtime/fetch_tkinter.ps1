<#
.SYNOPSIS
  Fetches Tcl/Tk + tkinter into the bundled embeddable Python runtime.

.DESCRIPTION
  viewer/runtime/python is python.org's "embeddable zip" distribution of
  CPython. That distribution deliberately ships without Tcl/Tk and without
  the tkinter stdlib package (unlike the full python.org installer), so
  `import tkinter` fails out of the box and ingest.py's file-picker GUI
  can't start.

  This script downloads the official python.org "tcltk.msi" component for
  the exact CPython version already bundled in viewer/runtime/python,
  extracts it with `msiexec /a` (an administrative install -- this just
  unpacks the MSI's files, it does not run installer custom actions or
  touch the registry), and copies the pieces the embeddable runtime needs:

    DLLs/_tkinter.pyd, tcl86t.dll, tk86t.dll, zlib1.dll  -> runtime root
    Lib/tkinter/                                          -> runtime Lib/tkinter
    tcl/tcl8.6/, tcl/tk8.6/                               -> runtime tcl/

  It also makes sure "Lib" is on the runtime's search path via
  python312._pth (site-packages already gets picked up automatically via
  `import site`, but Lib/tkinter is not a site-packages layout so it needs
  an explicit path entry).

  This keeps the ~6 MB Tcl/Tk payload out of git, same as
  viewer/runtime/python/Lib/site-packages is already gitignored for pip
  packages -- both are fetched on demand instead of committed.

  Safe to run multiple times: if viewer/runtime/python/Lib/tkinter already
  exists, the script exits immediately without downloading anything.
#>

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RuntimeDir = Join-Path $PSScriptRoot "python"
$PythonExe  = Join-Path $RuntimeDir "python.exe"
$TkinterDir = Join-Path $RuntimeDir "Lib\tkinter"
$PthFile    = Join-Path $RuntimeDir "python312._pth"

if ((Test-Path $TkinterDir) -and -not $Force) {
    Write-Host "tkinter already present in the bundled runtime -- nothing to do."
    exit 0
}

if (-not (Test-Path $PythonExe)) {
    Write-Error "Bundled runtime not found at $PythonExe -- can't determine which Tcl/Tk version to fetch."
    exit 1
}

# Ask the bundled interpreter its own exact version so we fetch a matching
# Tcl/Tk build instead of hardcoding a version that could drift out of sync
# if the bundled runtime is ever upgraded.
$PyVersion = & $PythonExe -c "import sys; print('%d.%d.%d' % sys.version_info[:3])"
if ([string]::IsNullOrWhiteSpace($PyVersion)) {
    Write-Error "Could not determine bundled Python version."
    exit 1
}
Write-Host "Bundled Python version: $PyVersion"

$MsiUrl = "https://www.python.org/ftp/python/$PyVersion/amd64/tcltk.msi"
$Work   = Join-Path $env:TEMP "glacierscope_tcltk_$PID"
New-Item -ItemType Directory -Force -Path $Work | Out-Null

try {
    $MsiPath = Join-Path $Work "tcltk.msi"
    Write-Host "Downloading Tcl/Tk from $MsiUrl ..."
    Invoke-WebRequest -Uri $MsiUrl -OutFile $MsiPath -UseBasicParsing
    $sizeMB = [math]::Round((Get-Item $MsiPath).Length / 1MB, 1)
    Write-Host "Downloaded tcltk.msi ($sizeMB MB)."

    $ExtractDir = Join-Path $Work "extract"
    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null

    Write-Host "Extracting (msiexec /a -- unpack only, no install/registry changes) ..."
    $LogPath = Join-Path $Work "msiexec.log"
    $proc = Start-Process msiexec.exe -ArgumentList @(
        "/a", "`"$MsiPath`"",
        "/qn",
        "TARGETDIR=`"$ExtractDir`"",
        "/log", "`"$LogPath`""
    ) -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) {
        throw "msiexec extraction failed with exit code $($proc.ExitCode). See $LogPath"
    }

    $SrcDlls   = Join-Path $ExtractDir "DLLs"
    $SrcTkPkg  = Join-Path $ExtractDir "Lib\tkinter"
    $SrcTcl86  = Join-Path $ExtractDir "tcl\tcl8.6"
    $SrcTk86   = Join-Path $ExtractDir "tcl\tk8.6"

    foreach ($p in @($SrcDlls, $SrcTkPkg, $SrcTcl86, $SrcTk86)) {
        if (-not (Test-Path $p)) { throw "Expected extracted path missing: $p" }
    }

    Write-Host "Copying files into bundled runtime ..."
    foreach ($dll in @("_tkinter.pyd", "tcl86t.dll", "tk86t.dll", "zlib1.dll")) {
        Copy-Item (Join-Path $SrcDlls $dll) -Destination $RuntimeDir -Force
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "Lib") | Out-Null
    Copy-Item $SrcTkPkg -Destination (Join-Path $RuntimeDir "Lib\tkinter") -Recurse -Force

    $TclDir = Join-Path $RuntimeDir "tcl"
    New-Item -ItemType Directory -Force -Path $TclDir | Out-Null
    Copy-Item $SrcTcl86 -Destination (Join-Path $TclDir "tcl8.6") -Recurse -Force
    Copy-Item $SrcTk86  -Destination (Join-Path $TclDir "tk8.6")  -Recurse -Force

    # Make sure "Lib" is a search path entry in python312._pth so
    # Lib/tkinter is importable (site-packages is found automatically via
    # `import site`, but this is not a site-packages layout).
    if (Test-Path $PthFile) {
        $lines = Get-Content $PthFile
        if (-not ($lines -contains "Lib")) {
            Add-Content -Path $PthFile -Value "Lib"
        }
    }

    Write-Host "Verifying import ..."
    $verify = & $PythonExe -c "import tkinter; r = tkinter.Tk(); r.withdraw(); print('tkinter ok')" 2>&1
    if ($LASTEXITCODE -ne 0 -or $verify -notmatch "tkinter ok") {
        throw "Post-install verification failed: $verify"
    }
    Write-Host "tkinter is now importable in the bundled runtime."
}
finally {
    if (Test-Path $Work) {
        Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
    }
}
