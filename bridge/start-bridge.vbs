' start-bridge.vbs — launches the AdsPower bridge with NO window.
' Double-clicking this (or the login task) starts node bridge.js hidden.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
' 0 = hidden window, False = don't wait
sh.Run "node """ & scriptDir & "\bridge.js""", 0, False
