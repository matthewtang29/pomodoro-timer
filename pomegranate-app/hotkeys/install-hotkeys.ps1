# Global Windows hotkeys for Pomegranate, so the shortcuts work even when the app is closed:
#   Ctrl+Alt+Space  add a task
#   Ctrl+Alt+0      start a 25/5 session
# Windows only lets Start Menu shortcuts have Ctrl+Alt / Ctrl+Shift hotkeys, so these are
# the in-app Ctrl+Space / Ctrl+0 with Alt added. They open the installed app (or bring the
# open window forward) on ./?do=add or ./?do=focus, which shortcuts.js handles.
#
# Install the app from Chrome or Edge first, then run:
#   powershell -ExecutionPolicy Bypass -File hotkeys\install-hotkeys.ps1
# Run with -Uninstall to remove the hotkeys.

param([switch]$Uninstall)

$appUrl = 'https://matthewtang29.github.io/pomegranate/'
$programs = [Environment]::GetFolderPath('Programs')
$folder = Join-Path $programs 'Pomegranate Hotkeys'

if ($Uninstall) {
  Remove-Item $folder -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed the Pomegranate hotkeys.'
  return
}

# Find the shortcut Chrome / Edge made when the app was installed
$sh = New-Object -ComObject WScript.Shell
$app = Get-ChildItem $programs -Recurse -Filter 'Pomegranate.lnk' -ErrorAction SilentlyContinue |
  Where-Object { $_.DirectoryName -ne $folder } |
  ForEach-Object { $sh.CreateShortcut($_.FullName) } |
  Where-Object { $_.Arguments -match '--app-id=' } |
  Select-Object -First 1
if (-not $app) {
  Write-Host "Couldn't find the installed Pomegranate app. Install it from the browser (the install icon in the address bar), then run this again."
  exit 1
}

New-Item -ItemType Directory -Force $folder | Out-Null
$keys = @(
  @{ Name = 'Pomegranate - Add a task';     Do = 'add';   Key = 'Ctrl+Alt+Space' },
  @{ Name = 'Pomegranate - Start 25-5';     Do = 'focus'; Key = 'Ctrl+Alt+0' }
)
foreach ($k in $keys) {
  $lnk = $sh.CreateShortcut((Join-Path $folder "$($k.Name).lnk"))
  $lnk.TargetPath = $app.TargetPath
  $lnk.Arguments = "$($app.Arguments) --app-launch-url-for-shortcuts-menu-item=`"$($appUrl)?do=$($k.Do)`""
  $lnk.IconLocation = $app.IconLocation
  $lnk.Hotkey = $k.Key
  $lnk.Save()
  Write-Host "$($k.Key)  ->  $($k.Name)"
}
Write-Host 'Done. The hotkeys work from anywhere in Windows (give it a few seconds after installing).'
