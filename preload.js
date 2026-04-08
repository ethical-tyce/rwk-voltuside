const { contextBridge, ipcRenderer } = require('electron');
const { shell } = require('electron');

contextBridge.exposeInMainWorld('shell', {
    openExternal: (url) => shell.openExternal(url)
});

contextBridge.exposeInMainWorld('windowControls', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close'),
    getAlwaysOnTop: () => ipcRenderer.invoke('window:always-on-top:get'),
    setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:always-on-top:set', enabled)
});

contextBridge.exposeInMainWorld('extensionBridge', {
    send: (payload) => ipcRenderer.send('extension:send', payload),
    getStatus: () => ipcRenderer.invoke('extension:get-status'),
    onMessage: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const handler = (_event, message) => callback(message);
        ipcRenderer.on('extension:message', handler);
        return () => ipcRenderer.removeListener('extension:message', handler);
    },
    onStatus: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const handler = (_event, status) => callback(status);
        ipcRenderer.on('extension:status', handler);
        return () => ipcRenderer.removeListener('extension:status', handler);
    }
});

contextBridge.exposeInMainWorld('startupEvents', {
    onWindowExpanded: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const handler = () => callback();
        ipcRenderer.on('startup:window-expanded', handler);
        return () => ipcRenderer.removeListener('startup:window-expanded', handler);
    }
});

contextBridge.exposeInMainWorld('fileExplorer', {
    pickFolder: () => ipcRenderer.invoke('explorer:pick-folder'),
    closeFolder: (rootPath) => ipcRenderer.invoke('explorer:close-folder', rootPath),
    restoreFolder: (rootPath) => ipcRenderer.invoke('explorer:restore-folder', rootPath),
    readTree: (rootPath) => ipcRenderer.invoke('explorer:read-tree', rootPath),
    readFile: (filePath) => ipcRenderer.invoke('explorer:read-file', filePath),
    readImageDataUrl: (filePath) => ipcRenderer.invoke('explorer:read-image-data-url', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('explorer:write-file', filePath, content),
    createFile: (filePath, content) => ipcRenderer.invoke('explorer:create-file', filePath, content),
    createDirectory: (directoryPath) => ipcRenderer.invoke('explorer:create-directory', directoryPath),
    renamePath: (sourcePath, destinationPath) => ipcRenderer.invoke('explorer:rename-path', sourcePath, destinationPath),
    deletePath: (targetPath) => ipcRenderer.invoke('explorer:delete-path', targetPath)
});

// expose app version retrieval
contextBridge.exposeInMainWorld('appInfo', {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url)
});

contextBridge.exposeInMainWorld('autoUpdater', {
    getState: () => ipcRenderer.invoke('updater:get-state'),
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
    onStateChange: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const handler = (_event, state) => callback(state);
        ipcRenderer.on('updater:state', handler);
        return () => ipcRenderer.removeListener('updater:state', handler);
    }
});

contextBridge.exposeInMainWorld('discordRpc', {
    getStatus: () => ipcRenderer.invoke('discord-rpc:status'),
    updatePresence: (payload = {}) => ipcRenderer.invoke('discord-rpc:update', payload),
    clearPresence: () => ipcRenderer.invoke('discord-rpc:clear')
});

contextBridge.exposeInMainWorld('runtime', {
    runPython: (code, options = {}) => ipcRenderer.invoke('runtime:run-python', code, options),
    runShell: (command, options = {}) => ipcRenderer.invoke('runtime:run-shell', command, options),
    cmdStart: (options = {}) => ipcRenderer.invoke('runtime:cmd:start', options),
    cmdWrite: (inputOrOptions = '', options = {}) => {
        if (inputOrOptions && typeof inputOrOptions === 'object' && !Array.isArray(inputOrOptions)) {
            return ipcRenderer.invoke('runtime:cmd:write', inputOrOptions);
        }
        return ipcRenderer.invoke('runtime:cmd:write', {
            input: typeof inputOrOptions === 'string' ? inputOrOptions : String(inputOrOptions || ''),
            sessionId: options && options.sessionId ? String(options.sessionId) : ''
        });
    },
    cmdStop: (options = {}) => ipcRenderer.invoke('runtime:cmd:stop', options),
    cmdStatus: (options = {}) => ipcRenderer.invoke('runtime:cmd:status', options),
    cmdResize: (options = {}) => ipcRenderer.invoke('runtime:cmd:resize', options),
    onCmdData: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('runtime:cmd:data', handler);
        return () => ipcRenderer.removeListener('runtime:cmd:data', handler);
    },
    onCmdExit: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on('runtime:cmd:exit', handler);
        return () => ipcRenderer.removeListener('runtime:cmd:exit', handler);
    },
    getPermissions: () => ipcRenderer.invoke('runtime:permissions:get'),
    setPermissions: (options = {}) => ipcRenderer.invoke('runtime:permissions:set', options),
    findInFiles: (options = {}) => ipcRenderer.invoke('runtime:find-in-files', options),
    replaceInFiles: (options = {}) => ipcRenderer.invoke('runtime:replace-in-files', options),
    gitStatus: (options = {}) => ipcRenderer.invoke('runtime:git-status', options),
    gitDiff: (options = {}) => ipcRenderer.invoke('runtime:git-diff', options),
    gitStage: (options = {}) => ipcRenderer.invoke('runtime:git-stage', options),
    gitUnstage: (options = {}) => ipcRenderer.invoke('runtime:git-unstage', options),
    gitCommit: (options = {}) => ipcRenderer.invoke('runtime:git-commit', options),
    gitLog: (options = {}) => ipcRenderer.invoke('runtime:git-log', options),
    gitBranches: (options = {}) => ipcRenderer.invoke('runtime:git-branches', options),
    gitCheckout: (options = {}) => ipcRenderer.invoke('runtime:git-checkout', options),
    gitDiscard: (options = {}) => ipcRenderer.invoke('runtime:git-discard', options),
    gitPull: (options = {}) => ipcRenderer.invoke('runtime:git-pull', options),
    gitPush: (options = {}) => ipcRenderer.invoke('runtime:git-push', options),
    openDevTools: () => ipcRenderer.invoke('runtime:open-devtools')
});
