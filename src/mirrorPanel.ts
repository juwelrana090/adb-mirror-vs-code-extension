import * as vscode from 'vscode';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class MirrorPanel {
  private panel: vscode.WebviewPanel | undefined;
  private scrcpyProcess: ReturnType<typeof spawn> | undefined;
  private readonly serial: string;
  private readonly port: number = 27183;

  constructor(serial: string) {
    this.serial = serial;
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'adbMirror',
      `Mirror: ${this.serial}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.getWebviewContent();
    this.panel.onDidDispose(() => this.dispose());

    await this.startScrcpy();
  }

  private async startScrcpy(): Promise<void> {
    // Stop any existing process
    this.stopScrcpy();

    try {
      // Check if scrcpy supports mjpeg-server flag
      const hasMjpegFlag = await this.checkMjpegSupport();

      const args = ['-s', this.serial, '--no-audio', '--no-playback'];

      if (hasMjpegFlag) {
        args.push(`--mjpeg-server=${this.port}`);
      } else {
        // Fallback for newer scrcpy versions
        args.push('--v4l2-sink=/dev/video0', '--video-source=capture');
        vscode.window.showWarningMessage(
          'Your scrcpy version may not support MJPEG streaming. Display may not work correctly.'
        );
      }

      args.push('--max-size=800');

      // Windows: use shell: true
      this.scrcpyProcess = spawn('scrcpy', args, {
        shell: true as any,
        detached: false
      } as any);

      this.scrcpyProcess.stdout?.on('data', (data) => {
        console.log(`scrcpy stdout: ${data}`);
      });

      this.scrcpyProcess.stderr?.on('data', (data) => {
        console.error(`scrcpy stderr: ${data}`);
      });

      this.scrcpyProcess.on('error', (error) => {
        vscode.window.showErrorMessage(`Failed to start scrcpy: ${error.message}`);
      });

      this.scrcpyProcess.on('close', (code) => {
        console.log(`scrcpy process exited with code ${code}`);
      });

    } catch (error) {
      vscode.window.showErrorMessage(`Failed to start scrcpy: ${error}`);
    }
  }

  private async checkMjpegSupport(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('scrcpy --help', {
        shell: true as any,
        timeout: 5000
      } as any);

      return String(stdout).includes('--mjpeg-server') || String(stdout).includes('mjpeg');
    } catch (error) {
      vscode.window.showWarningMessage('Could not verify scrcpy MJPEG support');
      return false;
    }
  }

  stopScrcpy(): void {
    if (this.scrcpyProcess) {
      this.scrcpyProcess.kill();
      this.scrcpyProcess = undefined;
    }
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
            border-radius: 8px;
            overflow: hidden;
        }

        #stream {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }

        .controls {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 20px;
            justify-content: center;
            width: 100%;
            max-width: 800px;
        }

        .control-group {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: center;
        }

        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 16px;
            border-radius: 4px;
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

        .status {
            margin-top: 10px;
            padding: 8px 12px;
            border-radius: 4px;
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
            margin: 0 0 20px 0;
            color: var(--vscode-editor-foreground);
        }

        .loading {
            color: var(--vscode-editor-foreground);
            font-size: 14px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>ADB Mirror - ${this.serial}</h1>

        <div class="stream-container">
            <div class="loading">Starting scrcpy server...</div>
            <img id="stream" style="display: none;" alt="Device screen" />
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
        const port = ${this.port};

        // Try to load the stream
        stream.onload = () => {
            status.textContent = 'Connected to device - Streaming active';
            status.className = 'status';
        };

        stream.onerror = () => {
            status.textContent = 'Connection failed - Check if scrcpy is running';
            status.className = 'status error';
        };

        // Start attempting to load the stream
        function startStream() {
            const timestamp = new Date().getTime();
            stream.src = \`http://localhost:\${port}/?\${timestamp}\`;
            stream.style.display = 'block';
            document.querySelector('.loading').style.display = 'none';
        }

        // Start stream after a short delay to give scrcpy time to initialize
        setTimeout(startStream, 2000);

        function sendKeyEvent(code) {
            vscode.postMessage({
                command: 'sendKeyEvent',
                keyCode: code
            });
        }

        function refreshStream() {
            status.textContent = 'Refreshing stream...';
            const timestamp = new Date().getTime();
            stream.src = \`http://localhost:\${port}/?\${timestamp}\`;
        }

        function stopMirror() {
            vscode.postMessage({
                command: 'stopMirror'
            });
        }
    </script>
</body>
</html>`;
  }

  dispose(): void {
    this.stopScrcpy();
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
  }
}
