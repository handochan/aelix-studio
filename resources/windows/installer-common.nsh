!ifndef AIONUI_INSTALLER_COMMON_NSH
!define AIONUI_INSTALLER_COMMON_NSH
!include "${PROJECT_DIR}\resources\windows\support\studio-protocol.nsh"
!include "installer-observability.nsh"
!include "installer-errors-sentry.nsh"
!include "installer-process-control.nsh"
!include "installer-remove-registry.nsh"
!include "installer-repair-heal.nsh"
!include "installer-update-verify.nsh"
!endif
