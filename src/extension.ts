import * as vscode from "vscode";
import { AdbDeviceProvider, AdbDeviceItem } from "./deviceProvider";
import { MirrorPanel } from "./mirrorPanel";

let deviceProvider: AdbDeviceProvider;
let currentMirror: MirrorPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("ADB Mirror extension is now active!");

  // Create the device provider
  deviceProvider = new AdbDeviceProvider();

  // Register the tree data provider
  const treeView = vscode.window.createTreeView("adbMirrorDevices", {
    treeDataProvider: deviceProvider,
    showCollapseAll: false,
  });

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
      stopMirror();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendHome", () => {
      void sendKeyEvent(3);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendBack", () => {
      void sendKeyEvent(4);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendVolumeUp", () => {
      void sendKeyEvent(24);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendVolumeDown", () => {
      void sendKeyEvent(25);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("adbMirror.sendPower", () => {
      void sendKeyEvent(26);
    }),
  );

  // Store the tree view for cleanup
  context.subscriptions.push(treeView);

  // Initial refresh
  deviceProvider.refresh();
}

async function startMirror(serial: string): Promise<void> {
  if (currentMirror) {
    vscode.window.showWarningMessage(
      "Another mirror session is already active",
    );
    return;
  }

  try {
    currentMirror = new MirrorPanel(serial, () => {
      currentMirror = undefined;
    });
    await currentMirror.show();

    vscode.window.showInformationMessage(
      `Mirror started for device: ${serial}`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to start mirror: ${error}`);
    currentMirror = undefined;
  }
}

function stopMirror(): void {
  if (currentMirror) {
    currentMirror.dispose();
    currentMirror = undefined;
    vscode.window.showInformationMessage("Mirror stopped");
  } else {
    vscode.window.showInformationMessage("No active mirror session");
  }
}

async function sendKeyEvent(keyCode: number): Promise<void> {
  if (!currentMirror) {
    vscode.window.showInformationMessage("No active mirror session");
    return;
  }

  await currentMirror.sendKeyEvent(keyCode);
}

export function deactivate() {
  if (currentMirror) {
    currentMirror.dispose();
  }

  if (deviceProvider) {
    deviceProvider.dispose();
  }
}
