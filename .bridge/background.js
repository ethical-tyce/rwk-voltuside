let socket = null;

// This function handles the connection logic
function connect() {
    if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return; // Already trying to connect or connected
    }

    socket = new WebSocket("ws://127.0.0.1:8181");

    socket.onopen = () => {
        console.log("✅ IDE Connected");
    };

    socket.onmessage = (event) => {
    const request = JSON.parse(event.data);

    // Case 1: IDE is asking for the list of open tabs
    if (request.type === "GET_TABS") {
        chrome.tabs.query({}, (tabs) => {
            const tabList = tabs.map(t => ({
                id: t.id,
                title: t.title || "New Tab",
                url: t.url,
                active: t.active
            }));
            socket.send(JSON.stringify({ type: "TAB_LIST", data: tabList }));
        });
    }

    // Case 2: IDE is sending code to execute
    if (request.type === "EXECUTE") {
        const { code, target, tabIds } = request;

        let queryOptions = {};
        if (target === "active") queryOptions = { active: true, currentWindow: true };
        else if (target === "all") queryOptions = {}; // All tabs
        else if (target === "selected") {
            // Execute only on specific IDs provided by the checkbox list
            tabIds.forEach(id => inject(id, code));
            return;
        }

        chrome.tabs.query(queryOptions, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url.startsWith('http')) {
                    inject(tab.id, code);
                }
            });
        });
    }
};

function inject(tabId, code) {
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: (c) => { (0, eval)(c); },
        args: [code]
    }).catch(err => console.error(`Injection failed on tab ${tabId}:`, err));
}

    socket.onclose = () => {
        console.log("❌ IDE Disconnected. Retrying...");
        socket = null;
        setTimeout(connect, 2000); // Try to reconnect every 2 seconds
    };

    socket.onerror = (err) => {
        console.error("Socket Error");
        socket.close();
    };
}

// --- KEEP ALIVE LOGIC ---

// 1. Try to connect immediately on startup
connect();

// 2. Create an alarm to wake up the service worker every 1 minute
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAlive') {
        console.log("⏰ Heartbeat: Keeping Service Worker Awake");
        connect(); // Ensure we are still connected
    }
});

// 3. Wake up when the user switches tabs or updates a page
chrome.tabs.onActivated.addListener(connect);
chrome.tabs.onUpdated.addListener(connect);