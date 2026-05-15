# ADB Mirror VS Code Extension

Mirror and control Android devices directly inside VS Code.

## What This Extension Does

- Shows connected Android devices in a sidebar tree.
- Starts phone screen mirroring in the ADB Mirror view.
- Supports touch control (tap/swipe) from the mirror view.
- Supports keyboard control (text typing, Enter, Backspace, arrows, etc).
- Provides quick hardware key actions (Home, Back, Volume, Power).
- Uses scrcpy MJPEG when available, with ADB screencap fallback.

## Prerequisites

1. ADB installed and available in PATH.
2. USB debugging enabled on your Android device.
3. scrcpy installed (recommended for better performance).

Install scrcpy:

- Windows: `winget install Genymobile.scrcpy`
- macOS: `brew install scrcpy`
- Linux: install from your distro package manager

Verify tools:

```bash
adb version
scrcpy --version
```

## Install and Run (Development)

1. Install dependencies:

```bash
npm install
```

2. Compile:

```bash
npm run compile
```

3. Start extension host:

- Press `F5` in VS Code.
- A new Extension Development Host window opens.

## Install as VSIX (Optional)

1. Install vsce:

```bash
npm install -g @vscode/vsce
```

2. Build VSIX:

```bash
vsce package
```

3. In VS Code, run command: `Extensions: Install from VSIX...`

## How To Use in VS Code

1. Open the ADB Mirror activity bar view.
2. In the Devices section, find your phone (for example `192.168.x.x:5555`).
3. Run Start Mirror from the device context action.
4. Mirror appears in the Mirror section.

Control tips:

- Click inside the phone screen once before typing.
- Use mouse/pointer for tap and drag for swipe.
- Use keyboard to type text into focused field on phone.
- Use toolbar buttons for Home, Back, Volume Up/Down, Power.

Stop session:

- Click Stop in toolbar, or run command `adbMirror.stopMirror`.

## Keyboard Input Notes

- Typing from your PC keyboard sends text directly to Android input.
- Paste is supported from clipboard.
- Special keys are mapped to Android key events (for example Enter, Backspace, arrows).
- If typing does not work, click the mirrored screen and try again.

## Extension Settings

Open VS Code Settings and search for `adbMirror`.

- `adbMirror.scrcpyPath`: custom scrcpy executable path.
- `adbMirror.adbFrameIntervalMs`: fallback frame interval (ms).
- `adbMirror.scrcpyMaxSize`: maximum frame size.
- `adbMirror.scrcpyMaxFps`: target FPS.
- `adbMirror.scrcpyVideoBitRate`: scrcpy bitrate (for example `4M`, `8M`).
- `adbMirror.autoRealtime`: start in realtime profile.

Recommended low-latency values:

- `scrcpyMaxSize = 540` or `720`
- `scrcpyMaxFps = 60`
- `scrcpyVideoBitRate = 4M` to `8M`

### Recommended VS Code Settings (Windows)

Add this to your VS Code `settings.json`:

```json
{
  "adbMirror.scrcpyPath": "C:\\path\\to\\scrcpy\\scrcpy.exe",
  "adbMirror.adbFrameIntervalMs": 30,
  "adbMirror.scrcpyMaxFps": 120,
  "adbMirror.scrcpyMaxSize": 360,
  "adbMirror.scrcpyVideoBitRate": "2M",
  "adbMirror.performancePreset": "Realtime"
}
```

Note: if your current extension build does not expose `adbMirror.performancePreset` yet, the rest of the settings still apply.

## Troubleshooting

### No devices listed

- Run `adb devices` and confirm your device is present.
- Reconnect cable or reconnect TCP device.
- Accept the USB debugging authorization prompt on phone.

### Mirror view is blank or broken

- Run `scrcpy --version` and verify scrcpy is installed.
- The extension will fallback to ADB screencap if MJPEG is unavailable.
- Reload VS Code window: `Developer: Reload Window`.

### Keyboard typing is not working

- Click once inside the mirrored phone screen.
- Ensure a text field is focused on the phone.
- Try paste (`Ctrl+V`) to confirm text pipeline is active.

### Activation errors about duplicate views/providers

Examples:

- `View provider for 'adbMirrorView' already registered`
- `Cannot register multiple views with same id 'adbMirrorDevices'`

Fix:

1. Run `Developer: Reload Window`.
2. Ensure only one copy of this extension is enabled.
3. If developing, stop old Extension Host windows before pressing `F5` again.

## Commands

- `adbMirror.refreshDevices`
- `adbMirror.startMirror`
- `adbMirror.stopMirror`
- `adbMirror.sendHome`
- `adbMirror.sendBack`
- `adbMirror.sendVolumeUp`
- `adbMirror.sendVolumeDown`
- `adbMirror.sendPower`
- `adbMirror.realtimeMode`

## Project Structure

```text
src/
  extension.ts           # extension activation and command registration
  deviceProvider.ts      # device discovery and tree view
  mirrorViewProvider.ts  # sidebar mirror webview + session logic
  mirrorPanel.ts         # standalone panel mirror implementation
```

## License

MIT
