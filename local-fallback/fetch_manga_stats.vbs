Dim xml, json, url, fso, file, logPath, errorLogPath, units, match, regEx, existingContent, lastMatch, lastValue
Dim targetPos, searchChunk, timestamp, attempt, success, statusCode

' ---- Tunable settings ----
Const MAX_RETRIES = 3
Const RETRY_DELAY_MS = 2000
Const ANOMALY_THRESHOLD = 500   ' flag jumps of this many chapters or more instead of trusting them

' Cache-busting seed
timestamp = Replace(Replace(Replace(Now, "/", ""), " ", ""), ":", "")

url = "https://kitsu.io/api/edge/users/1699796/stats?cachebuster=" & timestamp
logPath = "C:\Users\zobik\Downloads\manga_history_data.js"
errorLogPath = "C:\Users\zobik\Downloads\sync_errors.log"

Set fso = CreateObject("Scripting.FileSystemObject")

' ---------------------------------------------------------------
' Error logging — every failure gets a timestamped line here, so
' "no new chapters" (silent, expected) is distinguishable from
' "the sync has been broken for three days" (logged, needs a look).
' ---------------------------------------------------------------
Sub LogError(msg)
    Dim ef
    On Error Resume Next
    Set ef = fso.OpenTextFile(errorLogPath, 8, True) ' 8 = ForAppending, create if missing
    ef.WriteLine "[" & Now & "] " & msg
    ef.Close
    On Error Goto 0
End Sub

' ---------------------------------------------------------------
' Backup rotation — copy the current file out before every write,
' so a bad regex replace or malformed response can't silently
' wreck the whole history. One rolling .bak plus one dated copy
' per day (same-day reruns just refresh that day's copy).
' ---------------------------------------------------------------
Sub BackupDataFile()
    If fso.FileExists(logPath) Then
        Dim datedBackup, folder
        folder = fso.GetParentFolderName(logPath)
        datedBackup = folder & "\manga_history_data_" & Year(Now) & _
            Right("0" & Month(Now), 2) & Right("0" & Day(Now), 2) & ".bak.js"
        On Error Resume Next
        fso.CopyFile logPath, folder & "\manga_history_data.bak", True
        fso.CopyFile logPath, datedBackup, True
        If Err.Number <> 0 Then
            LogError "WARNING: backup copy failed - " & Err.Description
            Err.Clear
        End If
        On Error Goto 0
    End If
End Sub

' ---------------------------------------------------------------
' Fetch with retry — a single dropped connection no longer means
' a silently skipped sync.
' ---------------------------------------------------------------
success = False
statusCode = 0
For attempt = 1 To MAX_RETRIES
    Set xml = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    On Error Resume Next
    xml.open "GET", url, False
    xml.setRequestHeader "Cache-Control", "no-cache, no-store, must-revalidate"
    xml.setRequestHeader "Pragma", "no-cache"
    xml.setRequestHeader "If-Modified-Since", "Sat, 1 Jan 2000 00:00:00 GMT"
    xml.send
    If Err.Number <> 0 Then
        LogError "Attempt " & attempt & "/" & MAX_RETRIES & " failed - request error: " & Err.Description
        Err.Clear
        On Error Goto 0
        If attempt < MAX_RETRIES Then WScript.Sleep RETRY_DELAY_MS
    Else
        On Error Goto 0
        statusCode = xml.status
        If statusCode = 200 Then
            success = True
            Exit For
        Else
            LogError "Attempt " & attempt & "/" & MAX_RETRIES & " failed - HTTP status " & statusCode
            If attempt < MAX_RETRIES Then WScript.Sleep RETRY_DELAY_MS
        End If
    End If
Next

If Not success Then
    LogError "SYNC FAILED after " & MAX_RETRIES & " attempts - last status: " & statusCode
    Set xml = Nothing
    Set fso = Nothing
    WScript.Quit 1
End If

