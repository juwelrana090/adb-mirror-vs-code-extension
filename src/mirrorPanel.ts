import * as vscode from "vscode";
import { spawn, exec, execFile } from "child_process";
import { promisify } from "util";
import * as http from "http";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type StreamMode =
  | "unknown"
  | "scrcpy-mjpeg"
  | "adb-screencap"
  | "scrcpy-native";
type PerformancePreset =
  | "realtime"
  | "light"
  | "ultraLowLatency"
  | "maxSpeed"
  | "balanced"
  | "quality";

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
  adbFrameIntervalMs?: number;
  adbCaptureTimeoutMs?: number;
}

const PERFORMANCE_PRESETS: Record<PerformancePreset, PerformanceConfig> = {
  realtime: {
    maxSize: 360,
    maxFps: 120,
    bitRate: "640K",
    adbFrameIntervalMs: 12,
    adbCaptureTimeoutMs: 1200,
    label: "Realtime",
  },
  light: {
    maxSize: 480,
    maxFps: 30,
    bitRate: "1M",
    adbFrameIntervalMs: 30,
    adbCaptureTimeoutMs: 2200,
    label: "Light",
  },
  ultraLowLatency: {
    maxSize: 480,
    maxFps: 90,
    bitRate: "1500K",
    adbFrameIntervalMs: 14,
    adbCaptureTimeoutMs: 1400,
    label: "Ultra Fast",
  },
  maxSpeed: {
    maxSize: 360,
    maxFps: 120,
    bitRate: "512K",
    adbFrameIntervalMs: 10,
    adbCaptureTimeoutMs: 1000,
    label: "Maximum Speed",
  },
  balanced: {
    maxSize: 720,
    maxFps: 60,
    bitRate: "4M",
    adbFrameIntervalMs: 20,
    adbCaptureTimeoutMs: 1800,
    label: "Balanced",
  },
  quality: {
    maxSize: 1080,
    maxFps: 30,
    bitRate: "8M",
    adbFrameIntervalMs: 30,
    adbCaptureTimeoutMs: 2500,
    label: "High Quality",
  },
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
  private defaultAdbFrameIntervalMs = 30;
  private defaultAdbCaptureTimeoutMs = 1800;
  private adbFrameIntervalMs = 30;
  private adbCaptureTimeoutMs = 1800;
  private scrcpyMaxSize = 720;
  private scrcpyMaxFps = 60;
  private scrcpyVideoBitRate = "4M";
  private currentPreset: PerformancePreset = "realtime";
  private preferNativeLowLatency = true;

  constructor(serial: string, onDispose?: () => void) {
    this.serial = serial;
    this.onDispose = onDispose;
    this.loadPerformanceConfig();
  }

  private loadPerformanceConfig(): void {
    const config = vscode.workspace.getConfiguration("adbMirror");

    const configuredFrameInterval = Number(
      config.get<number>("adbFrameIntervalMs", 30),
    );
    this.adbFrameIntervalMs = Math.max(
      10,
      Math.min(500, configuredFrameInterval),
    );
    this.defaultAdbFrameIntervalMs = this.adbFrameIntervalMs;

    const configuredCaptureTimeout = Number(
      config.get<number>("adbCaptureTimeoutMs", 1800),
    );
    this.adbCaptureTimeoutMs = Math.max(
      800,
      Math.min(6000, configuredCaptureTimeout),
    );
    this.defaultAdbCaptureTimeoutMs = this.adbCaptureTimeoutMs;

    this.preferNativeLowLatency = config.get<boolean>(
      "preferNativeLowLatency",
      true,
    );

    const configuredMaxSize = Number(config.get<number>("scrcpyMaxSize", 720));
    this.scrcpyMaxSize = Math.max(360, Math.min(1600, configuredMaxSize));

    const configuredMaxFps = Number(config.get<number>("scrcpyMaxFps", 60));
    this.scrcpyMaxFps = Math.max(15, Math.min(240, configuredMaxFps));

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
        case "sendText":
          await this.sendText(String(message.text));
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
        case "openNativeScrcpy":
          await this.launchNativeScrcpy(true);
          break;
      }
    });
    this.panel.onDidDispose(() => this.dispose(false));

    await this.startStreaming();
  }

  async sendKeyEvent(keyCode: number): Promise<void> {
    try {
      await execFileAsync(
        "adb",
        ["-s", this.serial, "shell", "input", "keyevent", String(keyCode)],
        {
          timeout: 5000,
          windowsHide: true,
        },
      );
    } catch (error) {
      const message = `Failed to send key event: ${String(error)}`;
      vscode.window.showErrorMessage(message);
      this.notifyWebview("error", message);
    }
  }

  async sendText(text: string): Promise<void> {
    try {
      if (!text) {
        return;
      }

      await this.sendTextViaInput(text);
    } catch (error) {
      const message = `Failed to send text: ${String(error)}`;
      vscode.window.showErrorMessage(message);
      this.notifyWebview("error", message);
    }
  }

  private async sendTextViaInput(text: string): Promise<void> {
    // Keep input text stable across shells and adb by sending in chunks,
    // translating spaces to %s, and preserving a literal % as \%.
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 0) {
        for (const chunk of this.chunkTextForAdb(line, 180)) {
          const escapedChunk = this.escapeTextForAdbInput(chunk);
          await execFileAsync(
            "adb",
            ["-s", this.serial, "shell", "input", "text", escapedChunk],
            {
              timeout: 5000,
              windowsHide: true,
            },
          );
        }
      }

      // Recreate line breaks with ENTER to match direct typing behavior.
      if (i < lines.length - 1) {
        await this.sendKeyEvent(66);
      }
    }
  }

  private chunkTextForAdb(text: string, maxChunkLength: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxChunkLength) {
      chunks.push(text.slice(i, i + maxChunkLength));
    }
    return chunks;
  }

  private escapeTextForAdbInput(text: string): string {
    // Escape order matters: preserve literal % first, then map spaces to %s.
    return text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/%/g, "\\%")
      .replace(/ /g, "%s");
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

      await execFileAsync(
        "adb",
        [
          "-s",
          this.serial,
          "shell",
          "input",
          "tap",
          String(coords.x),
          String(coords.y),
        ],
        {
          timeout: 5000,
          windowsHide: true,
        },
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
      await execFileAsync(
        "adb",
        [
          "-s",
          this.serial,
          "shell",
          "input",
          "swipe",
          String(startCoords.x),
          String(startCoords.y),
          String(endCoords.x),
          String(endCoords.y),
          String(clampedDuration),
        ],
        {
          timeout: 7000,
          windowsHide: true,
        },
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
      const { stdout } = await execFileAsync(
        "adb",
        ["-s", this.serial, "shell", "wm", "size"],
        {
          timeout: 5000,
          windowsHide: true,
        },
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

    const wantsLowestDelay =
      this.currentPreset === "realtime" ||
      this.currentPreset === "maxSpeed" ||
      this.currentPreset === "ultraLowLatency";

    if (support.installed && this.preferNativeLowLatency && wantsLowestDelay) {
      const launchedNative = await this.launchNativeScrcpy(false);
      if (launchedNative) {
        this.streamMode = "scrcpy-native";
        this.notifyWebview("backend", {
          mode: this.streamMode,
          port: this.port,
        });
        this.notifyWebview(
          "status",
          "Low-delay mode: opened native scrcpy for fastest control response.",
        );
        return;
      }
    }

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

    if (support.installed && !support.mjpegSupported) {
      const launchedNative = await this.launchNativeScrcpy(false);
      if (launchedNative) {
        this.streamMode = "scrcpy-native";
        this.notifyWebview("backend", {
          mode: this.streamMode,
          port: this.port,
        });
        return;
      }
    }

    let reason: string;
    if (!support.installed) {
      reason = "scrcpy not found. Using ADB screenshot fallback.";
    } else if (!support.mjpegSupported) {
      reason = `scrcpy ${support.version} has no --mjpeg-server. Open Native Scrcpy for real-time control, or using ADB screenshot fallback.`;
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
      "--no-display",
      "--no-cleanup",
      "--no-clipboard",
      "--no-idle",
      `--mjpeg-server=${this.port}`,
      `--max-size=${this.scrcpyMaxSize}`,
      `--max-fps=${this.scrcpyMaxFps}`,
      `--video-bit-rate=${this.scrcpyVideoBitRate}`,
    ];

    this.scrcpyProcess = spawn(this.scrcpyCommand, args, {
      detached: false,
      shell: false,
      windowsHide: true,
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

    await new Promise((resolve) => setTimeout(resolve, 600));

    if (!this.scrcpyProcess.pid || this.scrcpyProcess.exitCode !== null) {
      throw new Error(startupStderr || "scrcpy exited immediately");
    }

    const mjpegReady = await this.waitForMjpegServer(2, 300);
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
    this.notifyWebview("status", `${reason} Persistent ADB stream active.`);
    this.startPersistentAdbStream();
  }

  async applyPreset(preset: PerformancePreset): Promise<void> {
    const config = PERFORMANCE_PRESETS[preset];
    if (!config) {
      return;
    }

    this.currentPreset = preset;
    this.scrcpyMaxSize = config.maxSize;
    this.scrcpyMaxFps = config.maxFps;
    this.scrcpyVideoBitRate = config.bitRate;
    this.adbFrameIntervalMs = Math.max(
      10,
      config.adbFrameIntervalMs ?? this.defaultAdbFrameIntervalMs,
    );
    this.adbCaptureTimeoutMs = Math.max(
      800,
      config.adbCaptureTimeoutMs ?? this.defaultAdbCaptureTimeoutMs,
    );

    this.notifyWebview("status", `Applied preset: ${config.label}`);
    this.notifyWebview("presetApplied", { preset, config });

    // Restart streaming with new settings
    if (this.streamMode === "scrcpy-mjpeg") {
      await this.startStreaming();
    }
  }

  private startPersistentAdbStream(): void {
    if (this.scrcpyProcess) {
      this.scrcpyProcess.kill();
      this.scrcpyProcess = undefined;
    }

    const child = spawn(
      "adb",
      ["-s", this.serial, "exec-out", "while true; do screencap -p; done"],
      { shell: false, windowsHide: true },
    );
    this.scrcpyProcess = child;

    // IEND is the last 8 bytes of every valid PNG (chunk type + CRC of the final IEND chunk)
    const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    let held: Buffer = Buffer.alloc(0);

    child.stdout?.on("data", (chunk: Buffer) => {
      held =
        held.length === 0 ? Buffer.from(chunk) : Buffer.concat([held, chunk]);
      let searchFrom = Math.max(
        0,
        held.length - chunk.length - IEND.length + 1,
      );
      let pos: number;
      while ((pos = held.indexOf(IEND, searchFrom)) !== -1) {
        const frameEnd = pos + IEND.length;
        const frame = held.slice(0, frameEnd);
        this.notifyWebview("frame", {
          dataUrl: `data:image/png;base64,${frame.toString("base64")}`,
        });
        this.frameFailureCount = 0;
        held = held.slice(frameEnd);
        searchFrom = 0;
      }
    });

    child.on("error", () => {
      if (!this.isDisposed && this.streamMode === "adb-screencap") {
        this.startAdbFrameLoop();
      }
    });

    child.on("close", () => {
      if (!this.isDisposed && this.streamMode === "adb-screencap") {
        setTimeout(() => {
          if (!this.isDisposed && this.streamMode === "adb-screencap") {
            this.startPersistentAdbStream();
          }
        }, 500);
      }
    });
  }

  private startAdbFrameLoop(): void {
    const runLoop = async () => {
      if (this.streamMode !== "adb-screencap" || this.isDisposed) {
        return;
      }

      const startedAt = Date.now();
      await this.pushSingleFrame();
      const elapsedMs = Date.now() - startedAt;
      const nextDelayMs = Math.max(1, this.adbFrameIntervalMs - elapsedMs);

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
      const { stdout, stderr } = await execFileAsync(
        this.scrcpyCommand,
        ["--help"],
        {
          timeout: 5000,
          windowsHide: true,
        },
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
      const versionOutput = await execFileAsync(
        this.scrcpyCommand,
        ["--version"],
        {
          timeout: 5000,
          windowsHide: true,
        },
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
      await execFileAsync(command, ["--version"], {
        timeout: 4000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async launchNativeScrcpy(showStatus: boolean): Promise<boolean> {
    try {
      const args = [
        "-s",
        this.serial,
        "--no-audio",
        "--stay-awake",
        "--no-clipboard",
        "--max-size",
        String(this.scrcpyMaxSize),
        "--max-fps",
        String(this.scrcpyMaxFps),
        "--video-bit-rate",
        this.scrcpyVideoBitRate,
        "--window-title",
        `scrcpy realtime: ${this.serial}`,
      ];

      const nativeProcess = spawn(this.scrcpyCommand, args, {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });

      nativeProcess.unref();

      if (showStatus) {
        this.notifyWebview(
          "status",
          "Opened native scrcpy window for real-time view and control.",
        );
      }

      return true;
    } catch (error) {
      const message = `Could not open native scrcpy: ${String(error)}`;
      if (showStatus) {
        this.notifyWebview("error", message);
      }
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
          shell: false,
          windowsHide: true,
        },
      );
      const chunks: Buffer[] = [];
      let stderr = "";

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("adb frame capture timed out"));
      }, this.adbCaptureTimeoutMs);

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
        :root {
            --bg-primary: var(--vscode-editor-background, #1e1e1e);
            --bg-secondary: var(--vscode-sideBar-background, #252526);
            --bg-hover: var(--vscode-toolbar-hoverBackground, #2a2d2e);
            --border: var(--vscode-panel-border, #3c3c3c);
            --text-primary: var(--vscode-editor-foreground, #cccccc);
            --text-secondary: var(--vscode-descriptionForeground, #858585);
            --accent: var(--vscode-button-background, #0e639c);
            --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
            --success: #4ec9b0;
            --error: #f14c4c;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 0;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            display: flex;
            flex-direction: column;
          height: 100vh;
            overflow: hidden;
        }

        .app-container {
          display: flex;
            flex: 1;
          flex-direction: column;
            position: relative;
        }

        .stream-wrapper {
          flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
          background: #000;
        }

        .stream-container {
            position: relative;
            width: 100%;
          height: 100%;
          background: #000;
            overflow: hidden;
        }

        #stream {
            width: 100%;
            height: 100%;
            object-fit: contain;
            touch-action: none;
            user-select: none;
            -webkit-user-drag: none;
            cursor: none;
        }

        #streamCanvas {
            width: 100%;
            height: auto;
            display: block;
            touch-action: none;
            user-select: none;
            cursor: none;
        }

        .device-badge {
            position: absolute;
            top: 8px;
            left: 8px;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(8px);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 10px;
            font-weight: 500;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 4px;
            z-index: 10;
            opacity: 0.8;
        }

        .device-badge:hover {
            opacity: 1;
        }

        .device-badge svg {
            width: 12px;
            height: 12px;
        }

        .status-indicator {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--success);
        }

        .status-indicator.connecting {
            background: #cca700;
            animation: pulse 1s infinite;
        }

        .status-indicator.error {
            background: var(--error);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        #touchCursor {
            position: absolute;
            width: 24px;
            height: 24px;
            border: 2px solid rgba(255, 255, 255, 0.9);
            border-radius: 50%;
            pointer-events: none;
            transform: translate(-50%, -50%);
            display: none;
            z-index: 20;
            box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
        }

        #touchCursor::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 6px;
            height: 6px;
            background: rgba(255, 255, 255, 1);
            border-radius: 50%;
            transform: translate(-50%, -50%);
        }

        #touchCursor.active {
            background: rgba(100, 180, 255, 0.4);
            border-color: rgba(100, 180, 255, 1);
            box-shadow: 0 0 20px rgba(100, 180, 255, 0.6);
        }

        .loading {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 12px;
            background: #000;
        }

        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .loading-text {
            font-size: 13px;
            color: var(--text-secondary);
        }

        .toolbar {
            display: flex;
            align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 12px 16px;
            background: var(--bg-secondary);
            border-top: 1px solid var(--border);
          flex-wrap: wrap;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 8px;
        }

        .toolbar-group:not(:last-child)::after {
            content: '';
            width: 1px;
            height: 24px;
            background: var(--border);
            margin-left: 8px;
        }

        .icon-btn {
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            color: var(--text-primary);
            transition: all 0.15s ease;
            position: relative;
        }

        .icon-btn:hover {
            background: var(--bg-hover);
        }

        .icon-btn:active {
            transform: scale(0.95);
        }

        .icon-btn.active {
            background: var(--accent);
            color: #fff;
        }

        .icon-btn.active:hover {
            background: var(--accent-hover);
        }

        .icon-btn.danger:hover {
            background: rgba(241, 76, 76, 0.2);
            color: var(--error);
        }

        .icon-btn svg {
            width: 20px;
            height: 20px;
        }

        .icon-btn.small {
            width: 36px;
            height: 36px;
        }

        .icon-btn.small svg {
            width: 18px;
            height: 18px;
        }

        .quality-selector {
            display: flex;
            align-items: center;
          gap: 2px;
            background: var(--bg-primary);
          padding: 3px;
          border-radius: 10px;
        }

        .quality-btn {
            padding: 6px 10px;
            font-size: 11px;
            font-weight: 500;
            background: transparent;
            border: none;
            border-radius: 7px;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .quality-btn:hover {
            color: var(--text-primary);
        }

        .quality-btn.active {
            background: var(--accent);
            color: #fff;
        }

        .status-bar {
            display: flex;
            align-items: center;
          justify-content: center;
          padding: 8px 16px;
            font-size: 12px;
            color: var(--text-secondary);
            background: var(--bg-secondary);
            border-top: 1px solid var(--border);
            gap: 8px;
        }

        .status-bar.error {
            background: rgba(241, 76, 76, 0.1);
            color: var(--error);
        }

        body.webview-only .toolbar,
        body.webview-only .status-bar {
            display: none !important;
        }

        .fps-counter {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px;
            color: var(--success);
        }

        .tooltip {
            position: absolute;
            bottom: calc(100% + 8px);
            left: 50%;
            transform: translateX(-50%);
            padding: 6px 10px;
            background: var(--vscode-editorInfo-background, #0d3d36);
            color: var(--vscode-editorInfo-foreground, #4ec9b0);
            font-size: 11px;
            white-space: nowrap;
            border-radius: 4px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s ease;
            z-index: 100;
        }

        .icon-btn:hover .tooltip {
            opacity: 1;
        }

        .quality-btn:hover .tooltip {
            opacity: 1;
        }

        @media (max-width: 768px) {
            .toolbar {
                padding: 8px;
            }
            .icon-btn {
                width: 36px;
                height: 36px;
            }
            .icon-btn svg {
                width: 18px;
                height: 18px;
            }
        }
    </style>
</head>
<body>
    <div class="app-container">
        <div class="stream-wrapper">
          <div class="stream-container" id="streamContainer">
                <div class="device-badge" onclick="toggleWebviewOnly()" title="Toggle toolbar" style="cursor:pointer;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                        <line x1="12" y1="18" x2="12.01" y2="18"/>
                    </svg>
                    <span>${this.serial}</span>
                    <span class="status-indicator connecting" id="statusIndicator"></span>
                </div>
                <div class="loading">
                    <div class="spinner"></div>
                    <span class="loading-text">Connecting to device...</span>
                </div>
                <img id="stream" style="display: none;" alt="Device screen" />
                <canvas id="streamCanvas" style="display: none;"></canvas>
                <div id="touchCursor"></div>
            </div>
        </div>

        <div class="toolbar">
            <div class="toolbar-group">
                <div class="quality-selector">
                    <button class="quality-btn active" onclick="applyPreset('realtime')" data-preset="realtime">
                        ⚡ RT
                        <span class="tooltip">Realtime (360p, 120fps, low latency)</span>
                    </button>
                    <button class="quality-btn" onclick="applyPreset('light')" data-preset="light">
                        Light
                        <span class="tooltip">Light mode (480p, 30fps)</span>
                    </button>
                    <button class="quality-btn" onclick="applyPreset('ultraLowLatency')" data-preset="ultraLowLatency">
                        Ultra
                        <span class="tooltip">Ultra low latency (480p, 60fps)</span>
                    </button>
                    <button class="quality-btn" onclick="applyPreset('maxSpeed')" data-preset="maxSpeed">
                        Speed
                        <span class="tooltip">Maximum speed (360p, 120fps)</span>
                    </button>
                    <button class="quality-btn" onclick="applyPreset('balanced')" data-preset="balanced">
                        Balanced
                        <span class="tooltip">Balanced (720p, 60fps)</span>
                    </button>
                    <button class="quality-btn" onclick="applyPreset('quality')" data-preset="quality">
                        Quality
                        <span class="tooltip">High quality (1080p, 30fps)</span>
                    </button>
                </div>
            </div>

            <div class="toolbar-group">
              <button class="icon-btn" onclick="openNativeScrcpy()" title="Open Native Scrcpy">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="4" y="3" width="16" height="12" rx="2" ry="2"/>
                  <path d="M8 21h8M12 15v6"/>
                </svg>
                <span class="tooltip">Open Native Scrcpy (Lowest Latency)</span>
              </button>
            </div>

            <div class="toolbar-group">
                <button class="icon-btn" onclick="sendKeyEvent(3)" title="Home">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M12 3v2 M12 19v2 M3 12h2 M19 12h2"/>
                    </svg>
                    <span class="tooltip">Home</span>
                </button>
                <button class="icon-btn" onclick="sendKeyEvent(4)" title="Back">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="15 18 9 12 15 6"/>
                    </svg>
                    <span class="tooltip">Back</span>
                </button>
                <button class="icon-btn" onclick="sendKeyEvent(26)" title="Power">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="6" y="10" width="12" height="10" rx="2"/>
                        <path d="M12 6V2"/>
                    </svg>
                    <span class="tooltip">Power</span>
                </button>
            </div>

            <div class="toolbar-group">
                <button class="icon-btn small" onclick="sendKeyEvent(24)" title="Volume Up">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    </svg>
                    <span class="tooltip">Volume Up</span>
                </button>
                <button class="icon-btn small" onclick="sendKeyEvent(25)" title="Volume Down">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    </svg>
                    <span class="tooltip">Volume Down</span>
                </button>
            </div>

            <div class="toolbar-group">
                <button class="icon-btn" onclick="refreshStream()" title="Refresh">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    <span class="tooltip">Refresh Stream</span>
                </button>
                <button class="icon-btn danger" onclick="stopMirror()" title="Stop">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    </svg>
                    <span class="tooltip">Stop Mirroring</span>
                </button>
            </div>
        </div>

        <div class="status-bar" id="statusBar">
            <span id="statusText">Initializing...</span>
            <span class="fps-counter" id="fpsCounter" style="display: none;"></span>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const stream = document.getElementById('stream');
        const streamCanvas = document.getElementById('streamCanvas');
        const ctx = streamCanvas.getContext('2d', { alpha: false, desynchronized: true });
        const statusText = document.getElementById('statusText');
        const statusBar = document.getElementById('statusBar');
        const statusIndicator = document.getElementById('statusIndicator');
        const loadingDiv = document.querySelector('.loading');
        const touchCursor = document.getElementById('touchCursor');
        const fpsCounter = document.getElementById('fpsCounter');
        let backendMode = 'unknown';
        let streamPort = ${this.port};
        let retryCount = 0;
        const maxRetries = 10;
        let isConnected = false;
        let pointerStart = null;
        let currentPreset = 'realtime';
        let frameCount = 0;
        let lastFpsUpdate = Date.now();

        stream.onload = () => {
          if (backendMode === 'scrcpy-mjpeg') {
            statusText.textContent = 'Streaming active';
            statusIndicator.className = 'status-indicator';
          }
            statusBar.className = 'status-bar';
            isConnected = true;
            retryCount = 0;
        };

        stream.onerror = () => {
          if (backendMode !== 'scrcpy-mjpeg') {
            return;
          }

            if (!isConnected && retryCount < maxRetries) {
                retryCount++;
                statusText.textContent = \`Connection attempt \${retryCount}/\${maxRetries} - Retrying...\`;
                statusIndicator.className = 'status-indicator connecting';
                setTimeout(() => {
                    if (!isConnected) {
                    loadScrcpyStream();
                    }
                }, 2000);
            } else if (!isConnected) {
                statusText.textContent = 'Connection failed - Check scrcpy installation';
                statusBar.className = 'status-bar error';
                statusIndicator.className = 'status-indicator error';
            }
        };

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
            case 'backend':
              backendMode = message.mode || 'unknown';
              streamPort = message.port || streamPort;
              if (backendMode === 'scrcpy-mjpeg') {
                statusText.textContent = 'Starting stream...';
                statusIndicator.className = 'status-indicator connecting';
                loadScrcpyStream();
              } else if (backendMode === 'scrcpy-native') {
                statusText.textContent = 'Native scrcpy opened for real-time control';
                statusIndicator.className = 'status-indicator';
              } else if (backendMode === 'adb-screencap') {
                statusText.textContent = 'ADB screenshot mode';
                statusIndicator.className = 'status-indicator';
                startFpsCounter();
              }
              break;
            case 'frame':
              if (message.dataUrl) {
                stream.style.display = 'none';
                streamCanvas.style.display = 'block';
                loadingDiv.style.display = 'none';
                isConnected = true;
                frameCount++;
                const b64 = message.dataUrl.slice(message.dataUrl.indexOf(',') + 1);
                const bin = atob(b64);
                const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                createImageBitmap(new Blob([arr], {type: 'image/png'})).then(bitmap => {
                  if (streamCanvas.width !== bitmap.width || streamCanvas.height !== bitmap.height) {
                    streamCanvas.width = bitmap.width;
                    streamCanvas.height = bitmap.height;
                  }
                  ctx.drawImage(bitmap, 0, 0);
                  bitmap.close();
                });
              }
              break;
                case 'error':
                    statusText.textContent = \`Error: \${message.message}\`;
                    statusBar.className = 'status-bar error';
                    statusIndicator.className = 'status-indicator error';
                    break;
                case 'status':
                    statusText.textContent = message.message;
                    statusBar.className = 'status-bar';
                    break;
                case 'presetApplied':
                    currentPreset = message.preset;
                    updatePresetButtons();
                    break;
            }
        });

        function startFpsCounter() {
            fpsCounter.style.display = 'inline';
            setInterval(() => {
                const now = Date.now();
                const elapsed = (now - lastFpsUpdate) / 1000;
                const fps = Math.round(frameCount / elapsed);
                fpsCounter.textContent = \`|\${fps} FPS\`;
                frameCount = 0;
                lastFpsUpdate = now;
            }, 1000);
        }

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
                statusText.textContent = 'Refreshing...';
                statusIndicator.className = 'status-indicator connecting';
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

        function openNativeScrcpy() {
          vscode.postMessage({
            command: 'openNativeScrcpy'
          });
        }

        function applyPreset(preset) {
            vscode.postMessage({
                command: 'applyPreset',
                preset: preset
            });
        }

        function toggleWebviewOnly() {
            document.body.classList.toggle('webview-only');
        }

        function updatePresetButtons() {
            document.querySelectorAll('.quality-btn').forEach(btn => {
                if (btn.dataset.preset === currentPreset) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }

        function getNormalizedTouchPoint(event) {
          // Use whichever stream surface is currently visible
          const el = streamCanvas.style.display !== 'none' ? streamCanvas : stream;
          const rect = el.getBoundingClientRect();
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

        // Attach pointer listeners to both img (MJPEG) and canvas (ADB screencap)
        [stream, streamCanvas].forEach(el => {
          el.addEventListener('pointermove', (event) => {
            updateTouchCursor(event.clientX, event.clientY);
          });

          el.addEventListener('pointerleave', () => {
            touchCursor.style.display = 'none';
          });

          el.addEventListener('pointerdown', (event) => {
            touchCursor.classList.add('active');

            const point = getNormalizedTouchPoint(event);
            if (!point) {
              return;
            }

            pointerStart = {
              ...point,
              time: Date.now()
            };
            el.setPointerCapture(event.pointerId);
          });

          el.addEventListener('pointerup', (event) => {
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

          el.addEventListener('pointercancel', () => {
            touchCursor.classList.remove('active');
            pointerStart = null;
          });
        });

        // Direct keyboard input handling with batching to reduce adb command spam.
        document.body.tabIndex = 0;
        document.body.focus();

        // Special keys mapping
        const specialKeys = {
          'Enter': 66, 'Backspace': 67, 'Tab': 61, 'Escape': 111,
          'ArrowUp': 19, 'ArrowDown': 20, 'ArrowLeft': 21, 'ArrowRight': 22,
          'Home': 3, 'End': 123, 'Delete': 67, 'Insert': 124,
          'PageUp': 92, 'PageDown': 93,
          'F1': 131, 'F2': 132, 'F3': 133, 'F4': 134, 'F5': 135,
          'F6': 136, 'F7': 137, 'F8': 138, 'F9': 139, 'F10': 140,
          'F11': 141, 'F12': 142
        };

        let pendingTextBuffer = '';
        let pendingTextTimer = null;

        function flushPendingText() {
          if (!pendingTextBuffer) {
            return;
          }
          vscode.postMessage({
            command: 'sendText',
            text: pendingTextBuffer
          });
          pendingTextBuffer = '';
        }

        function queueTextInput(text) {
          if (!text) {
            return;
          }
          pendingTextBuffer += text;
          if (pendingTextTimer) {
            clearTimeout(pendingTextTimer);
          }
          pendingTextTimer = setTimeout(() => {
            flushPendingText();
            pendingTextTimer = null;
          }, 12);
        }

        window.addEventListener('blur', () => {
          flushPendingText();
        });

        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible') {
            flushPendingText();
          }
        });

        document.addEventListener('paste', (event) => {
          const pasted = event.clipboardData?.getData('text') || '';
          if (!pasted) {
            return;
          }
          queueTextInput(pasted);
          event.preventDefault();
          event.stopPropagation();
        }, { capture: true });

        // Capture ALL keyboard events at document level
        document.addEventListener('keydown', (event) => {
          // Skip if typing in a button or input
          if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT') {
            return;
          }

          // Check for special keys
          if (specialKeys[event.key]) {
            flushPendingText();
            vscode.postMessage({
              command: 'sendKeyEvent',
              keyCode: specialKeys[event.key]
            });
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          // Handle space
          if (event.key === ' ') {
            queueTextInput(' ');
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          // Handle single printable characters
          if (event.key.length === 1) {
            const charCode = event.key.charCodeAt(0);
            if (charCode >= 33 && charCode <= 126) {
              queueTextInput(event.key);
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
        }, { capture: true, passive: false });

        document.getElementById('streamContainer').addEventListener('pointerdown', () => {
          document.body.focus();
        });

        statusText.textContent = 'Keyboard input ready';
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
