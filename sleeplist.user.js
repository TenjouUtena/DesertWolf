// ==UserScript==
// @name         Mucklet Sleeper Filter
// @namespace    https://mucklet.com/
// @version      1.0.0
// @description  Adds a toggle to split sleepers (asleep & highly idle characters) into a separate collapsible section in the room panel. Based on mucklet-client PR #457.
// @author       Kredden
// @match        https://mucklet.com/*
// @match        https://*.mucklet.com/*
// @match        https://*.wolfery.com/*
// @match        https://wolfery.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // Configuration
    // =========================================================================
    const CONFIG = {
        // How often to scan for room panel changes (ms)
        scanInterval: 1500,
        // Persist toggle state across sessions
        storageKey: 'mucklet_sleeper_split',
        // Persist sleepers section open/closed state
        sleepersOpenKey: 'mucklet_sleepers_open',
        // Debug logging
        debug: false,
    };

    function log(...args) {
        if (CONFIG.debug) console.log('[MuckletSleeperFilter]', ...args);
    }

    // =========================================================================
    // State
    // =========================================================================
    let splitEnabled = GM_getValue(CONFIG.storageKey, false);
    let sleepersOpen = GM_getValue(CONFIG.sleepersOpenKey, false);
    let lastRoomPanel = null;
    let observer = null;

    // =========================================================================
    // Styles
    // =========================================================================
    GM_addStyle(`
        /* Toggle container */
        .msf-toggle-container {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 12px 4px 12px;
            font-size: 12px;
            opacity: 0.8;
            cursor: pointer;
            user-select: none;
        }
        .msf-toggle-container:hover {
            opacity: 1;
        }

        /* Custom toggle switch */
        .msf-toggle-switch {
            position: relative;
            width: 32px;
            height: 18px;
            background: rgba(255,255,255,0.15);
            border-radius: 9px;
            transition: background 0.2s;
            flex-shrink: 0;
        }
        .msf-toggle-switch.active {
            background: rgba(100, 180, 255, 0.5);
        }
        .msf-toggle-switch::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 14px;
            height: 14px;
            background: rgba(255,255,255,0.7);
            border-radius: 50%;
            transition: transform 0.2s;
        }
        .msf-toggle-switch.active::after {
            transform: translateX(14px);
            background: rgba(150, 210, 255, 1);
        }

        .msf-toggle-label {
            color: inherit;
            font-size: 12px;
        }

        /* Sleepers section */
        .msf-sleepers-section {
            border-top: 1px solid rgba(255,255,255,0.08);
        }

        .msf-sleepers-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 12px;
            cursor: pointer;
            user-select: none;
            opacity: 0.7;
            font-size: 13px;
        }
        .msf-sleepers-header:hover {
            opacity: 1;
        }

        .msf-sleepers-arrow {
            font-size: 10px;
            transition: transform 0.2s;
            display: inline-block;
        }
        .msf-sleepers-arrow.open {
            transform: rotate(90deg);
        }

        .msf-sleepers-list {
            overflow: hidden;
            transition: max-height 0.3s ease;
        }
        .msf-sleepers-list.collapsed {
            max-height: 0 !important;
        }

        .msf-sleepers-count {
            opacity: 0.5;
            font-size: 11px;
        }

        .msf-hidden-char {
            display: none !important;
        }

        .msf-no-awake-placeholder,
        .msf-no-sleepers-placeholder {
            padding: 6px 16px;
            font-size: 12px;
            opacity: 0.4;
            font-style: italic;
        }
    `);

    // =========================================================================
    // Character state detection
    //
    // The Mucklet client renders character items in the room panel. Each char
    // element (or a descendant) is tagged with a CSS class reflecting its state:
    //   - "common--level-asleep"   → disconnected / sleeping characters
    //   - "common--level-inactive" → idle level 3 (away / "red names")
    //
    // Both of these map to what the PR calls "sleepers":
    //   ch.state === 'asleep' || ch.idle === 3
    // =========================================================================

    /**
     * Determines if a character element represents a sleeping or highly idle character.
     * Checks the element itself and any descendants for the Mucklet client's
     * level-indicator CSS classes.
     */
    function isSleeperChar(charEl) {
        // Check the element itself
        if (charEl.classList.contains('common--level-asleep') ||
            charEl.classList.contains('common--level-inactive')) {
            return true;
        }

        // Check descendants – the level class is typically on the char's
        // name element or a small status-indicator span inside the row
        if (charEl.querySelector('.common--level-asleep, .common--level-inactive')) {
            return true;
        }

        return false;
    }

    // =========================================================================
    // DOM Manipulation
    // =========================================================================

    /**
     * Find the "In room" panel section in the room page.
     * The Mucklet client renders the room panel with PanelSection components
     * that have h3 headers.
     */
    function findInRoomSection() {
        // Look for h3 elements containing "In room" text
        const headers = document.querySelectorAll('h3');
        for (const h3 of headers) {
            if (h3.textContent.trim().toLowerCase() === 'in room') {
                // Walk up to find the panel section container
                let section = h3.closest('.panelsection') ||
                              h3.closest('[class*="panelsection"]') ||
                              h3.closest('[class*="panel-section"]');

                // If no class-based match, walk up a few levels
                if (!section) {
                    section = h3.parentElement?.parentElement?.parentElement;
                }
                return { header: h3, section };
            }
        }
        return null;
    }

    /**
     * Find the exits section for filtering transparent exit chars
     */
    function findExitsSection() {
        const headers = document.querySelectorAll('h3');
        for (const h3 of headers) {
            const txt = h3.textContent.trim().toLowerCase();
            if (txt === 'exits' || txt === 'ways out') {
                let section = h3.closest('.panelsection') ||
                              h3.closest('[class*="panelsection"]') ||
                              h3.closest('[class*="panel-section"]');
                if (!section) {
                    section = h3.parentElement?.parentElement?.parentElement;
                }
                return { header: h3, section };
            }
        }
        return null;
    }

    /**
     * Get character elements from a section.
     * Characters are typically rendered as list items or repeated component elements.
     */
    function getCharElements(section) {
        if (!section) return [];

        // The Mucklet client renders chars in a collection list
        // Each char is typically a div with char-specific classes
        const candidates = section.querySelectorAll(
            '[class*="pageroomchar"], [class*="pageroom-char"], [class*="char--"], ' +
            '[class*="collectionlist"] > *, [class*="collection-list"] > *'
        );

        if (candidates.length > 0) {
            return Array.from(candidates);
        }

        // Fallback: Look for the char list container and get direct children
        // The "In room" section content typically has a wrapper with char items
        const listContainers = section.querySelectorAll(
            '[class*="charlist"], [class*="chars"], [class*="collection"]'
        );
        for (const container of listContainers) {
            const items = container.children;
            if (items.length > 0) {
                return Array.from(items);
            }
        }

        // Last resort: look for any repeated similar elements that look like char entries
        // (elements with avatars/images inside the section's content area)
        const contentArea = section.querySelector('[class*="content"], [class*="body"]') || section;
        const withAvatars = contentArea.querySelectorAll(':scope > * > [class*="avatar"], :scope > * > img');
        if (withAvatars.length > 0) {
            return Array.from(withAvatars).map(av => av.parentElement);
        }

        return [];
    }

    /**
     * Get character elements from exit rooms (transparent exits)
     */
    function getExitCharElements() {
        // Exit chars are rendered differently - as small avatar grids
        // Look for exit room containers with char avatars
        const exitChars = document.querySelectorAll(
            '[class*="pageroomexitchar"], [class*="exitchar"], [class*="exit-char"]'
        );
        return Array.from(exitChars);
    }

    // =========================================================================
    // UI Components
    // =========================================================================

    /**
     * Create the toggle switch element
     */
    function createToggle() {
        const container = document.createElement('div');
        container.className = 'msf-toggle-container';
        container.title = 'Filter the list to separate asleep and highly idle characters (away/idle level 3)';

        const toggle = document.createElement('div');
        toggle.className = 'msf-toggle-switch' + (splitEnabled ? ' active' : '');

        const label = document.createElement('span');
        label.className = 'msf-toggle-label';
        label.textContent = 'Hide sleepers (split)';

        container.appendChild(toggle);
        container.appendChild(label);

        container.addEventListener('click', () => {
            splitEnabled = !splitEnabled;
            GM_setValue(CONFIG.storageKey, splitEnabled);
            toggle.classList.toggle('active', splitEnabled);
            applyFilter();
        });

        return container;
    }

    /**
     * Create the sleepers section
     */
    function createSleepersSection(sleeperElements) {
        const section = document.createElement('div');
        section.className = 'msf-sleepers-section';
        section.id = 'msf-sleepers-section';

        // Header
        const header = document.createElement('div');
        header.className = 'msf-sleepers-header';

        const arrow = document.createElement('span');
        arrow.className = 'msf-sleepers-arrow' + (sleepersOpen ? ' open' : '');
        arrow.textContent = '►';

        const title = document.createElement('span');
        title.textContent = 'Sleepers';

        const count = document.createElement('span');
        count.className = 'msf-sleepers-count';
        count.textContent = `(${sleeperElements.length})`;

        header.appendChild(arrow);
        header.appendChild(title);
        header.appendChild(count);

        header.addEventListener('click', () => {
            sleepersOpen = !sleepersOpen;
            GM_setValue(CONFIG.sleepersOpenKey, sleepersOpen);
            arrow.classList.toggle('open', sleepersOpen);
            list.classList.toggle('collapsed', !sleepersOpen);
            if (sleepersOpen) {
                list.style.maxHeight = list.scrollHeight + 'px';
            }
        });

        // List container
        const list = document.createElement('div');
        list.className = 'msf-sleepers-list' + (sleepersOpen ? '' : ' collapsed');

        if (sleeperElements.length === 0) {
            const placeholder = document.createElement('div');
            placeholder.className = 'msf-no-sleepers-placeholder';
            placeholder.textContent = 'No sleepers in room.';
            list.appendChild(placeholder);
        } else {
            // Clone sleeper elements into this section
            for (const el of sleeperElements) {
                const clone = el.cloneNode(true);
                clone.classList.remove('msf-hidden-char');
                // Copy event listeners won't transfer with cloneNode,
                // but clicks on char names should still work via event delegation
                // if the client uses data attributes for navigation
                list.appendChild(clone);
            }
        }

        section.appendChild(header);
        section.appendChild(list);

        // Set initial max-height for animation
        if (sleepersOpen) {
            requestAnimationFrame(() => {
                list.style.maxHeight = list.scrollHeight + 'px';
            });
        }

        return section;
    }

    // =========================================================================
    // Main Filter Logic
    // =========================================================================

    function applyFilter() {
        const inRoom = findInRoomSection();
        if (!inRoom) {
            log('Could not find "In room" section');
            return;
        }

        const { section } = inRoom;

        // Remove any existing sleepers section we created
        const existingSleepersSection = document.getElementById('msf-sleepers-section');
        if (existingSleepersSection) {
            existingSleepersSection.remove();
        }

        // Remove any existing toggle we created
        const existingToggle = section.querySelector('.msf-toggle-container');

        // Get all character elements
        const charElements = getCharElements(section);
        log(`Found ${charElements.length} character elements`);

        // Reset all chars to visible first
        for (const el of charElements) {
            el.classList.remove('msf-hidden-char');
        }

        // Remove any "no awake" placeholder we might have added
        const existingPlaceholder = section.querySelector('.msf-no-awake-placeholder');
        if (existingPlaceholder) existingPlaceholder.remove();

        if (!splitEnabled) {
            // Not splitting - just make sure toggle exists
            if (!existingToggle) {
                // Insert toggle before the "In room" header
                const headerEl = inRoom.header.closest('[class*="header"]') || inRoom.header.parentElement;
                if (headerEl && headerEl.parentElement) {
                    headerEl.parentElement.insertBefore(createToggle(), headerEl);
                }
            }
            return;
        }

        // Splitting is enabled - categorize characters
        const sleepers = [];
        const awake = [];

        for (const el of charElements) {
            if (isSleeperChar(el)) {
                sleepers.push(el);
                el.classList.add('msf-hidden-char');
            } else {
                awake.push(el);
            }
        }

        log(`Awake: ${awake.length}, Sleepers: ${sleepers.length}`);

        // Add "no one awake" placeholder if needed
        if (awake.length === 0 && charElements.length > 0) {
            const charContainer = charElements[0].parentElement;
            if (charContainer) {
                const placeholder = document.createElement('div');
                placeholder.className = 'msf-no-awake-placeholder';
                placeholder.textContent = 'No one awake in room.';
                charContainer.appendChild(placeholder);
            }
        }

        // Ensure toggle exists
        if (!existingToggle) {
            const headerEl = inRoom.header.closest('[class*="header"]') || inRoom.header.parentElement;
            if (headerEl && headerEl.parentElement) {
                headerEl.parentElement.insertBefore(createToggle(), headerEl);
            }
        }

        // Create sleepers section after the "In room" section
        const sleepersSection = createSleepersSection(sleepers);
        if (section.nextSibling) {
            section.parentElement.insertBefore(sleepersSection, section.nextSibling);
        } else {
            section.parentElement.appendChild(sleepersSection);
        }

        // Also filter exit chars (transparent exits - hide idle level 3)
        filterExitChars();
    }

    /**
     * Filter characters in transparent exit displays
     * The PR also filters out idle level 3 chars from exit room character grids
     */
    function filterExitChars() {
        if (!splitEnabled) {
            // Unhide all exit chars
            const hidden = document.querySelectorAll('.msf-hidden-char');
            hidden.forEach(el => el.classList.remove('msf-hidden-char'));
            return;
        }

        const exitChars = getExitCharElements();
        for (const el of exitChars) {
            if (isSleeperChar(el)) {
                el.classList.add('msf-hidden-char');
            }
        }
    }

    // =========================================================================
    // Observation & Initialization
    // =========================================================================

    /**
     * Set up a MutationObserver to watch for room panel changes
     */
    function setupObserver() {
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver((mutations) => {
            // Debounce - only reapply if relevant DOM changes occurred
            let shouldReapply = false;
            for (const mutation of mutations) {
                // Check if the mutation is in a relevant area
                const target = mutation.target;
                if (target && (
                    target.className?.toString().includes('pageroom') ||
                    target.className?.toString().includes('char') ||
                    target.className?.toString().includes('collection') ||
                    target.className?.toString().includes('panel') ||
                    target.className?.toString().includes('fader') ||
                    mutation.addedNodes.length > 0
                )) {
                    shouldReapply = true;
                    break;
                }
            }

            if (shouldReapply) {
                // Use a small delay to batch rapid mutations
                clearTimeout(setupObserver._timeout);
                setupObserver._timeout = setTimeout(() => {
                    applyFilter();
                }, 200);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'data-state', 'data-idle'],
        });
    }

    /**
     * Periodic scan as a safety net for cases the observer misses
     */
    function startPeriodicScan() {
        setInterval(() => {
            const inRoom = findInRoomSection();
            if (inRoom) {
                // Check if the room panel has changed (different section element)
                if (inRoom.section !== lastRoomPanel) {
                    lastRoomPanel = inRoom.section;
                    applyFilter();
                }

                // Also check if toggle needs to be re-inserted
                // (can happen if the client re-renders the section)
                const hasToggle = inRoom.section.querySelector('.msf-toggle-container') ||
                                  inRoom.section.previousElementSibling?.classList?.contains('msf-toggle-container');
                if (!hasToggle) {
                    applyFilter();
                }
            }
        }, CONFIG.scanInterval);
    }

    /**
     * Wait for the app to load, then initialize
     */
    function init() {
        log('Initializing Mucklet Sleeper Filter');

        // Wait for the page to have meaningful content
        const waitForApp = setInterval(() => {
            // Look for signs the Mucklet client has loaded
            const appRoot = document.querySelector('#app, [class*="main"], [class*="layout"]');
            if (appRoot && appRoot.children.length > 0) {
                clearInterval(waitForApp);
                log('App detected, starting filter');

                // Start observing and scanning
                setupObserver();
                startPeriodicScan();

                // Initial application
                setTimeout(applyFilter, 1000);
            }
        }, 500);
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();