(() => {
    'use strict';

    const perfStore = window.VoltusPerf || {
        budgets: {
            startupRevealMs: 2400,
            explorerRefreshMs: 220,
            pickerRenderMs: 28
        },
        metrics: {}
    };
    window.VoltusPerf = perfStore;

    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

    function reportBudget(name, durationMs, budgetMs, detail = '') {
        const metric = {
            durationMs: Number(durationMs.toFixed(2)),
            budgetMs,
            detail,
            exceeded: durationMs > budgetMs,
            at: Date.now()
        };
        perfStore.metrics[name] = metric;
        if (!metric.exceeded) return;
        if (typeof window.pushConsole === 'function') {
            const suffix = detail ? ` (${detail})` : '';
            window.pushConsole('warn', `[perf] ${name} ${metric.durationMs}ms > ${budgetMs}ms${suffix}`);
        }
    }

    function wrapAsync(name, budgetMs, detailResolver = null) {
        const original = window[name];
        if (typeof original !== 'function') return;
        if (original.__voltusPerfWrapped) return;
        const wrapped = async function wrappedPerfTracked(...args) {
            const start = now();
            try {
                return await original.apply(this, args);
            } finally {
                const detail = typeof detailResolver === 'function' ? detailResolver(args) : '';
                reportBudget(name, now() - start, budgetMs, detail);
            }
        };
        wrapped.__voltusPerfWrapped = true;
        window[name] = wrapped;
    }

    function wrapSync(name, budgetMs, detailResolver = null) {
        const original = window[name];
        if (typeof original !== 'function') return;
        if (original.__voltusPerfWrapped) return;
        const wrapped = function wrappedPerfTracked(...args) {
            const start = now();
            try {
                return original.apply(this, args);
            } finally {
                const detail = typeof detailResolver === 'function' ? detailResolver(args) : '';
                reportBudget(name, now() - start, budgetMs, detail);
            }
        };
        wrapped.__voltusPerfWrapped = true;
        window[name] = wrapped;
    }

    function monitorStartupReveal() {
        const start = now();
        const body = document.body;
        if (!body) return;

        const evaluate = () => {
            const done = !body.classList.contains('startup-active');
            if (!done) return false;
            reportBudget('startupReveal', now() - start, perfStore.budgets.startupRevealMs);
            return true;
        };

        if (evaluate()) return;

        const observer = new MutationObserver(() => {
            if (!evaluate()) return;
            observer.disconnect();
        });
        observer.observe(body, { attributes: true, attributeFilter: ['class'] });
    }

    function init() {
        monitorStartupReveal();
        wrapAsync('refreshExplorerTree', perfStore.budgets.explorerRefreshMs, () => {
            const root = String(window.explorerRootPath || '').trim();
            return root ? root : 'no-root';
        });
        wrapSync('renderPickerListItems', perfStore.budgets.pickerRenderMs, (args) => {
            const items = Array.isArray(args && args[1]) ? args[1] : [];
            return `${items.length} item(s)`;
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
