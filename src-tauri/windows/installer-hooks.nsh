!include "WinVer.nsh"

!macro NSIS_HOOK_PREINSTALL
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "DOHC Viewer requires Windows 10 or later."
    Abort
  ${EndIf}
!macroend
