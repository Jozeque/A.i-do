' AI Video Studio - desktop launcher
' Starts the local server hidden, waits until it is ready, then opens a
' chromeless app window (Microsoft Edge / Chrome). Double-click to run.
Option Explicit

Dim shell, fso, root, url, nodeExe, browser, ready, tries
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
url = "http://localhost:4505"

' 1) If the server is not already running, start it hidden.
ready = ServerUp(url)
If Not ready Then
    nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
    If Not fso.FileExists(nodeExe) Then nodeExe = "node"
    ' window style 0 = hidden, do not wait. The --avs-launcher marker lets the
    ' "Stop AI Video Studio" script find exactly this process to shut it down.
    shell.Run """" & nodeExe & """ server\index.js --avs-launcher", 0, False
    tries = 0
    Do While (Not ready) And (tries < 60)
        WScript.Sleep 500
        ready = ServerUp(url)
        tries = tries + 1
    Loop
End If

If Not ready Then
    MsgBox "AI Video Studio could not start the server. Make sure Node.js is installed and that you ran 'npm install' once in this folder.", 48, "AI Video Studio"
    WScript.Quit 1
End If

' 2) Open a chromeless app window (Edge, then Chrome, else the default browser).
browser = FindBrowser()
If browser <> "" Then
    shell.Run """" & browser & """ --app=" & url & " --window-size=1440,920", 1, False
Else
    shell.Run url, 1, False
End If

Function ServerUp(u)
    On Error Resume Next
    Dim h
    Set h = CreateObject("MSXML2.XMLHTTP")
    h.Open "GET", u & "/api/health", False
    h.Send
    ServerUp = (Err.Number = 0) And (h.Status = 200)
    On Error GoTo 0
End Function

Function FindBrowser()
    Dim list, p
    list = Array( _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"))
    For Each p In list
        If fso.FileExists(p) Then
            FindBrowser = p
            Exit Function
        End If
    Next
    FindBrowser = ""
End Function
