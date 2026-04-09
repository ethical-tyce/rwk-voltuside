const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const DiscordRPC = require('discord-rpc');
let electronUpdaterModule = null;
try {
    electronUpdaterModule = require('electron-updater');
} catch {
    electronUpdaterModule = null;
}
const autoUpdater = electronUpdaterModule ? electronUpdaterModule.autoUpdater : null;
let nodePty = null;
try {
    nodePty = require('node-pty');
} catch {
    nodePty = null;
}

let win;
let extensionWss = null;
const extensionClients = new Set();
let extensionBridgeError = '';
const explorerRoots = new Set();
const EXPLORER_MAX_DEPTH = 8;
const EXPLORER_MAX_ENTRIES = 3000;
const EXPLORER_IGNORED_FOLDERS = new Set(['node_modules', '.git']);
const SEARCH_IGNORED_FOLDERS = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '.next',
    '.cache',
    'dist',
    'build',
    'out',
    'coverage'
]);
const SEARCH_MAX_RESULTS = 400;
const SEARCH_MAX_FILES = 2500;
const SEARCH_MAX_FILE_BYTES = 1_500_000;
const SEARCH_EXT_DENYLIST = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif', '.tif', '.tiff',
    '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.mp3', '.wav', '.flac', '.m4a', '.aac',
    '.mp4', '.mov', '.avi', '.mkv', '.webm',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.dll', '.so', '.dylib', '.exe', '.bin'
]);
const runtimeExecutionPolicy = {
    allowShell: false,
    allowPython: false,
    allowAnyCwd: false
};
const CMD_CHANNEL_DATA = 'runtime:cmd:data';
const CMD_CHANNEL_EXIT = 'runtime:cmd:exit';
const cmdSessions = new Map();
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
const DISCORD_RPC_CLIENT_ID = String(
    process.env.DISCORD_RPC_CLIENT_ID
    || process.env.VOLTUS_DISCORD_CLIENT_ID
    || '1466678889987444879'
).trim();
const DISCORD_RPC_TEXT_LIMIT = 128;
const DISCORD_RPC_BUTTON_LABEL_LIMIT = 32;
const DISCORD_RPC_MAX_BUTTONS = 2;
const DISCORD_RPC_RECONNECT_MS = 15000;
let discordRpcClient = null;
let discordRpcReady = false;
let discordRpcConnecting = false;
let discordRpcReconnectTimer = null;
let discordRpcActivity = null;
const discordRpcSessionStartedAt = Date.now();
let discordRpcWarnedMissingClientId = false;
const UPDATE_CHANNEL_STATE = 'updater:state';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const updaterState = {
    enabled: false,
    phase: 'idle',
    message: 'Updater not initialized.',
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    percent: null,
    currentVersion: app.getVersion(),
    releaseVersion: '',
    error: ''
};
let updaterCheckTimer = null;
let updaterListenersRegistered = false;

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

function getDefaultRuntimeCwd() {
    const homeDir = typeof os.homedir === 'function' ? String(os.homedir() || '').trim() : '';
    if (homeDir) {
        return path.resolve(homeDir);
    }
    return path.resolve(process.cwd());
}

async function resolveRuntimeCwd(inputValue) {
    const defaultCwd = getDefaultRuntimeCwd();
    const requested = typeof inputValue === 'string' ? inputValue.trim() : '';
    if (!requested) return defaultCwd;

    const resolved = path.resolve(requested);
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat && stat.isDirectory()) {
        return resolved;
    }
    return defaultCwd;
}

function getRuntimeTrustedRoots() {
    const roots = new Set([path.resolve(process.cwd()), getDefaultRuntimeCwd()]);
    for (const root of explorerRoots) {
        if (typeof root === 'string' && root.trim()) {
            roots.add(path.resolve(root));
        }
    }
    return Array.from(roots);
}

function isAllowedRuntimeCwd(targetPath) {
    if (runtimeExecutionPolicy.allowAnyCwd) return true;
    const resolvedTarget = path.resolve(String(targetPath || process.cwd()));
    const trustedRoots = getRuntimeTrustedRoots();
    for (const root of trustedRoots) {
        if (isPathInsideRoot(resolvedTarget, root)) {
            return true;
        }
    }
    return false;
}

function getRuntimePolicyState() {
    return {
        allowShell: Boolean(runtimeExecutionPolicy.allowShell),
        allowPython: Boolean(runtimeExecutionPolicy.allowPython),
        allowAnyCwd: Boolean(runtimeExecutionPolicy.allowAnyCwd),
        trustedRoots: getRuntimeTrustedRoots()
    };
}