json = xml.responseText

targetPos = InStr(json, """kind"":""manga-amount-consumed""")
if targetPos = 0 then targetPos = InStr(json, """kind"": ""manga-amount-consumed""")

If targetPos = 0 Then
    LogError "SYNC FAILED - 'manga-amount-consumed' kind not found in API response (status 200 but unexpected payload)"
    Set xml = Nothing
    Set fso = Nothing
    WScript.Quit 1
End If

searchChunk = Mid(json, targetPos, 300)

Set regEx = New RegExp
regEx.Pattern = """units""\s*:\s*(\d+)"

If Not regEx.Test(searchChunk) Then
    LogError "SYNC FAILED - could not parse 'units' value from response chunk near manga-amount-consumed"
    Set xml = Nothing
    Set fso = Nothing
    WScript.Quit 1
End If

Set match = regEx.Execute(searchChunk)
units = Trim(match(0).SubMatches(0))

' 1. If file missing, initialize with standard flat object format
If Not fso.FileExists(logPath) Then
    Set file = fso.CreateTextFile(logPath, True)
    file.WriteLine "const mangaHistoryData = ["
    file.WriteLine "  { date1: """ & Now & """, date2: """ & Now & """, chapters: " & units & " }"
    file.WriteLine "];"
    file.Close
Else
    ' 2. Read existing content
    Set file = fso.OpenTextFile(logPath, 1)
    existingContent = file.ReadAll
    file.Close

    ' Strip array closing elements
    existingContent = Replace(existingContent, "];", "")

    ' CRITICAL FIX: Strip ANY hidden spaces, enters, or windows carriage returns from the file text
    Set regEx = New RegExp
    regEx.Pattern = "[\s\r\n]+$"
    existingContent = regEx.Replace(existingContent, "")

    ' Pull the latest registered chapter total
    Set regEx = New RegExp
    regEx.Pattern = "chapters:\s*(\d+)"
    regEx.Global = True

    lastValue = ""
    If regEx.Test(existingContent) Then
        Set lastMatch = regEx.Execute(existingContent)
        lastValue = Trim(lastMatch(lastMatch.Count - 1).SubMatches(0))
    End If

    ' -----------------------------------------------------------
    ' Anomaly guard — a jump this big is more likely a malformed
    ' API response than 500 chapters read since the last check.
    ' Flag it and skip the write rather than polluting pace stats.
    ' -----------------------------------------------------------
    If lastValue <> "" Then
        If (CLng(units) - CLng(lastValue)) >= ANOMALY_THRESHOLD Then
            LogError "ANOMALY - new units value " & units & " is " & (CLng(units) - CLng(lastValue)) & _
                " higher than last recorded " & lastValue & " (threshold " & ANOMALY_THRESHOLD & _
                "). Entry skipped - review manually before re-running."
            Set xml = Nothing
            Set fso = Nothing
            WScript.Quit 1
        End If
    End If

    ' Back up before we touch the file
    BackupDataFile()

    Set file = fso.OpenTextFile(logPath, 2)

    If units = lastValue Then
        ' SAME NUMBER: Target and replace only the date2 property of the final object array item
        Set regEx = New RegExp
        regEx.Pattern = "(date2:\s*""[^""]+"")([ \t]*,\s*chapters:\s*" & units & "\s*\})$"

        existingContent = regEx.Replace(existingContent, "date2: """ & Now & """" & "$2")
        file.Write existingContent & vbCrLf & "];"
    Else
        ' NEW NUMBER: Safely append a trailing comma to the true bracket end
        If Right(existingContent, 1) = "}" Then
            existingContent = existingContent & ","
        End If

        file.WriteLine existingContent
        file.WriteLine "  { date1: """ & Now & """, date2: """ & Now & """, chapters: " & units & " }"
        file.Write "];"
    End If
    file.Close
End If

Set xml = Nothing
Set fso = Nothing
