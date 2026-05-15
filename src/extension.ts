import * as vscode from "vscode";
import { AdbDeviceProvider, AdbDeviceItem } from "./deviceProvider";
import { MirrorViewProvider } from "./mirrorViewProvider";

let deviceProvider: AdbDeviceProvider;
let mirrorViewProvider: MirrorViewProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log("ADB Mirror extension is now active!");

  // Create the device provider
  deviceProvider = new AdbDeviceProvider();

  // Create the mirror view provider
  mirrorViewProvider = new MirrorViewProvider(context.extensionUri);

  // Register the tree data provider
  const treeView = vscode.window.createTreeView("adbMirrorDevices", {
    treeDataProvider: deviceProvider,
    showCollapseAll: false,
  });

  // Register the webview view provider for the sidebar mirror
  vscode.window.registerWebviewViewProvider(
    "adbMirrorView",
    mirrorViewProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.refreshDevices", () => {
      deviceProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "adbMirror.startMirror",
      (item: AdbDeviceItem) => {
        if (!item || !item.device || item.device.status !== "device") {
          vscode.window.showWarningMessage("Please select a connected device");
          return;
        }

        startMirror(item.device.serial);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.stopMirror", () => {
      mirrorViewProvider.stopSession();
      vscode.window.showInformationMessage("Mirror stopped");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendHome", () => {
      void mirrorViewProvider.sendKeyEvent(3);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendBack", () => {
      void mirrorViewProvider.sendKeyEvent(4);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendVolumeUp", () => {
      void mirrorViewProvider.sendKeyEvent(24);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendVolumeDown", () => {
      void mirrorViewProvider.sendKeyEvent(25);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendPower", () => {
      void mirrorViewProvider.sendKeyEvent(26);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.realtimeMode", () => {
      void mirrorViewProvider.applyPreset("realtime");
    }),
  );

  // Store the tree view for cleanup
  context.subscriptions.push(treeView);

  // Initial refresh
  deviceProvider.refresh();
}

async function startMirror(serial: string): Promise<void> {
  try {
    await mirrorViewProvider.startMirror(serial);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to start mirror: ${error}`);
  }
}

export function deactivate() {
  if (deviceProvider) {
    deviceProvider.dispose();
  }

  if (mirrorViewProvider) {
    mirrorViewProvider.dispose();
  }
}
