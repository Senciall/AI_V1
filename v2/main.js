const { app, BrowserWindow } = require('electron');

let win = null;
let expressPort = 3000;

function createWindow(port) {
  expressPort = port;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    title: 'MyAI',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,   // required for <webview> to work
    },
  });

  win.loadURL(`http://localhost:${port}`);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  const { startServer, PORT } = require('./server');
  startServer(PORT, (port) => createWindow(port));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) createWindow(expressPort);
});
