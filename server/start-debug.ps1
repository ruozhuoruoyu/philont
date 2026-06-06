<#
.SYNOPSIS
  philont server 调试启动脚本(Windows PowerShell)

.DESCRIPTION
  - UTF-8 输出避免中文乱码
  - 5 个 autonomous budget caps 设为 0(无限制,调试场景解除门限)
  - 启动 server,日志同步写 console + logs/server-<timestamp>.log

.EXAMPLE
  cd E:\dev\philont\server
  .\start-debug.ps1

  另开一个 PS 窗口跟踪最新 log(类似 tail -f):
  Get-ChildItem .\logs\*.log | Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 | ForEach-Object {
      Get-Content $_.FullName -Wait -Tail 50
    }

.NOTES
  生产环境**不要用**此脚本 — 预算门全开。生产直接 npm run dev 走默认 caps。
  执行前可能需要解除策略限制:
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#>

# UTF-8 输出(中文日志不乱码)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

# Autonomous 预算 — 全部 0 = 无限制(调试期不被门限干扰)
# 0 在 budget.ts 内的语义已统一为"该维度无限制"(commit d7d8a5c)
$env:PHILONT_AUTONOMOUS_DAILY_TOKENS         = "0"
$env:PHILONT_AUTONOMOUS_DAILY_TOOL_CALLS     = "0"
$env:PHILONT_AUTONOMOUS_PER_TICK_TOKENS      = "0"
$env:PHILONT_AUTONOMOUS_PER_TICK_INITIATIVES = "0"
$env:PHILONT_AUTONOMOUS_PER_INITIATIVE_TOKENS= "0"

# 切到脚本所在目录(让 npm 找到 server/package.json)
Set-Location -Path $PSScriptRoot

# 准备 logs 目录
$logsDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

# 时间戳日志文件
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logsDir "server-$ts.log"

Write-Host "[debug] starting philont server"
Write-Host "[debug] cwd: $PSScriptRoot"
Write-Host "[debug] log: $logFile"
Write-Host "[debug] autonomous caps: ALL ZERO (unlimited)"
Write-Host ""

# 启动 server,屏幕 + 文件双写。Ctrl+C 停止后日志留下。
#
# 编码:Tee-Object 的 -Encoding 参数 PS 5.x 不支持(PS 7+ 才有),用 splatting
# 条件传参兼容两版本。PS 5.x 文件落盘是 Unicode/UTF-16 LE,中文不乱。
#
# 关键陷阱:PS 5.1 把 native command(node/npm)的 stderr 自动包装成
# RemoteException,即使 `2>&1` 合并了流,Tee-Object 落盘时仍带 PS 错误元
# 数据装饰("所在位置 行:1 字符:1..."),log 难看。
# 通过 `ForEach-Object { "$_" }` 把每条 pipeline 元素强制转字符串,装饰丢掉。
$teeArgs = @{ FilePath = $logFile }
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $teeArgs.Encoding = 'UTF8'
}
npm run dev 2>&1 | ForEach-Object { "$_" } | Tee-Object @teeArgs
