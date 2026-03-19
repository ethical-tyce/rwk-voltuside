const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');

let win;
let extensionWss = null;
const extensionClients = new Set();
let extensionBridgeError = '';
const explorerRoots = new Set();
const EXPLORER_MAX_DEPTH = 8;
const EXPLORER_MAX_ENTRIES = 3000;
const EXPLORER_IGNORED_FOLDERS = new Set(['node_modules', '.git']);
const IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff'
};

function isPathInsideRoot(targetPath, rootPath) {
    const relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedExplorerPath(targetPath) {
    for (const root of explorerRoots) {
        if (isPathInsideRoot(targetPath, root)) {
            return true;
        }
    }
    return false;
}

function resolveExplorerPath(inputPath, errorMessage = 'Invalid path') {
    const rawPath = typeof inputPath === 'string' ? inputPath.trim() : '';
    if (!rawPath) {
        throw new Error(errorMessage);
    }
    return path.resolve(rawPath);
}

function isOpenedRootPath(targetPath) {
    for (const root of explorerRoots) {
        if (path.resolve(root) === targetPath) return true;
    }
    return false;
}

function getImageMimeType(filePath) {
    const ext = String(path.extname(filePath || '')).toLowerCase();
    return IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
}

function normalizeTimeout(inputValue, fallbackMs = 20000) {
    const parsed = Number(inputValue);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
    return Math.max(500, Math.min(180000, Math.floor(parsed)));
}

async function resolveRuntimeCwd(inputValue) {
    const requested = typeof inputValue === 'string' ? inputValue.trim() : '';
    if (!requested) return process.cwd();

    const resolved = path.resolve(requested);
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat && stat.isDirectory()) {
        return resolved;
    }
    return process.cwd();
}

