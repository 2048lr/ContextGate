[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName=ContextGate
AppVersion=5.0.0
AppVerName=ContextGate v5.0.0
AppPublisher=ContextGate Team
AppPublisherURL=https://github.com/contextgate/contextgate
AppSupportURL=https://github.com/contextgate/contextgate
AppUpdatesURL=https://github.com/contextgate/contextgate
DefaultDirName={autopf}\ContextGate
DefaultGroupName=ContextGate
AllowNoIcons=yes
LicenseFile=
InfoBeforeFile=
InfoAfterFile=
OutputDir=c:\Users\Administrator\ContextGate\csharp\publish
OutputBaseFilename=ContextGate-5.0.0-win-x64-setup
SetupIconFile=
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\ContextGate.Desktop.exe
UninstallDisplayName=ContextGate
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1; Check: not IsAdminInstallMode
Name: "addtopath"; Description: "Add CLI to PATH"; GroupDescription: "System:"; Flags: unchecked

[Files]
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\ContextGate.Desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\appsettings.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\appsettings.Development.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\cli\*"; DestDir: "{app}\cli"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\proxy\*"; DestDir: "{app}\proxy"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\cli.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\proxy.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "c:\Users\Administrator\ContextGate\csharp\publish\ContextGate\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\ContextGate"; Filename: "{app}\ContextGate.Desktop.exe"
Name: "{group}\ContextGate CLI"; Filename: "{app}\cli.bat"
Name: "{group}\ContextGate Proxy"; Filename: "{app}\proxy.bat"
Name: "{group}\{cm:ProgramOnTheWeb,ContextGate}"; Filename: "https://github.com/contextgate/contextgate"
Name: "{group}\{cm:UninstallProgram,ContextGate}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\ContextGate"; Filename: "{app}\ContextGate.Desktop.exe"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\ContextGate"; Filename: "{app}\ContextGate.Desktop.exe"; Tasks: quicklaunchicon

[Run]
Filename: "{app}\ContextGate.Desktop.exe"; Description: "{cm:LaunchProgram,ContextGate}"; Flags: nowait postinstall skipifsilent

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\cli"; Tasks: addtopath; Check: NeedsAddPath('{app}\cli')

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;
