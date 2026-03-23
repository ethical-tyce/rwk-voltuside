(() => {
    'use strict';

    function wrapSingleFlightAsync(name) {
        const original = window[name];
        if (typeof original !== 'function' || original.__voltusSingleFlightWrapped) return;

        let inFlight = null;
        const wrapped = async function wrappedSingleFlight(...args) {
            if (inFlight) {
                return inFlight;
            }
            inFlight = Promise.resolve().then(() => original.apply(this, args));
            try {
                return await inFlight;
            } finally {
                inFlight = null;
            }
        };
        wrapped.__voltusSingleFlightWrapped = true;
        window[name] = wrapped;
    }

    function wrapButtonBusyState(buttonId, labelWhileBusy) {
        const button = document.getElementById(buttonId);
        if (!button || typeof button.onclick !== 'function') return;
        if (button.__voltusBusyWrapped) return;
        const original = button.onclick;
        const stableMarkup = button.innerHTML;
        const hasIcon = Boolean(button.querySelector('svg'));

        button.onclick = async function wrappedButtonHandler(event) {
            if (button.disabled) return;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            if (labelWhileBusy && !hasIcon) {
                button.textContent = labelWhileBusy;
            }
            try {
                return await original.call(this, event);
            } finally {
                button.disabled = false;
                button.removeAttribute('aria-busy');
                if (labelWhileBusy && !hasIcon) {
                    button.innerHTML = stableMarkup;
                }
            }
        };
        button.__voltusBusyWrapped = true;
    }

    function polishConsoleClearFeedback() {
        const clearBtn = document.getElementById('clearConsole');
        const outputEl = document.getElementById('console');
        if (!clearBtn || !outputEl) return;

        clearBtn.addEventListener('click', () => {
            const before = outputEl.childElementCount;
            window.setTimeout(() => {
                const after = outputEl.childElementCount;
                if (before > 0 && after === 0 && typeof window.showToast === 'function') {
                    window.showToast(`Cleared ${before} console entr${before === 1 ? 'y' : 'ies'}`);
                }
            }, 0);
        }, true);
    }

    function polishTerminalTabFocus() {
        if (typeof window.setConsoleTab !== 'function') return;
        const original = window.setConsoleTab;
        if (original.__voltusTerminalFocusWrapped) return;
        window.setConsoleTab = function setConsoleTabWithFocus(tabName) {
            const result = original.call(this, tabName);
            if (String(tabName || '').toLowerCase() === 'terminal') {
                const input = document.getElementById('consoleTerminalInput');
                if (input) {
                    window.requestAnimationFrame(() => input.focus());
                }
            }
            return result;
        };
        window.setConsoleTab.__voltusTerminalFocusWrapped = true;
    }

    function polishBridgeStatusHints() {
        const bridgeEl = document.getElementById('statusBridge');
        if (!bridgeEl) return;

        const syncTitle = () => {
            const isOnline = String(bridgeEl.textContent || '').toLowerCase().includes('online');
            bridgeEl.title = isOnline
                ? 'Browser extension bridge connected.'
                : 'Browser extension bridge offline. Open the extension to connect.';
        };

        syncTitle();
        const observer = new MutationObserver(syncTitle);
        observer.observe(bridgeEl, { childList: true, subtree: true, characterData: true });
    }

    function init() {
        wrapSingleFlightAsync('refreshExplorerTree');
        wrapButtonBusyState('execute', 'Running...');
        wrapButtonBusyState('save', 'Saving...');
        polishConsoleClearFeedback();
        polishTerminalTabFocus();
        polishBridgeStatusHints();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
