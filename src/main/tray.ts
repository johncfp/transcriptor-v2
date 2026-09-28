import { Menu, nativeImage, Tray } from "electron";

interface TrayOptions {
  iconPath: string;
  onOpen: () => void;
  onQuit: () => void;
}

// Module-level so the tray isn't garbage-collected (which removes the icon).
let tray: Tray | null = null;

export function createTray({ iconPath, onOpen, onQuit }: TrayOptions): Tray {
  const size = process.platform === "darwin" ? 18 : 16;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip("Transcriptor 2");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Transcriptor 2", click: onOpen },
      { type: "separator" },
      { label: "Quit", click: onQuit },
    ]),
  );
  // Windows: a left click opens the window. macOS shows the menu on click.
  if (process.platform !== "darwin") tray.on("click", onOpen);
  return tray;
}
