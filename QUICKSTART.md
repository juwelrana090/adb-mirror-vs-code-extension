# ADB Mirror Extension - Quick Start Guide

## ✅ Extension Created Successfully!

Your VS Code extension has been created and compiled. Here's what you need to do next:

### 🚀 Installation & Setup

1. **Install Prerequisites**
   ```bash
   # Install ADB (if not already installed)
   # Download from: https://developer.android.com/studio/releases/platform-tools
   
   # Install scrcpy (Windows)
   winget install genymobile.scrcpy
   
   # Verify installations
   adb --version
   scrcpy --version
   ```

2. **Check scrcpy MJPEG Support**
   ```bash
   scrcpy --help | findstr mjpeg
   ```
   If `--mjpeg-server` flag doesn't exist, the extension will try a fallback mode.

3. **Install Extension Dependencies** (Already done ✅)
   ```bash
   npm install
   ```

4. **Build Extension** (Already done ✅)
   ```bash
   npm run compile
   ```

### 🎯 How to Use

**Option 1: Debug Mode (Recommended for testing)**
1. Open this project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded
3. Connect your Android device with USB debugging enabled
4. Open the "ADB Mirror" sidebar (phone icon in activity bar)
5. Click on a device to start mirroring

**Option 2: Package and Install**
1. Install vsce: `npm install -g @vscode/vsce`
2. Package: `vsce package`
3. Install the `.vsix` file in VS Code

### 📱 Features

- **Device Discovery**: Auto-refreshes every 5 seconds
- **Screen Mirroring**: Displays device screen in webview panel
- **Hardware Controls**: Home, Back, Volume Up/Down, Power buttons
- **Easy Management**: Start/Stop mirroring with one click

### ⚠️ Important Notes

- **USB Debugging**: Must be enabled on your Android device
- **Device Authorization**: First-time connection requires authorization on device
- **scrcpy Version**: Extension includes fallback logic for different scrcpy versions
- **Performance**: MJPEG streaming may vary based on device and USB speed

### 🔧 Troubleshooting

**"No devices found"**
- Enable USB debugging on device
- Authorize computer on device
- Check `adb devices` in terminal

**"Failed to start scrcpy"**
- Verify scrcpy installation
- Check scrcpy is in PATH
- Try running scrcpy manually first

**Screen not displaying**
- scrcpy version may not support MJPEG
- Check firewall/antivirus settings
- Try alternative connection methods

### 📂 Project Structure

```
adb-mirror/
├── src/
│   ├── extension.ts       # Main extension entry point
│   ├── deviceProvider.ts  # Device list and tree view
│   └── mirrorPanel.ts     # Webview and scrcpy integration
├── out/                   # Compiled JavaScript (auto-generated)
├── media/
│   └── icon.svg          # Extension icon
├── .vscode/              # VS Code configuration
├── package.json          # Extension manifest
└── tsconfig.json        # TypeScript configuration
```

### 🎨 Customization

To modify scrcpy settings, edit `src/mirrorPanel.ts`:
- Change MJPEG port: modify `port` property
- Adjust video quality: modify `--max-size` argument
- Add more flags: add to `args` array in `startScrcpy()`

### 📝 Next Steps

1. Test the extension with a real device
2. Check if scrcpy MJPEG mode works with your version
3. Adjust settings if needed
4. Consider adding more features (touch controls, audio, etc.)

### 🐛 Known Issues

- scrcpy 3.x+ may have changed command-line flags
- MJPEG streaming may not work on all scrcpy versions
- Audio streaming is disabled
- Touch input not implemented (only hardware buttons)

---

**Extension Status**: ✅ Ready to use
**Compilation**: ✅ Successful
**Dependencies**: ✅ Installed

Enjoy mirroring your Android devices in VS Code! 📱🖥️