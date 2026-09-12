param([string]$OutputPath)
# Requires PowerShell 7. Packaging never changes Codex's global configuration.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $repoRoot 'plugins/formlex'
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot '../formlex-plugin.zip' }
$archivePath = [System.IO.Path]::GetFullPath($OutputPath)
$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$scratchPath = Join-Path $tempParent ('formlex-package-' + [guid]::NewGuid().ToString('N'))
$scratchFullPath = [System.IO.Path]::GetFullPath($scratchPath)
if ([System.IO.Path]::GetDirectoryName($scratchFullPath).TrimEnd('\','/') -ne $tempParent.TrimEnd('\','/')) { throw '临时目录边界无效。' }
New-Item -ItemType Directory -Path $scratchFullPath | Out-Null

function Invoke-NodeChecked {
    param([string[]]$NodeArguments, [string]$ExtractedPlugin)
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $nodePath
    $info.WorkingDirectory = $repoRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    foreach ($argument in $NodeArguments) { $info.ArgumentList.Add($argument) }
    if ($ExtractedPlugin) { $info.Environment['FORMLEX_TEST_PLUGIN_ROOT'] = $ExtractedPlugin }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { $process.Kill($true); [void]$process.WaitForExit(5000); throw 'Node 验证超过 60 秒，已关闭子进程。' }
        Write-Host $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($errorText) { Write-Host $errorText }
        if ($process.ExitCode -ne 0) { throw "Node 验证失败，退出码 $($process.ExitCode)。" }
    } finally {
        if ($process.Id -and -not $process.HasExited) { $process.Kill($true); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}

try {
    Invoke-NodeChecked -NodeArguments @('scripts/build-plugin.mjs')
    Invoke-NodeChecked -NodeArguments @('scripts/build-plugin.mjs', '--check')
    $stagedZip = Join-Path $scratchFullPath 'formlex-plugin.zip'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($pluginRoot, $stagedZip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    $extracted = Join-Path $scratchFullPath '解压 验证'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($stagedZip, $extracted)
    $extractedPlugin = Join-Path $extracted 'formlex'
    if (-not (Test-Path -LiteralPath (Join-Path $extractedPlugin '.codex-plugin/plugin.json'))) { throw '压缩包缺少插件清单。' }
    Invoke-NodeChecked -NodeArguments @('--test', 'tests.test.mjs', 'mcp.test.mjs', 'plugin.test.mjs') -ExtractedPlugin $extractedPlugin
    $destinationParent = [System.IO.Path]::GetDirectoryName($archivePath)
    [void][System.IO.Directory]::CreateDirectory($destinationParent)
    Copy-Item -LiteralPath $stagedZip -Destination $archivePath -Force
    Write-Host "插件包：$archivePath"
    Write-Host "SHA256：$((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash)"
} finally {
    if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($scratchFullPath)).TrimEnd('\','/') -ne $tempParent.TrimEnd('\','/')) { throw '拒绝清理超出临时目录的路径。' }
    Remove-Item -LiteralPath $scratchFullPath -Recurse -Force
}
Write-Host 'DONE'
exit 0
