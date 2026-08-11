@echo off
schtasks /delete /tn "AdsPowerBridge" /f
echo.
echo Auto-start removed - the bridge will not launch on next login.
echo To stop it right now: open Task Manager, find the node.exe running
echo bridge.js, and End task (or just log off / reboot).
echo.
pause
