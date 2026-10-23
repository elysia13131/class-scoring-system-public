# Final enhanced firewall script for all scenarios.
# Specifically handles cases where 'Private' profile might have inherited block rules.
# Requires Administrative privileges.

Write-Host "Executing Final Firewall Repair..." -ForegroundColor Cyan

$ports = @(5173, 3001)

# 1. Kill any existing rules related to these ports to ensure a clean slate
Write-Host "Step 1: Clearing all existing rules for ports 5173 and 3001..." -ForegroundColor Yellow
Get-NetFirewallRule | Where-Object { 
    $p = $_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    ($p -ne $null) -and ($p.LocalPort -in $ports)
} | Remove-NetFirewallRule

# 2. Create high-priority allow rules for ALL profiles (Domain, Private, Public)
Write-Host "Step 2: Creating universal ALLOW rules for all network profiles..." -ForegroundColor Green
New-NetFirewallRule -DisplayName "ClassScoring_Universal_TCP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173,3001 -Profile Any -EdgeTraversalPolicy Allow
New-NetFirewallRule -DisplayName "ClassScoring_Universal_UDP" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5173,3001 -Profile Any -EdgeTraversalPolicy Allow

Write-Host "✅ 防火墙修复完成！" -ForegroundColor Green
Write-Host "--------------------------------------------------" -ForegroundColor Gray
Write-Host "如果专用网络仍无法连接，请检查：" -ForegroundColor Cyan
Write-Host "1. 路由器是否开启了 'AP 隔离' (AP Isolation)" -ForegroundColor White
Write-Host "2. 电脑是否安装了第三方杀毒软件（如360），需手动放行端口" -ForegroundColor White
Write-Host "3. 确保手机和电脑在同一个 Wi-Fi 名称下" -ForegroundColor White
