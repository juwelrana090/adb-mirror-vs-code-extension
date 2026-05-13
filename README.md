# ADB Mirror VS Code Extension

Mirror Android devices directly in VS Code using scrcpy.

## Features

- 📱 List connected Android devices in the sidebar
- 🖥️ Mirror device screen in a VS Code webview panel
- 🎮 Hardware button controls (Home, Back, Volume, Power)
- 🔄 Auto-refresh device list every 5 seconds
- 🚀 One-click start/stop mirroring

## Prerequisites

1. **ADB (Android Debug Bridge)** - Install as part of Android SDK or standalone
2. **scrcpy** - Screen copying utility
   - **Windows**: Install via winget: `winget install genymobile.scrcpy`
   - **macOS**: Install via brew: `brew install scrcpy`
   - **Linux**: Install via package manager (varies by distro)

### Important: scrcpy Version Compatibility

This extension is designed to work with scrcpy v3.x+. The `--mjpeg-server` flag may not be available in newer versions. The extension includes fallback logic for different scrcpy versions, but you may need to adjust the `startScrcpy()` method in `mirrorPanel.ts` based on your scrcpy version.

### Check your scrcpy version and flags:

```bash
scrcpy --version
scrcpy --help | grep mjpeg
```

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile the TypeScript:
   ```bash
   npm run compile
   ```
4. Package the extension (optional):
   ```bash
   npm run vscode:prepublish
   ```

### Install in VS Code

**Method 1: From Source**
1. Open VS Code
2. Press `F5` to launch a new Extension Development Host window
3. The extension will be active in the new window

**Method 2: Package and Install**
1. Install vsce: `npm install -g @vscode/vsce`
2. Package: `vsce package`
3. Install the `.vsix` file in VS Code

## Usage

1. **Connect your Android device** via USB with USB debugging enabled
2. **Open the ADB Mirror sidebar** (phone icon in activity bar)
3. **Click on a device** to start mirroring
4. **Use the control buttons** to send hardware key events
5. **Click "Stop"** or close the panel to stop mirroring

### Key Events

- **Home** ( keycode 3)
- **Back** (keycode 4)
- **Volume Up** (keycode 24)
- **Volume Down** (keycode 25)
- **Power** (keycode 26)

## Troubleshooting

### "No devices found"
- Make sure USB debugging is enabled on your device
- Try `adb devices` in terminal to verify ADB can see your device
- Check that you have authorized the computer on your device

### "Failed to start scrcpy"
- Verify scrcpy is installed: `scrcpy --version`
- Check if scrcpy is in your system PATH
- Try running scrcpy manually first to ensure it works

### Screen not displaying / Connection issues
- Your scrcpy version may not support `--mjpeg-server` flag
- Check scrcpy help for available flags
- You may need to modify the `startScrcpy()` method in `mirrorPanel.ts`
- Try running `scrcpy --help` to see available options in your version

### ADB not found
- Make sure ADB is installed and in your system PATH
- On Windows, ADB is typically part of Android SDK Platform-Tools

## Development

### Project Structure

```
adb-mirror/
├── src/
│   ├── extension.ts       # Entry point, registers commands and sidebar
│   ├── deviceProvider.ts  # ADB device listing and tree view
│   └── mirrorPanel.ts     # Webview panel and scrcpy integration
├── media/
│   └── icon.svg
├── package.json
└── tsconfig.json
```

### Build and Watch

```bash
# Compile once
npm run compile

# Watch for changes
npm run watch
```

## Known Issues

- scrcpy 3.x+ may have changed command-line options
- MJPEG streaming may not work with newer scrcpy versions
- Audio streaming is disabled (`--no-audio` flag)
- The webview may show connection errors if scrcpy doesn't support the MJPEG server mode

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Credits

- [scrcpy](https://github.com/Genymobile/scrcpy) - Display and control of Android devices
- [ADB](https://developer.android.com/studio/command-line/adb) - Android Debug Bridge
- [VS Code Extension API](https://code.visualstudio.com/api)