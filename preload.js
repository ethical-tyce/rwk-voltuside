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

// expose app version retrieval
contextBridge.exposeInMainWorld('appInfo', {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url)
});
