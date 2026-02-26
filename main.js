const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');

let win;
let extensionWss = null;
const extensionClients = new Set();
let extensionBridgeError = '';

function getBridgeStatus() {
    return {
        serverRunning: Boolean(extensionWss),
        connectedClients: extensionClients.size,
        error: extensionBridgeError
    };
}

function emitBridgeStatus() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('extension:status', getBridgeStatus());
}

function startExtensionBridge() {
    let WebSocketServer;
    try {
        ({ WebSocketServer } = require('ws'));
    } catch (error) {
        extensionBridgeError = 'Missing dependency "ws". Run: npm install ws';
        console.error('[Bridge] ws dependency missing:', error.message);
        return;
    }

    try {
        extensionWss = new WebSocketServer({ host: '0.0.0.0', port: 8181 });
        extensionBridgeError = '';
        console.log('[Bridge] Listening on ws://0.0.0.0:8181');

        extensionWss.on('connection', (socket) => {
            extensionClients.add(socket);
            emitBridgeStatus();

            socket.on('message', (message) => {
                if (!win || win.isDestroyed()) return;
                win.webContents.send('extension:message', message.toString());
            });

            const cleanup = () => {
                extensionClients.delete(socket);
                emitBridgeStatus();
            };

            socket.on('close', cleanup);
            socket.on('error', cleanup);
        });

        extensionWss.on('error', (error) => {
            extensionBridgeError = error.message;
            console.error('[Bridge] Server error:', error.message);
            emitBridgeStatus();
        });
    } catch (error) {
        extensionWss = null;
        extensionBridgeError = error.message;
        console.error('[Bridge] Failed to start:', error.message);
    }
}

function stopExtensionBridge() {
    for (const socket of extensionClients) {
        try {
            socket.close();
        } catch {
            // Ignore socket close errors during shutdown.
        }
    }
    extensionClients.clear();

    if (extensionWss) {
        try {
            extensionWss.close();
        } catch {
            // Ignore server close errors during shutdown.
        }
        extensionWss = null;
    }
}

function createWindow() {
    const START_WIDTH = 700;
    const START_HEIGHT = 385;
    const TARGET_WIDTH = 1000;
    const TARGET_HEIGHT = 550;
    const ANIM_DURATION_MS = 800; // ← make this bigger for slower
    const ANIM_INTERVAL_MS = 10;

    win = new BrowserWindow({
        width: START_WIDTH,
        height: START_HEIGHT,
        minWidth: START_WIDTH,
        minHeight: START_HEIGHT,
        show: false,
        opacity: 0,
        frame: false,
        roundedCorners: false,
        alwaysOnTop: true,
        titleBarStyle: 'hidden',
        backgroundColor: '#000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            // Allow the CDN scripts (Monaco) to load
            webSecurity: false 
        },
        icon: path.join(__dirname, 'icon.png')
    });

    // Load your HTML file
    win.loadFile('index.html');

    // Remove the default menu bar
    Menu.setApplicationMenu(null);

    // Animate the window from small to full size after the renderer is ready.
    const steps = ANIM_DURATION_MS / ANIM_INTERVAL_MS;
    let step = 0;
    win.center();
    const initialBounds = win.getBounds();
    const anchorCenterX = initialBounds.x + Math.round(initialBounds.width / 2);
    const anchorCenterY = initialBounds.y + Math.round(initialBounds.height / 2);

    const startGrowAnimation = () => {
        if (!win || win.isDestroyed()) return;
        win.show();
        win.setOpacity(1);

        const grow = setInterval(() => {
            if (!win || win.isDestroyed()) {
                clearInterval(grow);
                return;
            }

            step++;
            const progress = Math.min(step / steps, 1);
            const easedProgress = 1 - Math.pow(1 - progress, 4); // stronger ease-out (faster start)
            const width = Math.round(START_WIDTH + (TARGET_WIDTH - START_WIDTH) * easedProgress);
            const height = Math.round(START_HEIGHT + (TARGET_HEIGHT - START_HEIGHT) * easedProgress);
            const x = anchorCenterX - Math.round(width / 2);
            const y = anchorCenterY - Math.round(height / 2);
            win.setBounds({ x, y, width, height }, false);

            if (step >= steps) {
                clearInterval(grow);
                win.setMinimumSize(600, 460);
                win.webContents.send('startup:window-expanded');
            }
        }, ANIM_INTERVAL_MS);
    };

    win.webContents.on('did-finish-load', () => {
        emitBridgeStatus();
        setTimeout(() => {
            win.setOpacity(0);
            win.show();
            setTimeout(() => {
                win.setOpacity(1);
                startGrowAnimation();
            }, 100);
        }, 200);
    });
    

    win.webContents.openDevTools();

}

app.whenReady().then(() => {
    startExtensionBridge();
    createWindow();
});

ipcMain.handle('window:minimize', () => {
    if (!win) return;
    win.minimize();
});

ipcMain.handle('window:maximize-toggle', () => {
    if (!win) return false;
    if (win.isMaximized()) {
        win.unmaximize();
        return false;
    }
    win.maximize();
    return true;
});

ipcMain.handle('window:close', () => {
    if (!win) return;
    win.close();
});

ipcMain.handle('window:always-on-top:get', () => {
    if (!win || win.isDestroyed()) return true;
    return win.isAlwaysOnTop();
});

ipcMain.handle('window:always-on-top:set', (_event, enabled) => {
    if (!win || win.isDestroyed()) return false;
    const shouldEnable = Boolean(enabled);
    win.setAlwaysOnTop(shouldEnable);
    return win.isAlwaysOnTop();
});

ipcMain.on('extension:send', (_event, payload) => {
    if (!extensionWss) return;
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);

    for (const socket of extensionClients) {
        if (socket.readyState === 1) {
            socket.send(message);
        }
    }
});

ipcMain.handle('extension:get-status', () => {
    return getBridgeStatus();
});

ipcMain.handle('app:get-version', () => {
    // return the current application version from Electron
    return app.getVersion();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
    stopExtensionBridge();
});
