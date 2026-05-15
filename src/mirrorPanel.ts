import * as vscode from "vscode";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import * as http from "http";

const execAsync = promisify(exec);

type StreamMode = "unknown" | "scrcpy-mjpeg" | "adb-screencap";
type PerformancePreset = "ultraLowLatency" | "balanced" | "quality";

interface ScrcpySupport {
  installed: boolean;
  mjpegSupported: boolean;
  version: string;
}

interface DeviceScreenSize {
  width: number;
  height: number;
}

interface PerformanceConfig {
  maxSize: number;
  maxFps: number;
  bitRate: string;
  label: string;
}

const PERFORMANCE_PRESETS: Record<PerformancePreset, PerformanceConfig> = {
  "ultraLowLatency": { maxSize: 480, maxFps: 60, bitRate: "2M", label: "Ultra Fast" },
  "balanced": { maxSize: 720, maxFps: 60, bitRate: "4M", label: "Balanced" },
  "quality": { maxSize: 1080, maxFps: 30, bitRate: "8M", label: "High Quality" },
};

export class MirrorPanel {
  private panel: vscode.WebviewPanel | undefined;
  private scrcpyProcess: ReturnType<typeof spawn> | undefined;
  private frameTimer: NodeJS.Timeout | undefined;
  private frameInFlight = false;
  private frameFailureCount = 0;
  private streamMode: StreamMode = "unknown";
  private isDisposed = false;
  private deviceScreenSize: DeviceScreenSize | undefined;
  private scrcpyCommand = "scrcpy";
  private readonly serial: string;
  private readonly port: number = 27183;
  private readonly onDispose?: () => void;
  private adbFrameIntervalMs = 80;
  private scrcpyMaxSize = 720;
  private scrcpyMaxFps = 60;
  private scrcpyVideoBitRate = "4M";
  private currentPreset: PerformancePreset = "balanced";

  constructor(serial: string, onDispose?: () => void) {
    this.serial = serial;
    this.onDispose = onDispose;
    this.loadPerformanceConfig();
  }

