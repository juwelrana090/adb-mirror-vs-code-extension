import * as vscode from "vscode";
import { AdbDeviceProvider, AdbDeviceItem } from "./deviceProvider";
import { MirrorViewProvider } from "./mirrorViewProvider";

let deviceProvider: AdbDeviceProvider;
let mirrorViewProvider: MirrorViewProvider;
let treeView: vscode.TreeView<AdbDeviceItem> | undefined;
let webviewViewRegistration: vscode.Disposable | undefined;
let isActivated = false;

export function activate(context: vscode.ExtensionContext) {
  if (isActivated) {
    console.warn(
      "ADB Mirror extension activate() called again; skipping duplicate registration.",
    );
    return;
  }

  console.log("ADB Mirror extension is now active!");
  isActivated = true;

  // Create the device provider
  deviceProvider = new AdbDeviceProvider();

  // Create the mirror view provider
  mirrorViewProvider = new MirrorViewProvider(context.extensionUri);

  // Register the tree data provider
  treeView?.dispose();
  treeView = vscode.window.createTreeView("adbMirrorDevices", {
    treeDataProvider: deviceProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Register the webview view provider for sidebar mirror fallback
  webviewViewRegistration?.dispose();
  webviewViewRegistration = vscode.window.registerWebviewViewProvider(
    "adbMirrorView",
    mirrorViewProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    },
  );
  context.subscriptions.push(webviewViewRegistration);

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

  if (treeView) {
    treeView.dispose();
    treeView = undefined;
  }

  if (webviewViewRegistration) {
    webviewViewRegistration.dispose();
    webviewViewRegistration = undefined;
  }

  isActivated = false;
}
