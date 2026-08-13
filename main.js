const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// Ecole Systems is a single-file, localStorage-backed app — no server needed.
// This window just loads that file directly from disk.

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1f3d', // matches --navy, avoids a white flash on load
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    title: 'Ecole Systems'
  });

  win.setMenuBarVisibility(false); // this is a finished app, not a browser — no File/Edit/View bar
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Any link the app tries to open in a "new tab" (e.g. an external URL)
  // should go to the user's real browser, not spawn another app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