function assertRuntimeExecutionAllowed(kind, cwd) {
    const scope = String(kind || '').toLowerCase();
    if (scope === 'shell' && !runtimeExecutionPolicy.allowShell) {
        throw new Error('Shell execution is blocked. Enable it in Settings > Security.');
    }
    if (scope === 'python' && !runtimeExecutionPolicy.allowPython) {
        throw new Error('Python execution is blocked. Enable it in Settings > Security.');
    }
    if (!isAllowedRuntimeCwd(cwd)) {
        throw new Error('Runtime execution outside trusted workspace roots is blocked.');
    }
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(query, options = {}) {
    const sourceQuery = String(query || '');
    if (!sourceQuery) return null;

    const useRegex = Boolean(options.useRegex);
    const wholeWord = Boolean(options.wholeWord);
    const matchCase = Boolean(options.matchCase);
    const source = useRegex ? sourceQuery : escapeRegExp(sourceQuery);
    const wrappedSource = wholeWord ? `\\b(?:${source})\\b` : source;
    const flags = `g${matchCase ? '' : 'i'}`;
    return new RegExp(wrappedSource, flags);
}

function parseRipgrepLine(rawLine) {
    const line = String(rawLine || '');
    const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
    if (!match) return null;
    const [, filePath, lineNumber, column, preview] = match;
    return {
        path: String(filePath || '').trim(),
        lineNumber: Math.max(1, Number(lineNumber) || 1),
        column: Math.max(1, Number(column) || 1),
        preview: String(preview || '').trim()
    };
}

async function collectSearchFiles(rootPath, state, depth = 0) {
    if (!state || state.files.length >= state.maxFiles) return;
    if (depth > state.maxDepth) return;

    let entries = [];
    try {
        entries = await fs.readdir(rootPath, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (state.files.length >= state.maxFiles) return;
        if (!entry || !entry.name) continue;
        if (entry.name.startsWith('.')) {
            if (entry.name !== '.env') continue;
        }
        if (entry.isSymbolicLink()) continue;

        const absolutePath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            if (SEARCH_IGNORED_FOLDERS.has(entry.name.toLowerCase())) continue;
            await collectSearchFiles(absolutePath, state, depth + 1);
            continue;
        }

        if (!entry.isFile()) continue;
        const ext = String(path.extname(entry.name || '')).toLowerCase();
        if (SEARCH_EXT_DENYLIST.has(ext)) continue;
        state.files.push(absolutePath);
    }
}

async function runRipgrepSearch(rootPath, query, options = {}) {
    if (!buildSearchRegex(query, options)) return [];
    const maxResults = Math.max(1, Math.min(SEARCH_MAX_RESULTS, Number(options.maxResults) || SEARCH_MAX_RESULTS));
    const args = [
        '--line-number',
        '--column',
        '--no-heading',
        '--color',
        'never',
        '--hidden',
        '--max-filesize',
        '1500K',
        '--max-count',
        '8',
        '--glob',
        '!node_modules/**',
        '--glob',
        '!.git/**'
    ];
    if (!options.useRegex) {
        args.push('-F');
    }
    if (!options.matchCase) {
        args.push('--ignore-case');
    }
    args.push(String(query), '.');

    try {
        const result = await runProcess('rg', args, { cwd: rootPath, timeoutMs: normalizeTimeout(options.timeoutMs, 20000) });
        if (result.exitCode !== 0 && result.exitCode !== 1) {
            return [];
        }
        const lines = String(result.stdout || '').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
        const matches = [];
        for (const line of lines) {
            if (matches.length >= maxResults) break;
            const parsed = parseRipgrepLine(line);
            if (!parsed || !parsed.path) continue;
            const normalized = path.resolve(rootPath, parsed.path);
            matches.push({
                path: normalized,
                name: path.basename(normalized),
                lineNumber: parsed.lineNumber,
                column: parsed.column,
                preview: parsed.preview
            });
        }
        return matches;
    } catch (error) {
        const message = String(error && error.message ? error.message : error || '');
        const isNotFound = (error && error.code === 'ENOENT')
            || /not recognized as an internal or external command/i.test(message)
            || /No such file or directory/i.test(message)
            || /not found/i.test(message);
        if (isNotFound) return [];
        throw error;
    }
}

async function runFallbackSearch(rootPath, query, options = {}) {
    const regex = buildSearchRegex(query, options);
    if (!regex) return [];

    const maxResults = Math.max(1, Math.min(SEARCH_MAX_RESULTS, Number(options.maxResults) || SEARCH_MAX_RESULTS));
    const maxFiles = Math.max(1, Math.min(SEARCH_MAX_FILES, Number(options.maxFiles) || SEARCH_MAX_FILES));
    const state = {
        files: [],
        maxFiles,
        maxDepth: 30
    };

    await collectSearchFiles(rootPath, state, 0);
    const matches = [];

    for (const filePath of state.files) {
        if (matches.length >= maxResults) break;

        const fileStat = await fs.stat(filePath).catch(() => null);
        if (!fileStat || !fileStat.isFile() || fileStat.size > SEARCH_MAX_FILE_BYTES) continue;

        const content = await fs.readFile(filePath, 'utf8').catch(() => null);
        if (typeof content !== 'string' || content.length === 0) continue;
        if (content.includes('\0')) continue;

        const lines = content.replace(/\r\n/g, '\n').split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            if (matches.length >= maxResults) break;
            const lineValue = lines[lineIndex];
            regex.lastIndex = 0;
            const firstMatch = regex.exec(lineValue);
            if (!firstMatch) continue;

            matches.push({
                path: filePath,
                name: path.basename(filePath),
                lineNumber: lineIndex + 1,
                column: Math.max(1, Number(firstMatch.index || 0) + 1),
                preview: String(lineValue || '').trim()
            });
        }
    }

    return matches;
}

async function searchInFiles(rootPath, query, options = {}) {
    const fromRg = await runRipgrepSearch(rootPath, query, options);
    if (fromRg.length > 0) return fromRg;
    return runFallbackSearch(rootPath, query, options);
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

function emitCmdSessionTo(sender, channel, payload = {}) {
    if (!sender || sender.isDestroyed()) return;
    try {
        sender.send(channel, payload);
    } catch {
        // Ignore renderer send failures during shutdown.
    }
}

function normalizeCmdSessionId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80);
}

