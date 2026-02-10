// ==UserScript==
// @name         Mucklet Sleeper Filter
// @namespace    https://mucklet.com/
// @version      1.1.1
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
    //
    // Actual Mucklet client DOM structure (from live inspection):
    //
    //   div.pageroom
    //     div.namesection            (room name / image)
    //     div.pageroom--population   (population count)
    //     div.pageroom--sections
    //       div.panelsection  (Description)
    //       div.panelsection  (Commands)
    //       div.panelsection.pageroom--exits   ← exits section
    //         div.panelsection--content
    //           div.pageroom-exit
    //             div.pageroom-exitchars
    //               div.pageroom-exitchars--row
    //                 div.pageroom-exitchars--char   ← tiny avatar only
    //       div.panelsection.pageroom--chars   ← "In room" section
    //         div.panelsection--head
    //           div.panelsection--title
    //             div.pageroom--inroomheader
    //               h3 "In room"
    //         div.panelsection--content
    //           div > div > div >
    //             div.pageroom-char              ← top-level char element
    //               div.pageroom-char--cont
    //                 div.pageroom-char--badge.badge.btn.margin4
    //                   div.badge--select
    //                     div.avatar (avatar img)
    //                     div.badge--info
    //                       div.pageroom-char--name.common--level-{active|idle|inactive|asleep}
    //                         span (first name)
    //                         span (last name)
    //                       div.badge--text (gender / species)
    //                     div.badge--tools
    //                   div.counter
    // =========================================================================

    /**
     * Find the "In room" panel section in the room page.
     * Uses the exact class: .panelsection.pageroom--chars
     */
    function findInRoomSection() {
        const section = document.querySelector('.panelsection.pageroom--chars');
        if (!section) {
            log('Could not find .panelsection.pageroom--chars');
            return null;
        }
        const header = section.querySelector('h3');
        return { header, section };
    }

    /**
     * Find the exits section.
     * Uses the exact class: .panelsection.pageroom--exits
     */
    function findExitsSection() {
        const section = document.querySelector('.panelsection.pageroom--exits');
        if (!section) return null;
        const header = section.querySelector('h3');
        return { header, section };
    }

    /**
     * Get character elements from the "In room" section.
     *
     * IMPORTANT: We select ONLY .pageroom-char elements. The old code used
     * [class*="char--"] which also matched inner elements like
     * .pageroom-char--cont, .pageroom-char--badge, .pageroom-char--name,
     * producing duplicate/broken entries when cloned into the sleepers section.
     */
    function getCharElements(section) {
        if (!section) return [];
        // .pageroom-char is the top-level wrapper for each character badge row
        return Array.from(section.querySelectorAll('.pageroom-char'));
    }

    /**
     * Get character elements from exit rooms (transparent exits).
     *
     * NOTE: Exit char elements (.pageroom-exitchars--char) are tiny avatar
     * thumbnails only — they do NOT carry common--level-* classes, so
     * isSleeperChar() cannot detect their state from the DOM alone.
     * To filter them, we cross-reference avatar URLs with identified sleepers.
     */
    function getExitCharElements() {
        return Array.from(document.querySelectorAll('.pageroom-exitchars--char'));
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
                // Remove msf-hidden-char from the clone AND all descendants
                // (applyFilter adds it to the top element, but the old buggy
                // getCharElements used to also match inner elements and add
                // the class to them — clean up everything to be safe)
                clone.classList.remove('msf-hidden-char');
                clone.querySelectorAll('.msf-hidden-char').forEach(
                    child => child.classList.remove('msf-hidden-char'),
                );
                // Note: cloneNode does not copy event listeners. Clicks on
                // cloned character names won't navigate to their profile.
                // This is a known limitation of the DOM-level approach.
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

        // Check if our toggle already exists
        const existingToggle = section.querySelector('.msf-toggle-container');

        // Get all character elements (only top-level .pageroom-char, not inner elements)
        const charElements = getCharElements(section);
        log(`Found ${charElements.length} character elements`);

        // Reset all chars to visible first
        for (const el of charElements) {
            el.classList.remove('msf-hidden-char');
        }

        // Remove any "no awake" placeholder we might have added
        const existingPlaceholder = section.querySelector('.msf-no-awake-placeholder');
        if (existingPlaceholder) existingPlaceholder.remove();

        // Ensure toggle exists — insert inside .panelsection--title, before .pageroom--inroomheader
        if (!existingToggle) {
            const titleEl = section.querySelector('.panelsection--title');
            const inroomHeader = section.querySelector('.pageroom--inroomheader');
            if (titleEl && inroomHeader) {
                titleEl.insertBefore(createToggle(), inroomHeader);
            }
        }

        if (!splitEnabled) {
            // Unhide any exit chars we previously hid
            document.querySelectorAll('.pageroom-exitchars--char.msf-hidden-char')
                .forEach(el => el.classList.remove('msf-hidden-char'));
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

        // Create sleepers section after the "In room" section
        const sleepersSection = createSleepersSection(sleepers);
        if (section.nextSibling) {
            section.parentElement.insertBefore(sleepersSection, section.nextSibling);
        } else {
            section.parentElement.appendChild(sleepersSection);
        }

        // Filter exit chars (transparent exits) by cross-referencing avatar URLs
        filterExitChars(sleepers);
    }

    /**
     * Filter characters in transparent exit displays.
     *
     * Exit char elements (.pageroom-exitchars--char) are tiny avatar-only
     * thumbnails with NO level-* classes. We can't use isSleeperChar() on them.
     * Instead, we collect avatar base URLs from known sleepers in the room and
     * cross-reference against exit char avatar images.
     *
     * This catches the case where a sleeper character also appears in a
     * transparent exit's character grid (same room or adjacent).
     */
    function filterExitChars(sleeperElements) {
        // Reset all exit char visibility first
        document.querySelectorAll('.pageroom-exitchars--char.msf-hidden-char')
            .forEach(el => el.classList.remove('msf-hidden-char'));

        if (!splitEnabled || !sleeperElements || sleeperElements.length === 0) {
            return;
        }

        // Build a set of avatar base URLs from identified sleepers
        const sleeperAvatarUrls = new Set();
        for (const el of sleeperElements) {
            const img = el.querySelector('.avatar img');
            if (img && img.src) {
                // Strip query params (?thumb=s vs ?thumb=m) for comparison
                sleeperAvatarUrls.add(img.src.split('?')[0]);
            }
        }

        if (sleeperAvatarUrls.size === 0) return;

        // Match exit char avatars against the sleeper set
        const exitChars = getExitCharElements();
        for (const exitChar of exitChars) {
            const img = exitChar.querySelector('img');
            if (!img || !img.src) continue;
            const baseUrl = img.src.split('?')[0];
            if (sleeperAvatarUrls.has(baseUrl)) {
                exitChar.classList.add('msf-hidden-char');
            }
        }
    }

    // =========================================================================
    // Observation & Initialization
    // =========================================================================

    /**
     * Set up a MutationObserver to watch for room panel changes.
     *
     * We observe document.body for childList + subtree changes (the client
     * re-renders sections when you move rooms), and attribute changes on
     * 'class' (the level classes change when a character goes idle/asleep).
     *
     * We skip mutations caused by our own DOM manipulation (toggle, sleepers
     * section) to avoid infinite loops.
     */
    function setupObserver() {
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver((mutations) => {
            let shouldReapply = false;
            for (const mutation of mutations) {
                const target = mutation.target;
                if (!target) continue;

                // Skip mutations inside our own injected elements
                if (target.closest?.('#msf-sleepers-section') ||
                    target.closest?.('.msf-toggle-container') ||
                    target.classList?.contains('msf-hidden-char') ||
                    target.classList?.contains('msf-sleepers-list') ||
                    target.classList?.contains('msf-sleepers-arrow')) {
                    continue;
                }

                const cls = target.className?.toString() || '';

                // React to changes in the room panel, character elements,
                // panel sections, or the fader transition wrappers
                if (cls.includes('pageroom') ||
                    cls.includes('panelsection') ||
                    cls.includes('common--level') ||
                    cls.includes('fader') ||
                    cls.includes('badge') ||
                    mutation.addedNodes.length > 0 ||
                    mutation.removedNodes.length > 0) {
                    shouldReapply = true;
                    break;
                }
            }

            if (shouldReapply) {
                clearTimeout(setupObserver._timeout);
                setupObserver._timeout = setTimeout(applyFilter, 200);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    /**
     * Periodic scan as a safety net for cases the observer misses.
     * Checks whether the room panel has changed (e.g. navigated to a new room)
     * or whether the toggle was removed by the client re-rendering.
     */
    function startPeriodicScan() {
        setInterval(() => {
            const inRoom = findInRoomSection();
            if (inRoom) {
                // Room panel changed (navigated to a different room)
                if (inRoom.section !== lastRoomPanel) {
                    lastRoomPanel = inRoom.section;
                    applyFilter();
                    return;
                }

                // Toggle got removed by a client re-render
                if (!inRoom.section.querySelector('.msf-toggle-container')) {
                    applyFilter();
                }
            } else {
                // Room panel gone (e.g. switched to a different tab)
                lastRoomPanel = null;
            }
        }, CONFIG.scanInterval);
    }

    /**
     * Wait for the app to load, then initialize.
     *
     * The Mucklet client renders into a .layoutdesktop (or .layoutmobile)
     * container inside .screen.viewport. We wait for that to appear.
     */
    function init() {
        log('Initializing Mucklet Sleeper Filter');

        const waitForApp = setInterval(() => {
            // The client is loaded when the layout container exists with content
            const appRoot = document.querySelector('.layoutdesktop, .layoutmobile, .screen.viewport');
            if (appRoot && appRoot.children.length > 0) {
                clearInterval(waitForApp);
                log('App detected, starting filter');

                setupObserver();
                startPeriodicScan();

                // Give the room panel a moment to render before first apply
                setTimeout(applyFilter, 500);
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