  private loadPerformanceConfig(): void {
    const config = vscode.workspace.getConfiguration("adbMirror");

    const configuredFrameInterval = Number(
      config.get<number>("adbFrameIntervalMs", 80),
    );
    this.adbFrameIntervalMs = Math.max(
      20,
      Math.min(500, configuredFrameInterval),
    );

    const configuredMaxSize = Number(config.get<number>("scrcpyMaxSize", 720));
    this.scrcpyMaxSize = Math.max(360, Math.min(1600, configuredMaxSize));

    const configuredMaxFps = Number(config.get<number>("scrcpyMaxFps", 60));
    this.scrcpyMaxFps = Math.max(15, Math.min(120, configuredMaxFps));

    const configuredBitRate = config
      .get<string>("scrcpyVideoBitRate", "8M")
      .trim();
    this.scrcpyVideoBitRate = configuredBitRate || "8M";
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "adbMirror",
      `Mirror: ${this.serial}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.getWebviewContent();
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "sendKeyEvent":
          await this.sendKeyEvent(Number(message.keyCode));
          break;
        case "refreshStream":
          if (this.streamMode === "adb-screencap") {
            await this.pushSingleFrame();
          }
          break;
        case "stopMirror":
          this.dispose();
          break;
        case "sendTap":
          await this.sendTap(
            Number(message.normalizedX),
            Number(message.normalizedY),
          );
          break;
        case "sendSwipe":
          await this.sendSwipe(
            Number(message.startX),
            Number(message.startY),
            Number(message.endX),
            Number(message.endY),
            Number(message.durationMs),
          );
          break;
        case "applyPreset":
          await this.applyPreset(message.preset as PerformancePreset);
          break;
      }
    });
    this.panel.onDidDispose(() => this.dispose(false));

    await this.startStreaming();
  }

  async sendKeyEvent(keyCode: number): Promise<void> {
    try {
      await execAsync(
        `adb -s "${this.serial}" shell input keyevent ${keyCode}`,
        {
          shell: true as any,
          timeout: 5000,
        } as any,
      );
    } catch (error) {
      const message = `Failed to send key event: ${String(error)}`;
      vscode.window.showErrorMessage(message);
      this.notifyWebview("error", message);
    }
  }

  private async sendTap(
    normalizedX: number,
    normalizedY: number,
  ): Promise<void> {
    try {
      const coords = await this.mapNormalizedToDeviceCoords(
        normalizedX,
        normalizedY,
      );
      if (!coords) {
        throw new Error("Could not resolve device screen size");
      }

      await execAsync(
        `adb -s "${this.serial}" shell input tap ${coords.x} ${coords.y}`,
        {
          shell: true as any,
          timeout: 5000,
        } as any,
      );
    } catch (error) {
      this.notifyWebview("status", `Touch input failed: ${String(error)}`);
    }
  }

  private async sendSwipe(
    startNormalizedX: number,
    startNormalizedY: number,
    endNormalizedX: number,
    endNormalizedY: number,
    durationMs: number,
  ): Promise<void> {
    try {
      const startCoords = await this.mapNormalizedToDeviceCoords(
        startNormalizedX,
        startNormalizedY,
      );
      const endCoords = await this.mapNormalizedToDeviceCoords(
        endNormalizedX,
        endNormalizedY,
      );
      if (!startCoords || !endCoords) {
        throw new Error("Could not resolve device screen size");
      }

      const clampedDuration = Math.max(80, Math.min(2000, durationMs || 250));
      await execAsync(
        `adb -s "${this.serial}" shell input swipe ${startCoords.x} ${startCoords.y} ${endCoords.x} ${endCoords.y} ${clampedDuration}`,
        {
          shell: true as any,
          timeout: 7000,
        } as any,
      );
    } catch (error) {
      this.notifyWebview("status", `Swipe input failed: ${String(error)}`);
    }
  }

  private async mapNormalizedToDeviceCoords(
    normalizedX: number,
    normalizedY: number,
  ): Promise<{ x: number; y: number } | undefined> {
    const size = await this.getDeviceScreenSize();
    if (!size) {
      return undefined;
    }

    const clampedX = Math.max(0, Math.min(1, normalizedX));
    const clampedY = Math.max(0, Math.min(1, normalizedY));

    return {
      x: Math.round(clampedX * (size.width - 1)),
      y: Math.round(clampedY * (size.height - 1)),
    };
  }

  private async getDeviceScreenSize(): Promise<DeviceScreenSize | undefined> {
    if (this.deviceScreenSize) {
      return this.deviceScreenSize;
    }

    try {
      const { stdout } = await execAsync(
        `adb -s "${this.serial}" shell wm size`,
        {
          shell: true as any,
          timeout: 5000,
        } as any,
      );

      const match = String(stdout).match(/(\d+)x(\d+)/);
      if (!match) {
        return undefined;
      }

      this.deviceScreenSize = {
        width: Number(match[1]),
        height: Number(match[2]),
      };
      return this.deviceScreenSize;
    } catch {
      return undefined;
    }
  }

  private async startStreaming(): Promise<void> {
    this.stopBackends();

    this.scrcpyCommand = await this.resolveScrcpyCommand();

    const support = await this.getScrcpySupport();

    if (support.installed && support.mjpegSupported) {
      try {
        await this.startScrcpyMjpeg();
        return;
      } catch (error) {
        this.notifyWebview(
          "status",
          `scrcpy MJPEG failed, falling back to ADB screenshots: ${String(error)}`,
        );
      }
    }

    let reason: string;
    if (!support.installed) {
      reason = "scrcpy not found. Using ADB screenshot fallback.";
    } else if (!support.mjpegSupported) {
      reason = `scrcpy ${support.version} has no --mjpeg-server. Using ADB screenshot fallback.`;
    } else {
      reason = "Using ADB screenshot fallback.";
    }

    await this.startAdbScreencapStream(reason);
  }

  private async startScrcpyMjpeg(): Promise<void> {
    this.stopBackends();

    const args = [
      "-s",
      this.serial,
      "--no-audio",
      `--mjpeg-server=${this.port}`,
      `--max-size=${this.scrcpyMaxSize}`,
      `--max-fps=${this.scrcpyMaxFps}`,
      `--video-bit-rate=${this.scrcpyVideoBitRate}`,
    ];

    this.scrcpyProcess = spawn(this.scrcpyCommand, args, {
      detached: false,
      shell: true,
    });

    let startupStderr = "";
    this.scrcpyProcess.stderr?.on("data", (data) => {
      startupStderr += String(data);
    });

    this.scrcpyProcess.on("error", (error) => {
      this.notifyWebview("error", `scrcpy failed to start: ${error.message}`);
    });

    this.scrcpyProcess.on("close", (code) => {
      if (this.streamMode === "scrcpy-mjpeg" && code !== 0 && code !== null) {
        this.notifyWebview(
          "error",
          `scrcpy exited unexpectedly (code ${code})`,
        );
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    if (!this.scrcpyProcess.pid || this.scrcpyProcess.exitCode !== null) {
      throw new Error(startupStderr || "scrcpy exited immediately");
    }

    const mjpegReady = await this.waitForMjpegServer(4, 500);
    if (!mjpegReady) {
      throw new Error("scrcpy started but MJPEG endpoint is unreachable");
    }

    this.streamMode = "scrcpy-mjpeg";
    this.notifyWebview("backend", { mode: this.streamMode, port: this.port });
    this.notifyWebview(
      "status",
      `Streaming via scrcpy MJPEG on port ${this.port} (${this.scrcpyMaxFps} FPS target)`,
    );
  }

  private async startAdbScreencapStream(reason: string): Promise<void> {
    this.streamMode = "adb-screencap";
    this.notifyWebview("backend", { mode: this.streamMode, port: this.port });
    this.notifyWebview(
      "status",
      `${reason} Running ADB fallback at ~${Math.round(1000 / this.adbFrameIntervalMs)} FPS target.`,
    );

    const firstFrame = await this.captureFrameWithAdb();
    if (!firstFrame || firstFrame.length === 0) {
      throw new Error("Could not capture initial frame via adb");
    }
    this.notifyWebview("frame", {
      dataUrl: `data:image/png;base64,${firstFrame.toString("base64")}`,
    });

    this.startAdbFrameLoop();
  }

  private async applyPreset(preset: PerformancePreset): Promise<void> {
    const config = PERFORMANCE_PRESETS[preset];
    if (!config) {
      return;
    }

    this.currentPreset = preset;
    this.scrcpyMaxSize = config.maxSize;
    this.scrcpyMaxFps = config.maxFps;
    this.scrcpyVideoBitRate = config.bitRate;

    this.notifyWebview("status", `Applied preset: ${config.label}`);
    this.notifyWebview("presetApplied", { preset, config });

    // Restart streaming with new settings
    if (this.streamMode === "scrcpy-mjpeg") {
      await this.startStreaming();
    }
  }

  private startAdbFrameLoop(): void {
    const runLoop = async () => {
      if (this.streamMode !== "adb-screencap" || this.isDisposed) {
        return;
      }

      const startedAt = Date.now();
      await this.pushSingleFrame();
      const elapsedMs = Date.now() - startedAt;
      const nextDelayMs = Math.max(10, this.adbFrameIntervalMs - elapsedMs);

      this.frameTimer = setTimeout(() => {
        void runLoop();
      }, nextDelayMs);
    };

    this.frameTimer = setTimeout(() => {
      void runLoop();
    }, 0);
  }

  private async waitForMjpegServer(
    attempts: number,
    delayMs: number,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const ok = await this.checkMjpegEndpoint();
      if (ok) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
  }

  private async checkMjpegEndpoint(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: this.port,
          path: "/",
          timeout: 1500,
        },
        (res) => {
          // Any HTTP response means the endpoint is reachable.
          res.resume();
          resolve(Boolean(res.statusCode));
        },
      );

      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });

      req.on("error", () => {
        resolve(false);
      });
    });
  }

  private async getScrcpySupport(): Promise<ScrcpySupport> {
    try {
      const { stdout, stderr } = await execAsync(
        `"${this.scrcpyCommand}" --help`,
        {
          shell: true as any,
          timeout: 5000,
        } as any,
      );

      const output = String(stdout) + String(stderr);
      const mjpegSupported = output.includes("--mjpeg-server");
      const version = await this.getScrcpyVersion();
      return { installed: true, mjpegSupported, version };
    } catch (error) {
      if (
        this.isCommandMissing(String(error)) &&
        this.scrcpyCommand === "scrcpy"
      ) {
        vscode.window
          .showWarningMessage(
            "scrcpy was not found. Set adbMirror.scrcpyPath or install scrcpy. Falling back to ADB screenshot streaming.",
            "Open scrcpy Download Page",
          )
          .then((selection) => {
            if (selection === "Open scrcpy Download Page") {
              void vscode.env.openExternal(
                vscode.Uri.parse(
                  "https://github.com/Genymobile/scrcpy/releases",
                ),
              );
            }
          });
      }
      return { installed: false, mjpegSupported: false, version: "unknown" };
    }
  }

  private async getScrcpyVersion(): Promise<string> {
    try {
      const versionOutput = await execAsync(
        `"${this.scrcpyCommand}" --version`,
        {
          shell: true as any,
          timeout: 5000,
        } as any,
      );
      return (
        String(versionOutput.stdout).match(/scrcpy\s+([^\s]+)/)?.[1] ||
        "unknown"
      );
    } catch {
      return "unknown";
    }
  }

  private isCommandMissing(errorText: string): boolean {
    const lower = errorText.toLowerCase();
    return (
      lower.includes("not found") ||
      lower.includes("not recognized") ||
      lower.includes("enoent")
    );
  }

  private async resolveScrcpyCommand(): Promise<string> {
    const configPath = vscode.workspace
      .getConfiguration("adbMirror")
      .get<string>("scrcpyPath", "")
      .trim();

    if (configPath) {
      return configPath;
    }

    const inPath = await this.canExecuteScrcpy("scrcpy");
    if (inPath) {
      return "scrcpy";
    }

    const platform = process.platform;
    const candidates: string[] = [];

    if (platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || "";
      const programFiles = process.env.ProgramFiles || "";
      const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
      if (localAppData) {
        candidates.push(
          `${localAppData}\\Microsoft\\WinGet\\Links\\scrcpy.exe`,
        );
      }
      if (programFiles) {
        candidates.push(`${programFiles}\\scrcpy\\scrcpy.exe`);
      }
      if (programFilesX86) {
        candidates.push(`${programFilesX86}\\scrcpy\\scrcpy.exe`);
      }
    }

    for (const candidate of candidates) {
      const exists = await this.canExecuteScrcpy(candidate);
      if (exists) {
        return candidate;
      }
    }

    return "scrcpy";
  }

  private async canExecuteScrcpy(command: string): Promise<boolean> {
    try {
      await execAsync(`"${command}" --version`, {
        shell: true as any,
        timeout: 4000,
      } as any);
      return true;
    } catch {
      return false;
    }
  }

  private async pushSingleFrame(): Promise<void> {
    if (
      this.frameInFlight ||
      !this.panel ||
      !this.panel.visible ||
      this.streamMode !== "adb-screencap"
    ) {
      return;
    }

    this.frameInFlight = true;
    try {
      const frameBuffer = await this.captureFrameWithAdb();
      if (!frameBuffer || frameBuffer.length === 0) {
        throw new Error("Empty frame received from adb");
      }

      const dataUrl = `data:image/png;base64,${frameBuffer.toString("base64")}`;
      this.notifyWebview("frame", { dataUrl });
      this.frameFailureCount = 0;
    } catch (error) {
      this.frameFailureCount += 1;
      if (this.frameFailureCount === 1 || this.frameFailureCount % 8 === 0) {
        this.notifyWebview(
          "status",
          `Frame capture retrying: ${String(error)}`,
        );
      }
    } finally {
      this.frameInFlight = false;
    }
  }

  private async captureFrameWithAdb(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        "adb",
        ["-s", this.serial, "exec-out", "screencap", "-p"],
        {
          shell: true,
        },
      );
      const chunks: Buffer[] = [];
      let stderr = "";

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("adb frame capture timed out"));
      }, 5000);

      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr || `adb exited with code ${code}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  private notifyWebview(
    type: string,
    payload: Record<string, unknown> | string,
  ): void {
    if (!this.panel) {
      return;
    }

    const data = typeof payload === "string" ? { message: payload } : payload;
    void this.panel.webview.postMessage({ type, ...data });
  }

  private stopBackends(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }

    if (this.scrcpyProcess) {
      this.scrcpyProcess.kill();
      this.scrcpyProcess = undefined;
    }

    this.streamMode = "unknown";
  }

  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ADB Mirror</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            flex-direction: column;
            align-items: center;
            height: 100vh;
            box-sizing: border-box;
        }

        .container {
            display: flex;
            flex-direction: column;
            align-items: center;
            width: 100%;
            height: 100%;
        }

        .stream-container {
            flex: 1;
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
            max-width: 800px;
            background-color: #000;
            border-radius: 12px;
            overflow: hidden;
            position: relative;
        }

        #stream {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            touch-action: none;
            user-select: none;
            -webkit-user-drag: none;
            cursor: none;
        }

        #touchCursor {
            position: absolute;
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.8);
            border-radius: 50%;
            pointer-events: none;
            transform: translate(-50%, -50%);
            display: none;
            z-index: 10;
        }

        #touchCursor::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 4px;
            height: 4px;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 50%;
            transform: translate(-50%, -50%);
        }

        #touchCursor.active {
            background: rgba(100, 180, 255, 0.3);
            border-color: rgba(100, 180, 255, 1);
        }

        .controls {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 16px;
            justify-content: center;
            width: 100%;
            max-width: 800px;
        }

        .control-group {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            justify-content: center;
            align-items: center;
        }

        .control-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 0 4px;
        }

        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            transition: background-color 0.2s;
            min-width: 80px;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button:active {
            background-color: var(--vscode-button-activeBackground);
        }

        button.preset-btn {
            min-width: 100px;
        }

        button.preset-btn.active {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            box-shadow: inset 0 0 0 1px var(--vscode-button-border);
        }

        .status {
            margin-top: 12px;
            padding: 10px 16px;
            border-radius: 6px;
            background-color: var(--vscode-editorInfo-background);
            color: var(--vscode-editorInfo-foreground);
            font-size: 12px;
            text-align: center;
            max-width: 800px;
            width: 100%;
        }

        .error {
            background-color: var(--vscode-errorBackground);
            color: var(--vscode-errorForeground);
        }

        h1 {
            font-size: 18px;
            margin: 0 0 16px 0;
            color: var(--vscode-editor-foreground);
        }

        .loading {
            color: var(--vscode-editor-foreground);
            font-size: 14px;
            text-align: center;
        }

        .preset-info {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>ADB Mirror - ${this.serial}</h1>

        <div class="stream-container">
            <div class="loading">Starting scrcpy server...</div>
            <img id="stream" style="display: none;" alt="Device screen" />
            <div id="touchCursor"></div>
        </div>

        <div class="controls">
            <div class="control-group">
                <span class="control-label">Quality</span>
                <button class="preset-btn" onclick="applyPreset('ultraLowLatency')" data-preset="ultraLowLatency">Ultra Fast</button>
                <button class="preset-btn active" onclick="applyPreset('balanced')" data-preset="balanced">Balanced</button>
                <button class="preset-btn" onclick="applyPreset('quality')" data-preset="quality">Quality</button>
            </div>
        </div>

        <div class="controls">
            <div class="control-group">
                <button onclick="sendKeyEvent(3)" title="Home">Home</button>
                <button onclick="sendKeyEvent(4)" title="Back">Back</button>
                <button onclick="sendKeyEvent(26)" title="Power">Power</button>
            </div>
            <div class="control-group">
                <button onclick="sendKeyEvent(24)" title="Volume Up">Vol+</button>
                <button onclick="sendKeyEvent(25)" title="Volume Down">Vol-</button>
            </div>
            <div class="control-group">
                <button onclick="refreshStream()" title="Refresh Stream">Refresh</button>
                <button onclick="stopMirror()" title="Stop Mirror">Stop</button>
            </div>
        </div>

        <div class="status" id="status">Connecting to device...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const stream = document.getElementById('stream');
        const status = document.getElementById('status');
        const loadingDiv = document.querySelector('.loading');
        const touchCursor = document.getElementById('touchCursor');
        let backendMode = 'unknown';
        let streamPort = ${this.port};
        let retryCount = 0;
        const maxRetries = 10;
        let isConnected = false;
        let pointerStart = null;
        let currentPreset = 'balanced';

        stream.onload = () => {
          if (backendMode === 'scrcpy-mjpeg') {
            status.textContent = 'Connected to device - Streaming active';
          }
            status.className = 'status';
            isConnected = true;
            retryCount = 0;
        };

        stream.onerror = () => {
          if (backendMode !== 'scrcpy-mjpeg') {
            return;
          }

            if (!isConnected && retryCount < maxRetries) {
                retryCount++;
                status.textContent = \`Connection attempt \${retryCount}/\${maxRetries} - Retrying in 2 seconds...\`;
                status.className = 'status';
                setTimeout(() => {
                    if (!isConnected) {
                    loadScrcpyStream();
                    }
                }, 2000);
            } else if (!isConnected) {
                status.textContent = 'Connection failed - Check if scrcpy is installed and running';
                status.className = 'status error';
                console.error('Failed to connect after', maxRetries, 'attempts');
            }
        };

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
            case 'backend':
              backendMode = message.mode || 'unknown';
              streamPort = message.port || streamPort;
              if (backendMode === 'scrcpy-mjpeg') {
                status.textContent = 'Starting scrcpy stream...';
                loadScrcpyStream();
              } else if (backendMode === 'adb-screencap') {
                status.textContent = 'Streaming via ADB screenshot fallback';
                status.className = 'status';
              }
              break;
            case 'frame':
              if (message.dataUrl) {
                stream.src = message.dataUrl;
                stream.style.display = 'block';
                loadingDiv.style.display = 'none';
                isConnected = true;
              }
              break;
                case 'error':
                    status.textContent = \`Error: \${message.message}\`;
                    status.className = 'status error';
                    break;
                case 'status':
                    status.textContent = message.message;
                    status.className = 'status';
                    break;
                case 'presetApplied':
                    currentPreset = message.preset;
                    updatePresetButtons();
                    break;
            }
        });

          function loadScrcpyStream() {
            const timestamp = new Date().getTime();
            stream.src = \`http://localhost:\${streamPort}/?\${timestamp}\`;
            stream.style.display = 'block';
            loadingDiv.style.display = 'none';
        }

        function sendKeyEvent(code) {
            vscode.postMessage({
                command: 'sendKeyEvent',
                keyCode: code
            });
        }

        function refreshStream() {
      if (backendMode === 'scrcpy-mjpeg') {
        status.textContent = 'Refreshing stream...';
        retryCount = 0;
        isConnected = false;
        loadScrcpyStream();
      } else {
        vscode.postMessage({
          command: 'refreshStream'
        });
      }
        }

        function stopMirror() {
            vscode.postMessage({
                command: 'stopMirror'
            });
        }

        function applyPreset(preset) {
            vscode.postMessage({
                command: 'applyPreset',
                preset: preset
            });
        }

        function updatePresetButtons() {
            document.querySelectorAll('.preset-btn').forEach(btn => {
                if (btn.dataset.preset === currentPreset) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }

        function getNormalizedTouchPoint(event) {
          const rect = stream.getBoundingClientRect();
          if (!rect.width || !rect.height) {
            return null;
          }

          const x = (event.clientX - rect.left) / rect.width;
          const y = (event.clientY - rect.top) / rect.height;

          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
          }

          return {
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y))
          };
        }

        function updateTouchCursor(clientX, clientY) {
          const container = document.querySelector('.stream-container');
          const rect = container.getBoundingClientRect();

          if (clientX >= rect.left && clientX <= rect.right &&
              clientY >= rect.top && clientY <= rect.bottom) {
            touchCursor.style.display = 'block';
            touchCursor.style.left = (clientX - rect.left) + 'px';
            touchCursor.style.top = (clientY - rect.top) + 'px';
          } else {
            touchCursor.style.display = 'none';
          }
        }

        stream.addEventListener('pointermove', (event) => {
          updateTouchCursor(event.clientX, event.clientY);
        });

        stream.addEventListener('pointerleave', () => {
          touchCursor.style.display = 'none';
        });

        stream.addEventListener('pointerdown', (event) => {
          if (stream.style.display === 'none') {
            return;
          }

          touchCursor.classList.add('active');

          const point = getNormalizedTouchPoint(event);
          if (!point) {
            return;
          }

          pointerStart = {
            ...point,
            time: Date.now()
          };
          stream.setPointerCapture(event.pointerId);
        });

        stream.addEventListener('pointerup', (event) => {
          touchCursor.classList.remove('active');

          if (!pointerStart) {
            return;
          }

          const point = getNormalizedTouchPoint(event);
          if (!point) {
            pointerStart = null;
            return;
          }

          const dx = point.x - pointerStart.x;
          const dy = point.y - pointerStart.y;
          const distance = Math.sqrt((dx * dx) + (dy * dy));
          const durationMs = Date.now() - pointerStart.time;

          if (distance < 0.015) {
            vscode.postMessage({
              command: 'sendTap',
              normalizedX: point.x,
              normalizedY: point.y
            });
          } else {
            vscode.postMessage({
              command: 'sendSwipe',
              startX: pointerStart.x,
              startY: pointerStart.y,
              endX: point.x,
              endY: point.y,
              durationMs
            });
          }

          pointerStart = null;
        });

        stream.addEventListener('pointercancel', () => {
          touchCursor.classList.remove('active');
          pointerStart = null;
        });
    </script>
</body>
</html>`;
  }

  dispose(disposePanel: boolean = true): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;

    this.stopBackends();

    const currentPanel = this.panel;
    this.panel = undefined;

    if (disposePanel && currentPanel) {
      currentPanel.dispose();
    }

    if (this.onDispose) {
      this.onDispose();
    }
  }
}
