# The pinned NSIS CopyFiles path can drop deep npm directories. Re-extract the
# same embedded payload and copy it with the OS long-path-aware implementation.
# The app and installer qualification still verify the complete source seal.
!ifndef BUILD_UNINSTALLER
  !ifdef APP_PACKAGE_URL
    !error "Studio long-path copy requires an embedded NSIS package"
  !endif
  !ifdef ZIP_COMPRESSION
    !error "Studio long-path copy requires the embedded 7z format"
  !endif
  !ifndef APP_64
    !error "Studio long-path copy currently qualifies Windows x64 only"
  !endif
  !ifdef APP_32
    !error "Studio long-path copy does not qualify multi-architecture packages"
  !endif
  !ifdef APP_ARM64
    !error "Studio long-path copy does not qualify multi-architecture packages"
  !endif

  Var studioRepairOutput
  Var studioRepairStage
  Var studioRepairCopy
  Var studioRepairExit

  !macro customInstall
    StrCpy $studioRepairOutput $OUTDIR
    StrCpy $studioRepairStage "$PLUGINSDIR\r"
    ClearErrors
    CreateDirectory "$studioRepairStage"
    IfErrors studio_copy_failed
    SetOutPath "$studioRepairStage"
    Nsis7z::Extract "$PLUGINSDIR\app-$packageArch.7z"
    IfFileExists "$studioRepairStage\${APP_EXECUTABLE_FILENAME}" 0 studio_copy_failed
    IfFileExists "$studioRepairStage\resources\bundled-aioncore\win32-x64\manifest.json" 0 studio_copy_failed

    # NSIS is a 32-bit process; Sysnative bypasses WOW64 redirection without
    # changing system policy or relying on the caller's PATH or a shell.
    StrCpy $studioRepairCopy "$WINDIR\Sysnative\robocopy.exe"
    IfFileExists "$studioRepairCopy" +2 0
      StrCpy $studioRepairCopy "$SYSDIR\robocopy.exe"
    StrCpy $studioRepairExit -1
    ClearErrors
    ExecWait '"$studioRepairCopy" "$studioRepairStage" "$INSTDIR" /E /COPY:DAT /DCOPY:DAT /IS /IT /SL /R:0 /W:0 /NFL /NDL /NP /NJH /NJS' $studioRepairExit
    IfErrors studio_copy_failed
    ${If} $studioRepairExit < 0
    ${OrIf} $studioRepairExit >= 8
      Goto studio_copy_failed
    ${EndIf}
    SetOutPath "$studioRepairOutput"
    RMDir /r "$studioRepairStage"
    Goto studio_copy_done

    studio_copy_failed:
      SetOutPath "$studioRepairOutput"
      RMDir /r "$studioRepairStage"
      MessageBox MB_OK|MB_ICONSTOP "$(decompressionFailed)" /SD IDOK
      SetErrorLevel 1603
      Abort
    studio_copy_done:
  !macroend
!endif
