!include "WinVer.nsh"

Var LegacyViewerDirectory

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "Delta Viewer requires Windows 10 or later."
    Abort
  ${EndIf}

  ; Keep the old installation location when upgrading the renamed product.
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DOHC Viewer" "MainBinaryName"
  ReadRegStr $LegacyViewerDirectory HKCU "Software\dohc\DOHC Viewer" ""
  ${If} $R0 == "dohc-viewer.exe"
  ${AndIf} ${FileExists} "$LegacyViewerDirectory\dohc-viewer.exe"
    ${If} $INSTDIR == "$LOCALAPPDATA\Delta Viewer"
      StrCpy $INSTDIR $LegacyViewerDirectory
      SetOutPath $INSTDIR
    ${EndIf}
    ${If} $INSTDIR == $LegacyViewerDirectory
      ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DOHC Viewer" "DisplayVersion"
      ${VersionCompare} "$R1" "${VERSION}" $R2
      ${If} $R2 == 1
        MessageBox MB_ICONSTOP|MB_OK "A newer Viewer version is already installed."
        Abort
      ${EndIf}
    ${EndIf}
  ${Else}
    StrCpy $LegacyViewerDirectory ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $LegacyViewerDirectory != ""
  ${AndIf} $INSTDIR == $LegacyViewerDirectory
    !insertmacro IsShortcutTarget "$DESKTOP\DOHC Viewer.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 == 1
      Delete "$DESKTOP\DOHC Viewer.lnk"
      CreateShortcut "$DESKTOP\Delta Viewer.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\Delta Viewer.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\DOHC Viewer.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 == 1
      Delete "$SMPROGRAMS\DOHC Viewer.lnk"
    ${EndIf}
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DOHC Viewer"
    DeleteRegKey HKCU "Software\dohc\DOHC Viewer"
  ${EndIf}
!macroend
