; Extra steps for the CINCO ID installer.
; The installer keeps a copy of itself in the per-user "updater" folder. Removing the app removes
; that copy too, so nothing is left behind. (Settings and projects in the app data folder stay.)
!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\cinco-id-updater"
!macroend
