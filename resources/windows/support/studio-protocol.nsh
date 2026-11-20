!ifndef STUDIO_PROTOCOL_NSH
!define STUDIO_PROTOCOL_NSH

!define STUDIO_PROTOCOL_KEY "Software\Classes\aelix-studio"

!macro STUDIO_REGISTER_PROTOCOL
  WriteRegStr SHELL_CONTEXT "${STUDIO_PROTOCOL_KEY}" "" "URL:Aelix Studio Protocol"
  WriteRegStr SHELL_CONTEXT "${STUDIO_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "${STUDIO_PROTOCOL_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${STUDIO_PROTOCOL_KEY}\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

!macro STUDIO_UNREGISTER_PROTOCOL
  Push $0
  ReadRegStr $0 SHELL_CONTEXT "${STUDIO_PROTOCOL_KEY}\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
    DeleteRegKey SHELL_CONTEXT "${STUDIO_PROTOCOL_KEY}"
  ${EndIf}
  Pop $0
!macroend

!endif