function createCmdSessionId() {
    return `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizePersistentShellType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'pwr' || raw === 'powershell' || raw === 'pwsh') {
        return 'pwr';
    }
    return 'cmd';
}

function getPersistentShellLaunchAttempts(shellType = 'cmd') {
    const shell = normalizePersistentShellType(shellType);
    if (shell === 'pwr') {
        const systemRoot = String(process.env.SystemRoot || '').trim() || 'C:\\Windows';
        return [
            {
                command: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                args: ['-NoLogo']
            },
            {
                command: 'powershell.exe',
                args: ['-NoLogo']
            }
        ];
    }
    const cmdExecutable = String(process.env.ComSpec || '').trim() || 'cmd.exe';
    return [
        {
            command: cmdExecutable,
            args: ['/d']
        }
    ];
}

function getDefaultCmdSession() {
    const iterator = cmdSessions.values();
    const first = iterator.next();
    return first && !first.done ? first.value : null;
}

function resolveCmdSessionForRequest(sessionId = '', required = true) {
    const normalizedId = normalizeCmdSessionId(sessionId);
    if (normalizedId) {
        const direct = cmdSessions.get(normalizedId) || null;
        if (direct || !required) return direct;
        throw new Error('cmd.exe session is not running.');
    }

    if (cmdSessions.size === 1) {
        return getDefaultCmdSession();
    }

    if (!required) {
        return getDefaultCmdSession();
    }

    if (cmdSessions.size > 1) {
        throw new Error('Multiple cmd sessions are running; sessionId is required.');
    }

    throw new Error('cmd.exe session is not running.');
}

function stopCmdSession(sessionId = '', reason = 'stopped') {
    const session = resolveCmdSessionForRequest(sessionId, false);
    if (!session) return false;
    const resolvedId = String(session.id || '');
    session.stopping = true;
    session.stopReason = String(reason || 'stopped');
    try {
        if (session.ptyProcess) {
            session.ptyProcess.kill();
            return true;
        }
    } catch {
        // Ignore process kill errors during shutdown.
    }
    const sender = session.sender;
    const code = typeof session.exitCode === 'number' ? session.exitCode : null;
    const signal = session.signal || null;
    const finalReason = session.stopReason || String(reason || 'stopped');
    cmdSessions.delete(resolvedId);
    emitCmdSessionTo(sender, CMD_CHANNEL_EXIT, { sessionId: resolvedId, code, signal, reason: finalReason });
    return true;
}

function stopAllCmdSessions(reason = 'stopped') {
    const sessionIds = [...cmdSessions.keys()];
    sessionIds.forEach((sessionId) => {
        stopCmdSession(sessionId, reason);
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

function isSafeExternalUrl(urlValue) {
    try {
        const parsed = new URL(String(urlValue || ''));
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
    } catch {
        return false;
    }
}

function truncateDiscordRpcText(value, maxLength = DISCORD_RPC_TEXT_LIMIT) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeDiscordRpcButtons(inputButtons) {
    if (!Array.isArray(inputButtons)) return [];
    const buttons = [];
    for (const button of inputButtons) {
        if (!button || typeof button !== 'object') continue;
        const label = truncateDiscordRpcText(button.label, DISCORD_RPC_BUTTON_LABEL_LIMIT);
        const url = String(button.url || '').trim();
        if (!label || !url || !isSafeExternalUrl(url)) continue;
        buttons.push({ label, url });
        if (buttons.length >= DISCORD_RPC_MAX_BUTTONS) break;
    }
    return buttons;
}

function normalizeDiscordRpcTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric > 10_000_000_000) return new Date(numeric);
    return new Date(Math.floor(numeric * 1000));
}

function sanitizeDiscordRpcActivity(input = {}) {
    if (!input || typeof input !== 'object') return null;

    const details = truncateDiscordRpcText(input.details);
    const state = truncateDiscordRpcText(input.state);
    const largeImageKey = truncateDiscordRpcText(input.largeImageKey);
    const largeImageText = truncateDiscordRpcText(input.largeImageText);
    const smallImageKey = truncateDiscordRpcText(input.smallImageKey);
    const smallImageText = truncateDiscordRpcText(input.smallImageText);
    const startTimestamp = normalizeDiscordRpcTimestamp(input.startTimestamp);
    const endTimestamp = normalizeDiscordRpcTimestamp(input.endTimestamp);
    const buttons = sanitizeDiscordRpcButtons(input.buttons);

    const activity = {};
    if (details) activity.details = details;
    if (state) activity.state = state;
    if (largeImageKey) activity.largeImageKey = largeImageKey;
    if (largeImageText) activity.largeImageText = largeImageText;
    if (smallImageKey) activity.smallImageKey = smallImageKey;
    if (smallImageText) activity.smallImageText = smallImageText;
    if (startTimestamp) activity.startTimestamp = startTimestamp;
    if (endTimestamp) activity.endTimestamp = endTimestamp;
    if (buttons.length > 0) activity.buttons = buttons;

    if (!activity.details && !activity.state && !activity.largeImageKey && !activity.smallImageKey) {
        return null;
    }

    return activity;
}

function buildDefaultDiscordRpcActivity() {
    return sanitizeDiscordRpcActivity({
        details: 'Using Voltus IDE',
        state: 'In workspace',
        startTimestamp: discordRpcSessionStartedAt
    });
}

function getDiscordRpcStatus() {
    return {
        enabled: Boolean(DISCORD_RPC_CLIENT_ID),
        connected: discordRpcReady,
        connecting: discordRpcConnecting,
        clientIdConfigured: Boolean(DISCORD_RPC_CLIENT_ID)
    };
}

function destroyDiscordRpcClient(client) {
    if (!client) return;
    try {
        client.removeAllListeners();
    } catch {
        // Ignore listener cleanup errors.
    }
    try {
        if (typeof client.destroy === 'function') {
            client.destroy();
        }
    } catch {
        // Ignore destroy errors during shutdown/reconnect.
    }
}

function scheduleDiscordRpcReconnect() {
    if (!DISCORD_RPC_CLIENT_ID) return;
    if (discordRpcReconnectTimer) return;
    discordRpcReconnectTimer = setTimeout(() => {
        discordRpcReconnectTimer = null;
        void startDiscordRpc();
    }, DISCORD_RPC_RECONNECT_MS);
}

function handleDiscordRpcDrop(client, message) {
    if (discordRpcClient !== client) return;
    if (message) {
        console.warn(`[Discord RPC] ${message}`);
    }
    discordRpcReady = false;
    discordRpcConnecting = false;
    discordRpcClient = null;
    destroyDiscordRpcClient(client);
    scheduleDiscordRpcReconnect();
}

async function applyDiscordRpcActivity() {
    if (!discordRpcClient || !discordRpcReady) return false;
    try {
        if (!discordRpcActivity) {
            if (typeof discordRpcClient.clearActivity === 'function') {
                await discordRpcClient.clearActivity();
            }
            return true;
        }
        await discordRpcClient.setActivity(discordRpcActivity);
        return true;
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn(`[Discord RPC] Failed to apply activity: ${message}`);
        return false;
    }
}

async function startDiscordRpc() {
    if (!DISCORD_RPC_CLIENT_ID) {
        if (!discordRpcWarnedMissingClientId) {
            discordRpcWarnedMissingClientId = true;
            console.log('[Discord RPC] Disabled. Set DISCORD_RPC_CLIENT_ID to enable Rich Presence.');
        }
        return;
    }
    if (discordRpcReady || discordRpcConnecting) return;

    if (discordRpcReconnectTimer) {
        clearTimeout(discordRpcReconnectTimer);
        discordRpcReconnectTimer = null;
    }

    DiscordRPC.register(DISCORD_RPC_CLIENT_ID);

    const client = new DiscordRPC.Client({ transport: 'ipc' });
    discordRpcClient = client;
    discordRpcConnecting = true;

    client.on('ready', async () => {
        if (discordRpcClient !== client) return;
        discordRpcReady = true;
        discordRpcConnecting = false;
        await applyDiscordRpcActivity();
        console.log('[Discord RPC] Connected');
    });

    client.on('disconnected', () => {
        handleDiscordRpcDrop(client, 'Disconnected. Retrying...');
    });

    client.on('error', (error) => {
        const message = error && error.message ? error.message : String(error);
        handleDiscordRpcDrop(client, `Error: ${message}`);
    });

    try {
        await client.login({ clientId: DISCORD_RPC_CLIENT_ID });
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        handleDiscordRpcDrop(client, `Login failed: ${message}`);
    }
}

async function stopDiscordRpc() {
    if (discordRpcReconnectTimer) {
        clearTimeout(discordRpcReconnectTimer);
        discordRpcReconnectTimer = null;
    }

    const client = discordRpcClient;
    discordRpcClient = null;
    discordRpcReady = false;
    discordRpcConnecting = false;

    if (!client) return;

    try {
        if (typeof client.clearActivity === 'function') {
            await client.clearActivity();
        }
    } catch {
        // Ignore clear failures while shutting down.
    }

    destroyDiscordRpcClient(client);
}

function getUpdaterState() {
    return {
        ...updaterState
    };
}

function emitUpdaterState() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(UPDATE_CHANNEL_STATE, getUpdaterState());
}

function setUpdaterState(nextState = {}) {
    if (!nextState || typeof nextState !== 'object') return getUpdaterState();

    if (Object.prototype.hasOwnProperty.call(nextState, 'enabled')) {
        updaterState.enabled = Boolean(nextState.enabled);
    }
    if (typeof nextState.phase === 'string' && nextState.phase.trim()) {
        updaterState.phase = nextState.phase.trim().toLowerCase();
    }
    if (typeof nextState.message === 'string' && nextState.message.trim()) {
        updaterState.message = nextState.message.trim();
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'checking')) {
        updaterState.checking = Boolean(nextState.checking);
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'available')) {
        updaterState.available = Boolean(nextState.available);
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'downloading')) {
        updaterState.downloading = Boolean(nextState.downloading);
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'downloaded')) {
        updaterState.downloaded = Boolean(nextState.downloaded);
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'percent')) {
        const numericPercent = Number(nextState.percent);
        updaterState.percent = Number.isFinite(numericPercent)
            ? Math.max(0, Math.min(100, Math.round(numericPercent)))
            : null;
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'currentVersion')) {
        updaterState.currentVersion = String(nextState.currentVersion || app.getVersion());
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'releaseVersion')) {
        updaterState.releaseVersion = String(nextState.releaseVersion || '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'error')) {
        updaterState.error = String(nextState.error || '').trim();
    }

    emitUpdaterState();
    return getUpdaterState();
}

function getAutoUpdaterDisableReason() {
    if (!autoUpdater) {
        return 'Auto-updater dependency missing. Run npm install.';
    }
    if (process.platform !== 'win32') {
        return 'Auto-updates are currently enabled for packaged Windows builds only.';
    }
    if (!app.isPackaged) {
        return 'Auto-updates are disabled in development mode.';
    }
    return '';
}

async function promptRestartForDownloadedUpdate(versionText = '') {
    if (!win || win.isDestroyed()) return;
    const versionMessage = versionText ? `Version ${versionText} is ready to install.` : 'A new version is ready to install.';
    try {
        const result = await dialog.showMessageBox(win, {
            type: 'info',
            title: 'Update ready',
            message: versionMessage,
            detail: 'Restart now to apply the update.',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (result && result.response === 0 && autoUpdater) {
            setUpdaterState({
                phase: 'installing',
                message: 'Closing app to install update...'
            });
            autoUpdater.quitAndInstall(false, true);
        }
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.error('[Updater] Failed to prompt restart:', message);
    }
}

function registerAutoUpdaterEvents() {
    if (!autoUpdater || updaterListenersRegistered) return;
    updaterListenersRegistered = true;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => {
        setUpdaterState({
            phase: 'checking',
            message: 'Checking for updates...',
            checking: true,
            downloading: false,
            error: ''
        });
    });

    autoUpdater.on('update-available', (info = {}) => {
        const nextVersion = String(info && info.version ? info.version : '').trim();
        setUpdaterState({
            phase: 'downloading',
            message: nextVersion
                ? `Update ${nextVersion} found. Downloading...`
                : 'Update found. Downloading...',
            checking: false,
            available: true,
            downloading: true,
            downloaded: false,
            percent: 0,
            releaseVersion: nextVersion,
            error: ''
        });
    });

    autoUpdater.on('update-not-available', () => {
        setUpdaterState({
            phase: 'ready',
            message: 'You are on the latest version.',
            checking: false,
            available: false,
            downloading: false,
            downloaded: false,
            percent: 100,
            releaseVersion: '',
            error: ''
        });
    });

    autoUpdater.on('download-progress', (progress = {}) => {
        const percent = Number(progress && progress.percent);
        setUpdaterState({
            phase: 'downloading',
            message: 'Downloading update...',
            checking: false,
            available: true,
            downloading: true,
            downloaded: false,
            percent: Number.isFinite(percent) ? percent : updaterState.percent,
            error: ''
        });
    });

    autoUpdater.on('update-downloaded', (info = {}) => {
        const nextVersion = String(info && info.version ? info.version : '').trim();
        setUpdaterState({
            phase: 'ready',
            message: nextVersion
                ? `Update ${nextVersion} downloaded. Restart to install.`
                : 'Update downloaded. Restart to install.',
            checking: false,
            available: true,
            downloading: false,
            downloaded: true,
            percent: 100,
            releaseVersion: nextVersion,
            error: ''
        });
        void promptRestartForDownloadedUpdate(nextVersion);
    });

    autoUpdater.on('before-quit-for-update', () => {
        setUpdaterState({
            phase: 'installing',
            message: 'Applying update...'
        });
    });

    autoUpdater.on('error', (error) => {
        const message = error && error.message ? error.message : String(error);
        console.error('[Updater] Error:', message);
        setUpdaterState({
            phase: 'error',
            message: 'Update check failed.',
            checking: false,
            downloading: false,
            error: message
        });
    });
}

async function checkForAppUpdates(trigger = 'manual') {
    if (!autoUpdater || !updaterState.enabled) {
        return {
            ok: false,
            reason: 'updater-disabled',
            state: getUpdaterState()
        };
    }

    if (updaterState.checking) {
        return {
            ok: true,
            reason: 'already-checking',
            state: getUpdaterState()
        };
    }

    setUpdaterState({
        phase: 'checking',
        message: trigger === 'scheduled' ? 'Checking for updates (scheduled)...' : 'Checking for updates...',
        checking: true,
        error: ''
    });

    try {
        await autoUpdater.checkForUpdates();
        return {
            ok: true,
            state: getUpdaterState()
        };
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        setUpdaterState({
            phase: 'error',
            message: 'Update check failed.',
            checking: false,
            downloading: false,
            error: message
        });
        return {
            ok: false,
            reason: 'check-failed',
            error: message,
            state: getUpdaterState()
        };
    }
}

function startAutoUpdater() {
    const disableReason = getAutoUpdaterDisableReason();
    if (disableReason) {
        setUpdaterState({
            enabled: false,
            phase: 'idle',
            message: disableReason,
            checking: false,
            available: false,
            downloading: false,
            downloaded: false,
            percent: null,
            releaseVersion: '',
            error: ''
        });
        return;
    }

    setUpdaterState({
        enabled: true,
        phase: 'idle',
        message: 'Updater ready.',
        currentVersion: app.getVersion(),
        error: ''
    });

    registerAutoUpdaterEvents();
    void checkForAppUpdates('startup');

    if (updaterCheckTimer) {
        clearInterval(updaterCheckTimer);
    }
    updaterCheckTimer = setInterval(() => {
        void checkForAppUpdates('scheduled');
    }, UPDATE_CHECK_INTERVAL_MS);
}

function stopAutoUpdater() {
    if (updaterCheckTimer) {
        clearInterval(updaterCheckTimer);
        updaterCheckTimer = null;
    }
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
        extensionWss = new WebSocketServer({ host: '127.0.0.1', port: 8181 });
        extensionBridgeError = '';
        console.log('[Bridge] Listening on ws://127.0.0.1:8181');

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
    const WINDOW_WIDTH = 1000;
    const WINDOW_HEIGHT = 550;
    const MIN_WIDTH = 600;
    const MIN_HEIGHT = 510;

    // Use the .ico asset on Windows for proper taskbar/shell icon rendering.
    const iconPath = path.join(__dirname, process.platform === 'win32' ? 'voltus.ico' : 'icon.png');

    win = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        show: false,
        frame: false,
        roundedCorners: false,
        alwaysOnTop: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true
        },
        icon: iconPath
    });

    // Load your HTML file
    win.loadFile('index.html');

    // Remove the default menu bar
    Menu.setApplicationMenu(null);

    const revealWindow = () => {
        if (!win || win.isDestroyed()) return;
        win.center();
        win.show();
        win.webContents.send('startup:window-expanded');
    };

    win.webContents.on('did-finish-load', () => {
        emitBridgeStatus();
        emitUpdaterState();
        revealWindow();
    });
    

    //win.webContents.openDevTools();

    win.on('closed', () => {
        stopAllCmdSessions('window-closed');
        win = null;
    });
}

app.whenReady().then(() => {
    startExtensionBridge();
    void startDiscordRpc();
    createWindow();
    startAutoUpdater();
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

ipcMain.handle('updater:get-state', () => {
    return getUpdaterState();
});

ipcMain.handle('updater:check', async () => {
    return await checkForAppUpdates('manual');
});

ipcMain.handle('updater:quit-and-install', async () => {
    if (!autoUpdater || !updaterState.enabled) {
        return {
            ok: false,
            reason: 'updater-disabled',
            state: getUpdaterState()
        };
    }
    if (!updaterState.downloaded) {
        return {
            ok: false,
            reason: 'update-not-downloaded',
            state: getUpdaterState()
        };
    }

    setUpdaterState({
        phase: 'installing',
        message: 'Closing app to install update...'
    });

    setImmediate(() => {
        try {
            autoUpdater.quitAndInstall(false, true);
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setUpdaterState({
                phase: 'error',
                message: 'Could not start update install.',
                error: message
            });
        }
    });

    return {
        ok: true,
        state: getUpdaterState()
    };
});

ipcMain.handle('app:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !url.trim() || !isSafeExternalUrl(url)) return false;
    try {
        return await shell.openExternal(url);
    } catch (error) {
        console.error('[OpenExternal] Failed:', error && error.message ? error.message : String(error));
        return false;
    }
});

ipcMain.handle('discord-rpc:status', () => {
    return getDiscordRpcStatus();
});

ipcMain.handle('discord-rpc:update', async (_event, payload = {}) => {
    const sanitizedActivity = sanitizeDiscordRpcActivity(payload);
    discordRpcActivity = sanitizedActivity || buildDefaultDiscordRpcActivity();

    if (!DISCORD_RPC_CLIENT_ID) {
        return {
            ...getDiscordRpcStatus(),
            applied: false
        };
    }

    if (!discordRpcReady && !discordRpcConnecting) {
        void startDiscordRpc();
        return {
            ...getDiscordRpcStatus(),
            applied: false
        };
    }

    const applied = await applyDiscordRpcActivity();
    return {
        ...getDiscordRpcStatus(),
        applied
    };
});

ipcMain.handle('discord-rpc:clear', async () => {
    discordRpcActivity = null;
    const applied = await applyDiscordRpcActivity();
    return {
        ...getDiscordRpcStatus(),
        applied
    };
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

    assertRuntimeExecutionAllowed('python', cwd);

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
    const requestedShellRaw = options && typeof options.shell === 'string'
        ? options.shell.trim().toLowerCase()
        : '';
    assertRuntimeExecutionAllowed('shell', cwd);
    const attempts = (() => {
        if (process.platform !== 'win32') {
            return [
                { command: 'bash', args: ['-lc', script] },
                { command: 'sh', args: ['-lc', script] }
            ];
        }

        const windowsShells = {
            powershell: [
                { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] },
                { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
            ],
            pwsh: [
                { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', script] },
                { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] }
            ],
            cmd: [
                { command: 'cmd', args: ['/d', '/s', '/c', script] }
            ]
        };

        const aliases = {
            'command prompt': 'cmd',
            commandprompt: 'cmd',
            command_prompt: 'cmd',
            ps: 'powershell'
        };

        const normalizedShell = windowsShells[requestedShellRaw]
            ? requestedShellRaw
            : (windowsShells[aliases[requestedShellRaw]] ? aliases[requestedShellRaw] : '');

        if (normalizedShell) {
            return windowsShells[normalizedShell];
        }

        return [
            ...windowsShells.powershell,
            ...windowsShells.cmd
        ];
    })();

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

ipcMain.handle('runtime:cmd:start', async (event, options = {}) => {
    if (process.platform !== 'win32') {
        throw new Error('Persistent cmd terminal is only available on Windows.');
    }
    if (!nodePty || typeof nodePty.spawn !== 'function') {
        throw new Error('node-pty is not available. Reinstall dependencies and restart Voltus.');
    }

    const cwd = await resolveRuntimeCwd(options && options.cwd);
    assertRuntimeExecutionAllowed('shell', cwd);
    const colsRaw = Number(options && options.cols);
    const rowsRaw = Number(options && options.rows);
    const cols = Number.isFinite(colsRaw) ? Math.max(20, Math.min(500, Math.floor(colsRaw))) : 120;
    const rows = Number.isFinite(rowsRaw) ? Math.max(5, Math.min(400, Math.floor(rowsRaw))) : 30;
    const requestedSessionId = normalizeCmdSessionId(options && options.sessionId);
    const sessionId = requestedSessionId || createCmdSessionId();
    const shell = normalizePersistentShellType(options && options.shell);

    const existingSession = cmdSessions.get(sessionId);
    if (existingSession && existingSession.ptyProcess) {
        existingSession.sender = event.sender;
        return {
            ok: true,
            running: true,
            reused: true,
            sessionId,
            shell: normalizePersistentShellType(existingSession.shell),
            cwd: existingSession.cwd,
            pid: existingSession.ptyProcess.pid || null
        };
    }

    const shellAttempts = getPersistentShellLaunchAttempts(shell);
    let ptyProcess = null;
    let lastShellError = null;
    for (const attempt of shellAttempts) {
        try {
            ptyProcess = nodePty.spawn(attempt.command, attempt.args, {
                name: 'xterm-256color',
                cwd,
                cols,
                rows,
                env: process.env,
                useConpty: true
            });
            break;
        } catch (error) {
            lastShellError = error;
            const message = String(error && error.message ? error.message : error || '');
            const isNotFound = (error && error.code === 'ENOENT')
                || /not found/i.test(message)
                || /cannot find/i.test(message);
            if (!isNotFound) {
                throw error;
            }
        }
    }
    if (!ptyProcess) {
        throw lastShellError || new Error(`Could not start ${shell === 'pwr' ? 'PowerShell' : 'CMD'} session.`);
    }

    const session = {
        id: sessionId,
        shell,
        ptyProcess,
        sender: event.sender,
        cwd,
        stopping: false,
        stopReason: '',
        exitCode: null,
        signal: null
    };
    cmdSessions.set(sessionId, session);

    ptyProcess.onData((chunk) => {
        const current = cmdSessions.get(sessionId);
        if (!current || current.ptyProcess !== ptyProcess) return;
        emitCmdSessionTo(current.sender, CMD_CHANNEL_DATA, { sessionId, data: String(chunk || '') });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
        const current = cmdSessions.get(sessionId);
        if (!current || current.ptyProcess !== ptyProcess) return;
        const sender = current.sender;
        const reason = current.stopReason || 'exit';
        current.exitCode = typeof exitCode === 'number' ? exitCode : null;
        current.signal = typeof signal === 'number' ? String(signal) : (signal || null);
        const code = current.exitCode;
        const closeSignal = current.signal;
        cmdSessions.delete(sessionId);
        emitCmdSessionTo(sender, CMD_CHANNEL_EXIT, { sessionId, code, signal: closeSignal, reason });
    });

    return {
        ok: true,
        running: true,
        reused: false,
        sessionId,
        shell,
        cwd,
        pid: ptyProcess.pid || null
    };
});

ipcMain.handle('runtime:cmd:write', async (_event, payload = '') => {
    const payloadObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    const sessionId = normalizeCmdSessionId(payloadObject && payloadObject.sessionId);
    const input = payloadObject ? payloadObject.input : payload;
    const session = resolveCmdSessionForRequest(sessionId, true);
    if (!session || !session.ptyProcess) {
        throw new Error('cmd.exe session is not running.');
    }

    assertRuntimeExecutionAllowed('shell', session.cwd || process.cwd());
    const data = typeof input === 'string' ? input : String(input || '');
    if (!data) {
        return { ok: true, written: 0 };
    }

    session.ptyProcess.write(data);

    return {
        ok: true,
        sessionId: session.id,
        written: Buffer.byteLength(data)
    };
});

ipcMain.handle('runtime:cmd:stop', (_event, options = {}) => {
    const sessionId = normalizeCmdSessionId(options && options.sessionId);
    if (sessionId) {
        if (!cmdSessions.has(sessionId)) {
            return { ok: true, running: false, sessionId };
        }
        stopCmdSession(sessionId, 'requested');
        return { ok: true, running: false, sessionId };
    }
    if (!cmdSessions.size) {
        return { ok: true, running: false };
    }
    stopAllCmdSessions('requested');
    return { ok: true, running: false };
});

ipcMain.handle('runtime:cmd:status', (_event, options = {}) => {
    const requestedSessionId = normalizeCmdSessionId(options && options.sessionId);
    if (requestedSessionId) {
        const session = cmdSessions.get(requestedSessionId) || null;
        const running = Boolean(session && session.ptyProcess);
        return {
            ok: true,
            running,
            sessionId: requestedSessionId,
            shell: running ? normalizePersistentShellType(session.shell) : '',
            cwd: running ? session.cwd : '',
            pid: running ? (session.ptyProcess.pid || null) : null
        };
    }

    const sessions = [...cmdSessions.values()].map((session) => ({
        sessionId: session.id,
        shell: normalizePersistentShellType(session.shell),
        cwd: session.cwd,
        pid: session.ptyProcess ? (session.ptyProcess.pid || null) : null
    }));
    const primary = sessions[0] || null;
    const running = sessions.length > 0;
    return {
        ok: true,
        running,
        sessionId: primary ? primary.sessionId : '',
        shell: primary ? primary.shell : '',
        cwd: primary ? primary.cwd : '',
        pid: primary ? primary.pid : null,
        sessions
    };
});

ipcMain.handle('runtime:cmd:resize', (_event, options = {}) => {
    const sessionId = normalizeCmdSessionId(options && options.sessionId);
    const session = resolveCmdSessionForRequest(sessionId, false);
    if (!session || !session.ptyProcess) {
        return { ok: true, running: false };
    }
    const colsRaw = Number(options && options.cols);
    const rowsRaw = Number(options && options.rows);
    const cols = Number.isFinite(colsRaw) ? Math.max(20, Math.min(500, Math.floor(colsRaw))) : 120;
    const rows = Number.isFinite(rowsRaw) ? Math.max(5, Math.min(400, Math.floor(rowsRaw))) : 30;
    try {
        session.ptyProcess.resize(cols, rows);
    } catch {
        // Ignore resize errors; session continues running.
    }
    return {
        ok: true,
        running: true,
        sessionId: session.id,
        cols,
        rows
    };
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

ipcMain.handle('runtime:permissions:get', () => {
    return getRuntimePolicyState();
});

ipcMain.handle('runtime:permissions:set', (_event, options = {}) => {
    if (options && Object.prototype.hasOwnProperty.call(options, 'allowShell')) {
        runtimeExecutionPolicy.allowShell = Boolean(options.allowShell);
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'allowPython')) {
        runtimeExecutionPolicy.allowPython = Boolean(options.allowPython);
    }
    if (options && Object.prototype.hasOwnProperty.call(options, 'allowAnyCwd')) {
        runtimeExecutionPolicy.allowAnyCwd = Boolean(options.allowAnyCwd);
    }
    if (!runtimeExecutionPolicy.allowShell) {
        stopAllCmdSessions('permissions');
    }
    return getRuntimePolicyState();
});

ipcMain.handle('runtime:find-in-files', async (_event, options = {}) => {
    const query = String(options && options.query ? options.query : '').trim();
    if (!query) {
        return {
            ok: true,
            cwd: await resolveRuntimeCwd(options && options.cwd),
            query: '',
            results: []
        };
    }

    const cwd = await resolveRuntimeCwd((options && options.cwd) || (options && options.rootPath));
    if (!isAllowedRuntimeCwd(cwd)) {
        throw new Error('Search root is outside trusted workspace roots.');
    }

    const results = await searchInFiles(cwd, query, {
        useRegex: Boolean(options && options.useRegex),
        matchCase: Boolean(options && options.matchCase),
        wholeWord: Boolean(options && options.wholeWord),
        maxResults: options && options.maxResults,
        maxFiles: options && options.maxFiles,
        timeoutMs: options && options.timeoutMs
    });

    return {
        ok: true,
        cwd,
        query,
        results
    };
});

ipcMain.handle('runtime:replace-in-files', async (_event, options = {}) => {
    const query = String(options && options.query ? options.query : '');
    const replacement = String(options && Object.prototype.hasOwnProperty.call(options, 'replacement') ? options.replacement : '');
    const filePaths = Array.isArray(options && options.files)
        ? options.files.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const dryRun = Boolean(options && options.dryRun);

    if (!query.trim()) {
        throw new Error('Replace query is required.');
    }
    if (!filePaths.length) {
        throw new Error('No files were provided for replace operation.');
    }

    const regex = buildSearchRegex(query, {
        useRegex: Boolean(options && options.useRegex),
        wholeWord: Boolean(options && options.wholeWord),
        matchCase: Boolean(options && options.matchCase)
    });
    if (!regex) {
        throw new Error('Invalid search pattern.');
    }

    const updated = [];
    let touchedFiles = 0;
    let totalReplacements = 0;

    for (const filePath of filePaths) {
        const resolved = path.resolve(filePath);
        if (!isAllowedRuntimeCwd(resolved)) continue;

        const fileStat = await fs.stat(resolved).catch(() => null);
        if (!fileStat || !fileStat.isFile() || fileStat.size > SEARCH_MAX_FILE_BYTES) continue;

        const content = await fs.readFile(resolved, 'utf8').catch(() => null);
        if (typeof content !== 'string' || content.includes('\0')) continue;

        let count = 0;
        const nextContent = content.replace(regex, () => {
            count += 1;
            return replacement;
        });

        if (count <= 0 || nextContent === content) continue;
        touchedFiles += 1;
        totalReplacements += count;

        if (!dryRun) {
            await fs.writeFile(resolved, nextContent, 'utf8');
        }

        updated.push({
            path: resolved,
            replacements: count
        });
    }

    return {
        ok: true,
        dryRun,
        touchedFiles,
        totalReplacements,
        updated
    };
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

ipcMain.handle('runtime:git-branches', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const args = ['branch', '--all', '--verbose', '--no-color'];
    const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    const entries = String(result.stdout || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => String(line || '').trimEnd())
        .filter(Boolean)
        .map((line) => {
            const isActive = line.startsWith('*');
            const cleaned = line.replace(/^[* ]+/, '');
            const firstSpace = cleaned.search(/\s/);
            const name = firstSpace === -1 ? cleaned : cleaned.slice(0, firstSpace);
            const detail = firstSpace === -1 ? '' : cleaned.slice(firstSpace).trim();
            return {
                name,
                detail,
                isActive,
                isRemote: name.startsWith('remotes/')
            };
        });

    return {
        ok: result.exitCode === 0,
        cwd: result.cwd,
        entries,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
});

ipcMain.handle('runtime:git-checkout', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const branch = String(options && options.branch ? options.branch : '').trim();
    const create = Boolean(options && options.create);
    if (!branch) {
        throw new Error('Branch name is required.');
    }

    const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
    const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    return {
        ok: result.exitCode === 0,
        cwd: result.cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
});

ipcMain.handle('runtime:git-discard', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const paths = Array.isArray(options && options.paths)
        ? options.paths.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const args = paths.length > 0
        ? ['restore', '--worktree', '--', ...paths]
        : ['restore', '--worktree', '.'];

    try {
        const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
        return {
            ok: result.exitCode === 0,
            cwd: result.cwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
        };
    } catch (error) {
        const fallbackArgs = paths.length > 0
            ? ['checkout', '--', ...paths]
            : ['checkout', '--', '.'];
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

ipcMain.handle('runtime:git-pull', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const rebase = Boolean(options && options.rebase);
    const args = ['pull'];
    if (rebase) args.push('--rebase');
    const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    return {
        ok: result.exitCode === 0,
        cwd: result.cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
    };
});

ipcMain.handle('runtime:git-push', async (_event, options = {}) => {
    const cwdInput = typeof options === 'string' ? options : (options && options.cwd);
    const setUpstream = Boolean(options && options.setUpstream);
    const args = ['push'];
    if (setUpstream) args.push('--set-upstream', 'origin', 'HEAD');
    const result = await runGit(args, { cwd: cwdInput, timeoutMs: options && options.timeoutMs });
    return {
        ok: result.exitCode === 0,
        cwd: result.cwd,
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
    stopAutoUpdater();
    stopAllCmdSessions('app-quit');
    stopExtensionBridge();
    void stopDiscordRpc();
});