function runProcess(command, args = [], options = {}) {
    const timeoutMs = normalizeTimeout(options.timeoutMs, 20000);
    const cwd = options.cwd || process.cwd();

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            windowsHide: true,
            env: process.env
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            child.kill();
            reject(new Error(`Command timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });

        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });

        child.on('error', (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            reject(error);
        });

        child.on('close', (exitCode) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            resolve({
                command,
                args,
                cwd,
                stdout,
                stderr,
                exitCode: typeof exitCode === 'number' ? exitCode : 1
            });
        });
    });
}

function parseGitStatusOutput(rawValue) {
    const lines = String(rawValue || '').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
    let branchLine = '';
    const files = [];

    lines.forEach((line) => {
        if (line.startsWith('## ')) {
            branchLine = line.slice(3).trim();
            return;
        }
        if (line.length < 3) return;
        const indexStatus = line[0] || ' ';
        const worktreeStatus = line[1] || ' ';
        const remainder = line.slice(3).trim();
        if (!remainder) return;

        let pathValue = remainder;
        let originalPath = '';
        const renameMatch = remainder.match(/^(.+?)\s+->\s+(.+)$/);
        if (renameMatch) {
            originalPath = renameMatch[1].trim();
            pathValue = renameMatch[2].trim();
        }

        files.push({
            indexStatus,
            worktreeStatus,
            path: pathValue,
            originalPath
        });
    });

    const branchName = branchLine ? branchLine.split('...')[0].trim() : '';
    return {
        branchLine,
        branchName,
        files
    };
}

async function runGit(args = [], options = {}) {
    const cwd = await resolveRuntimeCwd(options.cwd);
    return runProcess('git', args, {
        cwd,
        timeoutMs: normalizeTimeout(options.timeoutMs, 20000)
    });
}

async function buildExplorerTree(currentPath, depth = 0, state = { visited: 0, truncated: false }) {
    if (state.visited >= EXPLORER_MAX_ENTRIES) {
        state.truncated = true;
        return [];
    }
    if (depth > EXPLORER_MAX_DEPTH) {
        return [];
    }

    let entries = [];
    try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
        return [];
    }

    entries = entries
        .filter((entry) => {
            if (!entry || !entry.name) return false;
            if (entry.name.startsWith('.')) return false;
            if (entry.isSymbolicLink()) return false;
            if (entry.isDirectory() && EXPLORER_IGNORED_FOLDERS.has(entry.name.toLowerCase())) return false;
            return true;
        })
        .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
        });

    const tree = [];
    for (const entry of entries) {
        if (state.visited >= EXPLORER_MAX_ENTRIES) {
            state.truncated = true;
            break;
        }

        const absolutePath = path.join(currentPath, entry.name);
        const node = {
            name: entry.name,
            path: absolutePath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };

        state.visited += 1;

        if (entry.isDirectory() && depth < EXPLORER_MAX_DEPTH) {
            node.children = await buildExplorerTree(absolutePath, depth + 1, state);
        }

        tree.push(node);
    }

    return tree;
}

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

    // Use the .ico asset on Windows for proper taskbar/shell icon rendering.
    const iconPath = path.join(__dirname, process.platform === 'win32' ? 'voltus.ico' : 'icon.png');

    win = new BrowserWindow({
        width: START_WIDTH,
        height: START_HEIGHT,
        minWidth: START_WIDTH,
        minHeight: START_HEIGHT,
        show: false,
        opacity: 0,
        frame: false,
        roundedCorners: false,
        alwaysOnTop: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            // Allow the CDN scripts (Monaco) to load
            webSecurity: false 
        },
        icon: iconPath
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
                win.setMinimumSize(600, 510);
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
    

    //win.webContents.openDevTools();

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

ipcMain.handle('app:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
        return await shell.openExternal(url);
    } catch (error) {
        console.error('[OpenExternal] Failed:', error && error.message ? error.message : String(error));
        return false;
    }
});

ipcMain.handle('explorer:pick-folder', async () => {
    if (!win || win.isDestroyed()) return null;

    const result = await dialog.showOpenDialog(win, {
        title: 'Open Folder',
        properties: ['openDirectory']
    });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return null;
    }

    const selectedPath = path.resolve(result.filePaths[0]);
    explorerRoots.add(selectedPath);
    return selectedPath;
});

ipcMain.handle('explorer:close-folder', async (_event, rootPath) => {
    const resolvedRoot = resolveExplorerPath(rootPath, 'No folder path provided');
    explorerRoots.delete(resolvedRoot);
    return true;
});

ipcMain.handle('explorer:restore-folder', async (_event, rootPath) => {
    const resolvedRoot = resolveExplorerPath(rootPath, 'No folder path provided');
    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) {
        throw new Error('Provided path is not a directory');
    }
    explorerRoots.add(resolvedRoot);
    return resolvedRoot;
});

ipcMain.handle('explorer:read-tree', async (_event, rootPath) => {
    const resolvedRoot = resolveExplorerPath(rootPath, 'No folder path provided');
    if (!isAllowedExplorerPath(resolvedRoot)) {
        throw new Error('Folder is outside allowed explorer roots');
    }

    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) {
        throw new Error('Provided path is not a directory');
    }

    const state = { visited: 0, truncated: false };
    const entries = await buildExplorerTree(resolvedRoot, 0, state);
    return {
        rootPath: resolvedRoot,
        entries,
        truncated: state.truncated
    };
});

ipcMain.handle('explorer:read-file', async (_event, filePath) => {
    const resolvedPath = resolveExplorerPath(filePath, 'No file path provided');
    if (!isAllowedExplorerPath(resolvedPath)) {
        throw new Error('File is outside allowed explorer roots');
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
        throw new Error('Provided path is not a file');
    }

    return fs.readFile(resolvedPath, 'utf8');
});

ipcMain.handle('explorer:read-image-data-url', async (_event, filePath) => {
    const resolvedPath = resolveExplorerPath(filePath, 'No file path provided');
    if (!isAllowedExplorerPath(resolvedPath)) {
        throw new Error('File is outside allowed explorer roots');
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
        throw new Error('Provided path is not a file');
    }

    const buffer = await fs.readFile(resolvedPath);
    const mimeType = getImageMimeType(resolvedPath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('explorer:write-file', async (_event, filePath, content) => {
    const resolvedPath = resolveExplorerPath(filePath, 'No file path provided');
    if (!isAllowedExplorerPath(resolvedPath)) {
        throw new Error('File is outside allowed explorer roots');
    }

    const nextContent = typeof content === 'string' ? content : String(content ?? '');
    await fs.writeFile(resolvedPath, nextContent, 'utf8');
    return true;
});

ipcMain.handle('explorer:create-file', async (_event, filePath, content = '') => {
    const resolvedPath = resolveExplorerPath(filePath, 'No file path provided');
    if (!isAllowedExplorerPath(resolvedPath)) {
        throw new Error('File is outside allowed explorer roots');
    }

    const parentPath = path.dirname(resolvedPath);
    const parentStat = await fs.stat(parentPath).catch(() => null);
    if (!parentStat || !parentStat.isDirectory()) {
        throw new Error('Parent directory does not exist');
    }

    const exists = await fs.stat(resolvedPath).then(() => true).catch(() => false);
    if (exists) {
        throw new Error('A file or folder already exists at this path');
    }

    const nextContent = typeof content === 'string' ? content : String(content ?? '');
    await fs.writeFile(resolvedPath, nextContent, 'utf8');
    return resolvedPath;
});

ipcMain.handle('explorer:create-directory', async (_event, directoryPath) => {
    const resolvedPath = resolveExplorerPath(directoryPath, 'No directory path provided');
    if (!isAllowedExplorerPath(resolvedPath)) {
        throw new Error('Directory is outside allowed explorer roots');
    }

    const exists = await fs.stat(resolvedPath).then(() => true).catch(() => false);
    if (exists) {
        throw new Error('A file or folder already exists at this path');
    }

    await fs.mkdir(resolvedPath, { recursive: false });
    return resolvedPath;
});

ipcMain.handle('explorer:rename-path', async (_event, sourcePath, destinationPath) => {
    const resolvedSource = resolveExplorerPath(sourcePath, 'No source path provided');
    const resolvedDestination = resolveExplorerPath(destinationPath, 'No destination path provided');

    if (!isAllowedExplorerPath(resolvedSource) || !isAllowedExplorerPath(resolvedDestination)) {
        throw new Error('Source or destination path is outside allowed explorer roots');
    }
    if (resolvedSource === resolvedDestination) {
        throw new Error('Source and destination are the same');
    }
    if (isOpenedRootPath(resolvedSource)) {
        throw new Error('Renaming the opened root folder is not allowed');
    }

    const sourceStat = await fs.stat(resolvedSource).catch(() => null);
    if (!sourceStat) {
        throw new Error('Source file or folder does not exist');
    }

    const destinationExists = await fs.stat(resolvedDestination).then(() => true).catch(() => false);
    if (destinationExists) {
        throw new Error('Destination already exists');
    }

    const destinationParent = path.dirname(resolvedDestination);
    const destinationParentStat = await fs.stat(destinationParent).catch(() => null);
    if (!destinationParentStat || !destinationParentStat.isDirectory()) {
        throw new Error('Destination parent directory does not exist');
    }

    await fs.rename(resolvedSource, resolvedDestination);
    return resolvedDestination;
});

ipcMain.handle('explorer:delete-path', async (_event, targetPath) => {
    const resolvedPath = resolveExplorerPath(targetPath, 'No target path provided');
    if (!isAllowedExplorerPath(resolvedPath)) {
        throw new Error('Target path is outside allowed explorer roots');
    }
    if (isOpenedRootPath(resolvedPath)) {
        throw new Error('Deleting the opened root folder is not allowed');
    }

    const targetStat = await fs.stat(resolvedPath).catch(() => null);
    if (!targetStat) {
        throw new Error('Target file or folder does not exist');
    }

    await fs.rm(resolvedPath, { recursive: true, force: false });
    return true;
});

ipcMain.handle('runtime:run-python', async (_event, code, options = {}) => {
    const scriptSource = typeof code === 'string' ? code : String(code ?? '');
    if (!scriptSource.trim()) {
        return { stdout: '', stderr: '', exitCode: 0, command: '' };
    }

    const requestedCwd = options && typeof options.cwd === 'string' ? options.cwd.trim() : '';
    let cwd = process.cwd();
    if (requestedCwd) {
        const resolvedCwd = path.resolve(requestedCwd);
        const cwdStat = await fs.stat(resolvedCwd).catch(() => null);
        if (cwdStat && cwdStat.isDirectory()) {
            cwd = resolvedCwd;
        }
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voltus-python-'));
    const scriptPath = path.join(tempDir, 'run.py');
    await fs.writeFile(scriptPath, scriptSource, 'utf8');

    const attempts = process.platform === 'win32'
        ? [
            { command: 'py', args: ['-3', scriptPath] },
            { command: 'python', args: [scriptPath] },
            { command: 'python3', args: [scriptPath] }
        ]
        : [
            { command: 'python3', args: [scriptPath] },
            { command: 'python', args: [scriptPath] }
        ];

    const timeoutMs = 25000;

    try {
        for (const attempt of attempts) {
            try {
                const result = await new Promise((resolve, reject) => {
                    const child = spawn(attempt.command, attempt.args, {
                        cwd,
                        windowsHide: true
                    });

                    let stdout = '';
                    let stderr = '';
                    let finished = false;

                    const timeout = setTimeout(() => {
                        if (finished) return;
                        finished = true;
                        child.kill();
                        reject(new Error(`Python execution timed out after ${Math.floor(timeoutMs / 1000)}s`));
                    }, timeoutMs);

                    child.stdout.on('data', (chunk) => {
                        stdout += String(chunk || '');
                    });
                    child.stderr.on('data', (chunk) => {
                        stderr += String(chunk || '');
                    });

                    child.on('error', (error) => {
                        if (finished) return;
                        finished = true;
                        clearTimeout(timeout);
                        reject(error);
                    });

                    child.on('close', (exitCode) => {
                        if (finished) return;
                        finished = true;
                        clearTimeout(timeout);
                        resolve({
                            stdout,
                            stderr,
                            exitCode: typeof exitCode === 'number' ? exitCode : 1,
                            command: attempt.command
                        });
                    });
                });

                return result;
            } catch (error) {
                const message = String(error && error.message ? error.message : error || '');
                const isNotFound = (error && error.code === 'ENOENT')
                    || /not recognized as an internal or external command/i.test(message)
                    || /No such file or directory/i.test(message)
                    || /not found/i.test(message);
                if (!isNotFound) {
                    throw error;
                }
            }
        }

        throw new Error('Python runtime not found. Install Python 3 (python3 / python / py).');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
});

ipcMain.handle('runtime:run-shell', async (_event, command, options = {}) => {
    const script = typeof command === 'string' ? command.trim() : '';
    if (!script) {
        return {
            command: '',
            args: [],
            cwd: await resolveRuntimeCwd(options && options.cwd),
            stdout: '',
            stderr: '',
            exitCode: 0
        };
    }

    const cwd = await resolveRuntimeCwd(options && options.cwd);
    const timeoutMs = normalizeTimeout(options && options.timeoutMs, 45000);
    const attempts = process.platform === 'win32'
        ? [
            { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] },
            { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', script] },
            { command: 'cmd', args: ['/d', '/s', '/c', script] }
        ]
        : [
            { command: 'bash', args: ['-lc', script] },
            { command: 'sh', args: ['-lc', script] }
        ];

    for (const attempt of attempts) {
        try {
            return await runProcess(attempt.command, attempt.args, { cwd, timeoutMs });
        } catch (error) {
            const message = String(error && error.message ? error.message : error || '');
            const isNotFound = (error && error.code === 'ENOENT')
                || /not recognized as an internal or external command/i.test(message)
                || /No such file or directory/i.test(message)
                || /not found/i.test(message);
            if (!isNotFound) {
                throw error;
            }
        }
    }

    throw new Error('No supported shell found on this system.');
});

ipcMain.handle('runtime:open-devtools', () => {
    if (!win || win.isDestroyed() || !win.webContents) return false;
    if (!win.webContents.isDevToolsOpened()) {
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        win.webContents.focus();
    }
    return true;
});

ipcMain.handle('runtime:git-status', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    try {
        const result = await runGit(['status', '--porcelain=1', '-b'], { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
        const parsed = parseGitStatusOutput(result.stdout);
        return {
            ok: true,
            cwd: result.cwd,
            branchLine: parsed.branchLine,
            branchName: parsed.branchName,
            files: parsed.files,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
        };
    } catch (error) {
        return {
            ok: false,
            cwd: await resolveRuntimeCwd(cwdInput),
            branchLine: '',
            branchName: '',
            files: [],
            stdout: '',
            stderr: '',
            exitCode: 1,
            error: error && error.message ? error.message : String(error)
        };
    }
});

ipcMain.handle('runtime:git-diff', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const filePath = options && typeof options.filePath === 'string' ? options.filePath.trim() : '';
    const staged = Boolean(options && options.staged);
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (filePath) args.push('--', filePath);

    const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    return {
        ok: true,
        cwd: result.cwd,
        diff: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
});

ipcMain.handle('runtime:git-stage', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const paths = Array.isArray(options && options.paths)
        ? options.paths.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const args = paths.length > 0 ? ['add', '--', ...paths] : ['add', '-A'];
    const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    return {
        ok: result.exitCode === 0,
        cwd: result.cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
});

ipcMain.handle('runtime:git-unstage', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const paths = Array.isArray(options && options.paths)
        ? options.paths.map((value) => String(value || '').trim()).filter(Boolean)
        : [];

    const runRestore = async () => {
        const args = paths.length > 0
            ? ['restore', '--staged', '--', ...paths]
            : ['restore', '--staged', '.'];
        return runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    };

    try {
        const result = await runRestore();
        return {
            ok: result.exitCode === 0,
            cwd: result.cwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
        };
    } catch (error) {
        const fallbackArgs = paths.length > 0
            ? ['reset', 'HEAD', '--', ...paths]
            : ['reset', 'HEAD'];
        const result = await runGit(fallbackArgs, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
        return {
            ok: result.exitCode === 0,
            cwd: result.cwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            note: error && error.message ? error.message : String(error)
        };
    }
});

ipcMain.handle('runtime:git-commit', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const message = options && typeof options.message === 'string' ? options.message.trim() : '';
    if (!message) {
        throw new Error('Commit message is required.');
    }

    const result = await runGit(['commit', '-m', message], { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    return {
        ok: result.exitCode === 0,
        cwd: result.cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
});

ipcMain.handle('runtime:git-log', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const limitRaw = Number(options && options.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 20;
    const result = await runGit(
        ['log', '--pretty=format:%h%x09%an%x09%ar%x09%s', '-n', String(limit)],
        { cwd: cwdInput, timeoutMs: options && options.timeoutMs }
    );

    const entries = String(result.stdout || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [hash = '', author = '', relativeTime = '', ...subjectParts] = line.split('\t');
            return {
                hash: hash.trim(),
                author: author.trim(),
                relativeTime: relativeTime.trim(),
                subject: subjectParts.join('\t').trim()
            };
        });

    return {
        ok: true,
        cwd: result.cwd,
        entries,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
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
