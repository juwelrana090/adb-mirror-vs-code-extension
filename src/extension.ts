import * as vscode from 'vscode';
import { AdbDeviceProvider, AdbDeviceItem } from './deviceProvider';
import { MirrorPanel } from './mirrorPanel';

let deviceProvider: AdbDeviceProvider;
let currentMirror: MirrorPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('ADB Mirror extension is now active!');

  // Create the device provider
  deviceProvider = new AdbDeviceProvider();

  // Register the tree data provider
  const treeView = vscode.window.createTreeView('adbMirrorDevices', {
    treeDataProvider: deviceProvider,
    showCollapseAll: false
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.refreshDevices', () => {
      deviceProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.startMirror', (item: AdbDeviceItem) => {
      if (!item || !item.device || item.device.status !== 'device') {
        vscode.window.showWarningMessage('Please select a connected device');
        return;
      }

      startMirror(item.device.serial);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.stopMirror', () => {
      stopMirror();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.sendHome', () => {
      sendKeyEvent(3);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.sendBack', () => {
      sendKeyEvent(4);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.sendVolumeUp', () => {
      sendKeyEvent(24);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.sendVolumeDown', () => {
      sendKeyEvent(25);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('adbMirror.sendPower', () => {
      sendKeyEvent(26);
    })
  );

  // Handle messages from webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('adbMirrorWebView', {
      resolveWebviewView: (webviewView) => {
        webviewView.webview.onDidReceiveMessage(
          async (message) => {
            switch (message.command) {
              case 'sendKeyEvent':
                await sendKeyEvent(message.keyCode);
                break;
              case 'stopMirror':
                stopMirror();
                break;
            }
          }
        );
      }
    })
  );

  // Store the tree view for cleanup
  context.subscriptions.push(treeView);

  // Initial refresh
  deviceProvider.refresh();
}

async function startMirror(serial: string): Promise<void> {
  if (currentMirror) {
    vscode.window.showWarningMessage('Another mirror session is already active');
    return;
  }

  try {
    currentMirror = new MirrorPanel(serial);
    await currentMirror.show();

    vscode.window.showInformationMessage(`Mirror started for device: ${serial}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to start mirror: ${error}`);
    currentMirror = undefined;
  }
}

function stopMirror(): void {
  if (currentMirror) {
    currentMirror.dispose();
    currentMirror = undefined;
    vscode.window.showInformationMessage('Mirror stopped');
  } else {
    vscode.window.showInformationMessage('No active mirror session');
  }
}

async function sendKeyEvent(keyCode: number): Promise<void> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  try {
    // Windows: use shell: true
    await execAsync(`adb shell input keyevent ${keyCode}`, {
      shell: true as any,
      timeout: 5000
    } as any);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to send key event: ${error}`);
  }
}

export function deactivate() {
  if (currentMirror) {
    currentMirror.dispose();
  }

  if (deviceProvider) {
    deviceProvider.dispose();
  }
}
