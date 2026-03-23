(() => {
    'use strict';

    const lifecycle = window.VoltusLifecycle || {
        listeners: [],
        on(target, eventName, handler, options) {
            if (!target || typeof target.addEventListener !== 'function') return () => { };
            target.addEventListener(eventName, handler, options);
            const off = () => target.removeEventListener(eventName, handler, options);
            this.listeners.push(off);
            return off;
        },
        offAll() {
            while (this.listeners.length) {
                const off = this.listeners.pop();
                try { off(); } catch { }
            }
        }
    };
    window.VoltusLifecycle = lifecycle;

    function ensureInteractiveRoles() {
        const interactiveRows = Array.from(document.querySelectorAll('.sidebar-tab, .settings-toggle'));
        interactiveRows.forEach((el) => {
            if (!el) return;
            if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
            if (!el.hasAttribute('role')) el.setAttribute('role', 'button');

            if (el.classList.contains('settings-toggle')) {
                const syncPressed = () => el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
                syncPressed();
                const observer = new MutationObserver(syncPressed);
                observer.observe(el, { attributes: true, attributeFilter: ['class'] });
            }
        });
    }

    function enableKeyboardActivation() {
        lifecycle.on(document, 'keydown', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;
            const trigger = target.closest('.sidebar-tab, .settings-toggle');
            if (!trigger) return;
            const key = String(event.key || '');
            if (key !== 'Enter' && key !== ' ') return;
            event.preventDefault();
            trigger.click();
        }, true);
    }

    function normalizeAriaLabels() {
        const items = Array.from(document.querySelectorAll('button[title], .sidebar-tab[title], .icon-btn[title], .status-action-btn[title]'));
        items.forEach((el) => {
            if (!el.getAttribute('aria-label')) {
                const title = String(el.getAttribute('title') || '').trim();
                if (title) {
                    el.setAttribute('aria-label', title);
                }
            }
        });
    }

    function installTooltipSystem() {
        const tooltipEl = document.getElementById('voltusTooltip');
        if (!tooltipEl) return;

        const resolveTooltipText = (el) => {
            if (!el) return '';
            const explicit = String(el.getAttribute('data-voltus-tooltip') || '').trim();
            if (explicit) return explicit;
            const title = String(el.getAttribute('title') || '').trim();
            if (title) {
                el.setAttribute('data-voltus-tooltip', title);
                return title;
            }
            return '';
        };

        const positionTooltip = (target) => {
            const rect = target.getBoundingClientRect();
            const tooltipRect = tooltipEl.getBoundingClientRect();
            const gap = 10;
            const left = Math.min(
                window.innerWidth - tooltipRect.width - 8,
                Math.max(8, rect.left + (rect.width / 2) - (tooltipRect.width / 2))
            );
            const top = Math.max(8, rect.top - tooltipRect.height - gap);
            tooltipEl.style.left = `${Math.round(left)}px`;
            tooltipEl.style.top = `${Math.round(top)}px`;
        };

        const showTooltip = (el) => {
            const text = resolveTooltipText(el);
            if (!text) return;
            tooltipEl.textContent = text;
            tooltipEl.classList.add('visible');
            tooltipEl.setAttribute('aria-hidden', 'false');
            positionTooltip(el);
        };

        const hideTooltip = () => {
            tooltipEl.classList.remove('visible');
            tooltipEl.setAttribute('aria-hidden', 'true');
        };

        lifecycle.on(document, 'mouseover', (event) => {
            const target = event.target instanceof Element
                ? event.target.closest('button[title], .sidebar-tab[title], .status-action-btn[title], [data-voltus-tooltip]')
                : null;
            if (!target) return;
            showTooltip(target);
        }, true);

        lifecycle.on(document, 'mouseout', (event) => {
            const target = event.target instanceof Element
                ? event.target.closest('button[title], .sidebar-tab[title], .status-action-btn[title], [data-voltus-tooltip]')
                : null;
            if (!target) return;
            hideTooltip();
        }, true);

        lifecycle.on(document, 'focusin', (event) => {
            const target = event.target instanceof Element
                ? event.target.closest('button[title], .sidebar-tab[title], .status-action-btn[title], [data-voltus-tooltip]')
                : null;
            if (!target) return;
            showTooltip(target);
        }, true);

        lifecycle.on(document, 'focusout', hideTooltip, true);
        lifecycle.on(window, 'scroll', hideTooltip, true);
        lifecycle.on(window, 'resize', hideTooltip, true);
    }

    function extendCommandPaletteActions() {
        if (typeof window.buildCommandPaletteActions !== 'function') return;
        const original = window.buildCommandPaletteActions;
        window.buildCommandPaletteActions = function buildCommandPaletteActionsWithPolish() {
            const base = Array.isArray(original()) ? original() : [];
            const additions = [
                {
                    title: 'View: Toggle Console Output/Terminal',
                    detail: 'Switch between runtime output and terminal',
                    meta: '',
                    run: () => (typeof window.setConsoleTab === 'function' ? window.setConsoleTab('terminal') : null)
                },
                {
                    title: 'Explorer: Close Workspace',
                    detail: 'Detach current root folder',
                    meta: '',
                    run: () => {
                        if (typeof window.closeExplorerFolder === 'function') {
                            return window.closeExplorerFolder();
                        }
                        return null;
                    }
                },
                {
                    title: 'Console: Clear',
                    detail: 'Clear runtime output log',
                    meta: '',
                    run: () => document.getElementById('clearConsole')?.click()
                }
            ];

            additions.forEach((candidate) => {
                if (!base.some((entry) => entry && entry.title === candidate.title)) {
                    base.push(candidate);
                }
            });
            return base;
        };
    }

    function init() {
        ensureInteractiveRoles();
        enableKeyboardActivation();
        normalizeAriaLabels();
        installTooltipSystem();
        extendCommandPaletteActions();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
