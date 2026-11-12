Unicode true
Name "DM Audio"
OutFile "${OUT_EXE}"
InstallDir "$LOCALAPPDATA\DM-Audio\app"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma

Section "Run DM Audio"
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE_DIR}\*.*"
  Exec '"$INSTDIR\DM Audio.exe"'
SectionEnd
