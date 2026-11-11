# Keeps the Windows speech system loaded and turns one line of text into one WAV file per request.
# Works with every voice installed in Windows (Zira, Hedda, or an old favourite you added yourself).
#
# Reads JSON lines:  {"id": 1, "text": "...", "out": "file.wav", "voice": "Microsoft Zira Desktop", "rate": 0}
#                    {"id": 2, "list": true}
# Writes JSON lines: {"id": 1, "ok": true}  /  {"id": 2, "voices": [...]}  /  {"id": 1, "error": "..."}

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

function Reply($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

Reply @{ ready = $true }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    if ($request.list) {
      $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
        @{ name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name; gender = "$($_.VoiceInfo.Gender)" }
      })
      Reply @{ id = $id; voices = $voices }
      continue
    }
    if ($request.voice) { $synth.SelectVoice([string]$request.voice) }
    $rate = 0
    if ($null -ne $request.rate) { $rate = [Math]::Max(-10, [Math]::Min(10, [int]$request.rate)) }
    $synth.Rate = $rate
    $synth.SetOutputToWaveFile([string]$request.out)
    $synth.Speak([string]$request.text)
    $synth.SetOutputToNull()
    Reply @{ id = $id; ok = $true }
  } catch {
    try { $synth.SetOutputToNull() } catch { }
    Reply @{ id = $id; error = $_.Exception.Message }
  }
}
