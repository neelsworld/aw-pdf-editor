; SPDX-License-Identifier: AGPL-3.0-or-later
; AW PDF Editor for Windows installer. Built by build-windows.sh with makensis (adapted from AW Signer's).
; Installs for the current user only (no administrator rights), into %LOCALAPPDATA%\Programs\AW PDF Editor.
; Adds AW PDF Editor to "Open with" for PDFs without making it the default PDF app.
; Not code-signed yet: Windows SmartScreen warns until it is ("More info" > "Run anyway").

; Not Unicode: Homebrew's makensis crashes on this Mac writing a Unicode installer (see AW Signer's).
Unicode false
!ifndef VERSION
  !error "VERSION must be given"
!endif
!ifndef STAGE
  !error "STAGE must point at the staged files"
!endif
!ifndef OUTFILE
  !define OUTFILE "AW-PDF-Editor-${VERSION}-windows-x64-setup.exe"
!endif

!define APPNAME "AW PDF Editor"
!define EXE "AW PDF Editor.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AccredWorksAWPDFEditor"
!define PROGID "AccredWorks.AWPDFEditor.pdf"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\AW PDF Editor"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel user
; Not /SOLID: Homebrew's makensis writes no file at all (and still exits 0) for a solid LZMA
; installer of this size (~290 MB staged). Non-solid is ~4 MB bigger.
SetCompressor lzma
Icon "${STAGE}\AW PDF Editor.ico"
UninstallIcon "${STAGE}\AW PDF Editor.ico"
BrandingText "AccredWorks"

!include "MUI2.nsh"
!define MUI_ICON "${STAGE}\AW PDF Editor.ico"
!define MUI_UNICON "${STAGE}\AW PDF Editor.ico"
!define MUI_WELCOMEPAGE_TITLE "AW PDF Editor ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "AW PDF Editor is a free PDF editor that works offline. Your files never leave this computer.$\r$\n$\r$\nIt is free software under the GNU AGPL, version 3 or later, and comes with no warranty.$\r$\n$\r$\nIt installs for your user account only and does not need administrator rights."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open AW PDF Editor"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "AccredWorks"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "AccredWorks. GNU AGPL-3.0-or-later."

Section "Install"
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\aw-pdf-worker"   ; rebuilt each time
  File /r "${STAGE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\AW PDF Editor.ico"

  ; "Open with AW PDF Editor" for PDFs (not the default: the person's choice stays as it is).
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "PDF document"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\AW PDF Editor.ico"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "AccredWorks"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\AW PDF Editor.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "URLInfoAbout" "https://accredworks.com/pdf-editor"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  RMDir /r "$INSTDIR\aw-pdf-worker"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\AW PDF Editor.ico"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\TRADEMARKS.md"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${PROGID}"
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${EXE}"
  DeleteRegKey HKCU "${UNINSTKEY}"
  ; The person's PDFs and settings (recent files) are left alone.
SectionEnd
