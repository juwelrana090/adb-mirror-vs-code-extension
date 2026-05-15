import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface AdbDevice {
  serial: string;
  status: string;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
}

export class AdbDeviceProvider implements vscode.TreeDataProvider<AdbDeviceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AdbDeviceItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private devices: AdbDevice[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.startAutoRefresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private startAutoRefresh(): void {
    // Refresh every 5 seconds
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, 5000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async getDevices(): Promise<AdbDevice[]> {
    try {
      // Windows: use shell: true
      const { stdout } = await execAsync('adb devices -l', {
        shell: true as any,
        timeout: 5000
      } as any);

      const devices: AdbDevice[] = [];
      const lines = String(stdout).split('\n');

      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {
          continue;
        }

        const parts = line.split(/\s+/);
        if (parts.length < 2) {
          continue;
        }

        const device: AdbDevice = {
          serial: parts[0],
          status: parts[1]
        };

        // Parse additional info (product, model, device, transport_id)
        for (let j = 2; j < parts.length; j++) {
          const part = parts[j];
          if (part.startsWith('product:')) {
            device.product = part.substring(8);
          } else if (part.startsWith('model:')) {
            device.model = part.substring(6);
          } else if (part.startsWith('device:')) {
            device.device = part.substring(7);
          } else if (part.startsWith('transport_id:')) {
            device.transportId = part.substring(13);
          }
        }

        devices.push(device);
      }

      this.devices = devices;
      return devices;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to get ADB devices: ${error}`);
      this.devices = [];
      return [];
    }
  }

  getTreeItem(element: AdbDeviceItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AdbDeviceItem): Promise<AdbDeviceItem[]> {
    if (element) {
      return [];
    }

    const devices = await this.getDevices();

    if (devices.length === 0) {
      return [new AdbDeviceItem(
        { serial: 'No devices found', status: 'offline' },
        vscode.TreeItemCollapsibleState.None
      )];
    }

    return devices.map(device =>
      new AdbDeviceItem(device, vscode.TreeItemCollapsibleState.None)
    );
  }

  dispose(): void {
    this.stopAutoRefresh();
  }
}

export class AdbDeviceItem extends vscode.TreeItem {
  constructor(
    public readonly device: AdbDevice,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(device.serial, collapsibleState);

    this.tooltip = this.buildTooltip();
    this.description = device.model || device.product || 'Unknown Device';
    this.contextValue = device.status === 'device' ? 'device' : 'offline';

    if (device.status === 'device') {
      this.iconPath = new vscode.ThemeIcon('device-mobile');
    } else {
      this.iconPath = new vscode.ThemeIcon('error');
    }
  }

  private buildTooltip(): string {
    const parts: string[] = [
      `Serial: ${this.device.serial}`,
      `Status: ${this.device.status}`
    ];

    if (this.device.model) {
      parts.push(`Model: ${this.device.model}`);
    }
    if (this.device.product) {
      parts.push(`Product: ${this.device.product}`);
    }
    if (this.device.device) {
      parts.push(`Device: ${this.device.device}`);
    }

    return parts.join('\n');
  }
}
