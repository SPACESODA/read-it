class SpeechApp {
    constructor() {
        // Core runtime state
        this.synth = window.speechSynthesis || null;
        this.isSpeechSupported = Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
        this.voices = [];
        this.chunks = [];
        this.currentChunkIndex = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this.currentUtterance = null; // Track active utterance for robust cancellation
        this.activeUtteranceId = 0;
        this.utteranceIdCounter = 0;
        this.speakTimeoutId = null;
        this.speakRequestId = 0;
        this.detectTimeoutId = null;
        this.selectedVoiceKey = '';
        this.voiceFilterLang = '';
        this.detectedLang = '';
        this.lastVoiceRefreshAt = 0;
        // Clear-confirm state for the Paste/Clear button.
        this.isClearConfirm = false;
        this.clearConfirmTimeoutId = null;
        this.clearConfirmStartedAt = 0;
        this.clearConfirmRemainingMs = 0;
        // Multi-slot storage (1-5) for independent text/progress.
        this.slotCount = 5;
        this.activeSlot = 1;
        this.slots = this.createDefaultSlots();

        this.storage = this.getStorage();
        this.storageEnabled = Boolean(this.storage);
        this.storageKeys = {
            slots: 'speechApp:slots',
            activeSlot: 'speechApp:activeSlot',
            voicePrefs: 'speechApp:voicePrefs'
        };
        this.voicePreferences = {};
        this.lastStoredText = '';

        // DOM elements
        this.textInput = document.getElementById('text-input');
        this.voiceSelect = document.getElementById('voice-select');
        this.autoDetectToggle = document.getElementById('auto-detect');
        this.autoDetectText = document.getElementById('auto-detect-text');
        this.chromeTip = document.getElementById('chrome-tip');
        this.btnPaste = document.getElementById('btn-paste');
        this.chunkDisplay = document.getElementById('chunk-display');
        this.btnPlayPause = document.getElementById('btn-play-pause');
        this.btnRewind = document.getElementById('btn-rewind');
        this.btnForward = document.getElementById('btn-forward');
        this.btnStop = document.getElementById('btn-stop');
        this.iconPlay = this.btnPlayPause ? this.btnPlayPause.querySelector('.icon-play') : null;
        this.iconPause = this.btnPlayPause ? this.btnPlayPause.querySelector('.icon-pause') : null;
        this.autoDetectLabelText = this.autoDetectText ? this.autoDetectText.textContent.trim() : 'Auto-detect language';
        // Slot buttons are optional if markup is removed.
        this.slotButtons = Array.from(document.querySelectorAll('.slot-button'));

        this.init();
    }

    init() {
        // Restore input/progress early so UI reflects last session.
        this.restoreFromStorage();
        this.addEventListeners();
        this.registerServiceWorker();
        this.updateChromeTipVisibility();
        // Update UI state after storage restore.
        this.updateSlotButtons();
        this.updatePasteButtonState();

        if (!this.isSpeechSupported) {
            this.disableSpeechUI();
            this.updateChunkDisplay('Speech synthesis is not supported in this browser.');
            return;
        }

        this.loadVoices();
        if (this.synth.onvoiceschanged !== undefined) {
            this.synth.onvoiceschanged = () => this.loadVoices();
        }
    }

    loadVoices() {
        // Some browsers populate voices asynchronously.
        this.voices = this.synth.getVoices();
        if (this.voices.length === 0) {
            setTimeout(() => {
                this.voices = this.synth.getVoices();
                this.populateVoiceList({ skipAutoDetect: true });
                this.applyAutoDetectIfNeeded({ force: true });
            }, 100);
            return;
        }
        this.populateVoiceList({ skipAutoDetect: true });
        this.applyAutoDetectIfNeeded({ force: true });
    }

    refreshVoicesFromInput() {
        if (!this.synth) return false;
        const now = Date.now();
        if (now - this.lastVoiceRefreshAt < 1000) return false;
        this.lastVoiceRefreshAt = now;
        this.loadVoices();
        return true;
    }

    populateVoiceList({ filterLang = this.voiceFilterLang, skipAutoDetect = false } = {}) {
        if (!this.voiceSelect) return;
        const filterBase = this.getVoiceFilterBase(filterLang);
        const previousKey = this.selectedVoiceKey || this.getVoiceKey(this.getSelectedVoice());
        this.voiceSelect.innerHTML = '';
        const fragment = document.createDocumentFragment();
        let restoredSelection = false;
        let added = 0;
        this.voices.forEach((voice, index) => {
            if (filterBase && !this.voiceMatchesFilter(voice, filterBase)) {
                return;
            }
            const option = document.createElement('option');
            option.textContent = `${voice.name} (${voice.lang})`;
            option.setAttribute('data-lang', voice.lang);
            option.setAttribute('data-name', voice.name);
            option.value = index;
            const voiceKey = this.getVoiceKey(voice);
            if (previousKey && voiceKey === previousKey) {
                option.selected = true;
                restoredSelection = true;
            } else if (!previousKey && voice.default) {
                option.selected = true;
            }
            fragment.appendChild(option);
            added += 1;
        });
        if (added === 0 && filterBase) {
            this.voiceFilterLang = '';
            return this.populateVoiceList({ filterLang: '', skipAutoDetect });
        }
        this.voiceSelect.appendChild(fragment);
        this.selectedVoiceKey = this.getVoiceKey(this.getSelectedVoice());
        if (!skipAutoDetect && !restoredSelection) {
            this.applyAutoDetect(this.textInput.value, { force: true });
        }
    }

    addEventListeners() {
        this.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
        this.btnRewind.addEventListener('click', () => this.handleRewind());
        if (this.btnForward) {
            this.btnForward.addEventListener('click', () => this.handleSkipForward());
        }
        if (this.btnPaste) {
            this.btnPaste.addEventListener('click', () => this.handlePasteButtonClick());
            // Pause confirm timeout while the button is hovered or focused.
            this.btnPaste.addEventListener('mouseenter', () => this.pauseClearConfirmTimer());
            this.btnPaste.addEventListener('mouseleave', () => this.resumeClearConfirmTimer());
            this.btnPaste.addEventListener('focus', () => this.pauseClearConfirmTimer());
            this.btnPaste.addEventListener('blur', () => this.resumeClearConfirmTimer());
        }
        if (this.slotButtons.length > 0) {
            this.slotButtons.forEach((button) => {
                button.addEventListener('click', () => {
                    const slot = Number.parseInt(button.getAttribute('data-slot'), 10);
                    this.switchSlot(slot);
                });
            });
        }
        this.btnStop.addEventListener('click', () => this.handleStop());
        if (this.textInput) {
            this.textInput.addEventListener('input', () => this.handleTextInputChange());
            this.textInput.addEventListener('dragenter', (event) => this.handleTextDragEnter(event));
            this.textInput.addEventListener('dragover', (event) => this.handleTextDragOver(event));
            this.textInput.addEventListener('dragleave', (event) => this.handleTextDragLeave(event));
            this.textInput.addEventListener('drop', (event) => this.handleTextDrop(event));
        }
        if (this.voiceSelect) {
            this.voiceSelect.addEventListener('change', () => {
                const selected = this.getSelectedVoice();
                this.selectedVoiceKey = this.getVoiceKey(selected);
                const prefKey = this.getVoicePreferenceKey(selected);
                if (prefKey && selected) {
                    this.setVoicePreference(prefKey, this.selectedVoiceKey);
                }
            });
        }
        if (this.autoDetectToggle) {
            this.autoDetectToggle.addEventListener('change', () => this.handleAutoDetectToggle());
        }
        document.addEventListener('keydown', (event) => this.handleGlobalKeydown(event));
    }

    handleGlobalKeydown(event) {
        if (!event || event.defaultPrevented) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.repeat) return;
        if (this.isTypingTarget(event.target)) return;
        // Let focused buttons/links handle Space/Arrow keys, except the active slot button.
        if (this.isInteractiveTarget(event.target) && !this.isActiveSlotButtonTarget(event.target)) return;

        if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            this.togglePlayPause();
            return;
        }

        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            this.handleRewind();
            return;
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault();
            this.handleSkipForward();
        }
    }

    isTypingTarget(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        const tagName = target.tagName ? target.tagName.toLowerCase() : '';
        return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
    }

    isInteractiveTarget(target) {
        if (!target || !target.closest) return false;
        // Covers buttons, links, and custom button roles (e.g., slot buttons).
        return Boolean(target.closest('button, a, [role="button"]'));
    }

    isActiveSlotButtonTarget(target) {
        if (!target || !target.closest) return false;
        return Boolean(target.closest('.slot-button.is-active'));
    }

    disableSpeechUI() {
        // Gracefully handle browsers without the SpeechSynthesis API.
        if (this.voiceSelect) {
            this.voiceSelect.disabled = true;
        }
        if (this.autoDetectToggle) {
            this.autoDetectToggle.checked = false;
            this.autoDetectToggle.disabled = true;
        }
        this.updateDetectedLangLabel('');

        if (this.btnPlayPause) this.btnPlayPause.disabled = true;
        if (this.btnRewind) this.btnRewind.disabled = true;
        if (this.btnForward) this.btnForward.disabled = true;
        if (this.btnStop) this.btnStop.disabled = true;
    }

    registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        window.addEventListener('load', () => {
            navigator.serviceWorker
                .register('./sw.js')
                .then((registration) => this.enableServiceWorkerUpdates(registration))
                .catch(() => {});
        });
    }

    enableServiceWorkerUpdates(registration) {
        if (!registration || typeof registration.update !== 'function') return;
        const updateRegistration = () => {
            registration.update().catch(() => {});
        };
        updateRegistration();
        window.addEventListener('online', updateRegistration);
    }

    updateChromeTipVisibility() {
        if (!this.chromeTip) return;
        this.chromeTip.hidden = this.isChromeBrowser();
    }

    resetClearConfirm() {
        if (!this.isClearConfirm) return;
        this.isClearConfirm = false;
        if (this.clearConfirmTimeoutId) {
            clearTimeout(this.clearConfirmTimeoutId);
            this.clearConfirmTimeoutId = null;
        }
        this.clearConfirmStartedAt = 0;
        this.clearConfirmRemainingMs = 0;
    }

    scheduleClearConfirmTimeout(durationMs) {
        if (this.clearConfirmTimeoutId) {
            clearTimeout(this.clearConfirmTimeoutId);
        }
        // If the timer expired while paused, reset immediately.
        if (durationMs <= 0) {
            this.resetClearConfirm();
            this.updatePasteButtonState();
            return;
        }
        this.clearConfirmStartedAt = Date.now();
        this.clearConfirmRemainingMs = durationMs;
        this.clearConfirmTimeoutId = setTimeout(() => {
            this.isClearConfirm = false;
            this.clearConfirmTimeoutId = null;
            this.clearConfirmStartedAt = 0;
            this.clearConfirmRemainingMs = 0;
            this.updatePasteButtonState();
        }, durationMs);
    }

    pauseClearConfirmTimer() {
        if (!this.isClearConfirm || !this.clearConfirmTimeoutId) return;
        // Preserve remaining time so hover/focus doesn't burn the countdown.
        const elapsed = Date.now() - this.clearConfirmStartedAt;
        this.clearConfirmRemainingMs = Math.max(0, this.clearConfirmRemainingMs - elapsed);
        clearTimeout(this.clearConfirmTimeoutId);
        this.clearConfirmTimeoutId = null;
        this.clearConfirmStartedAt = 0;
    }

    resumeClearConfirmTimer() {
        if (!this.isClearConfirm || this.clearConfirmTimeoutId) return;
        // Resume from the remaining time.
        if (this.clearConfirmRemainingMs <= 0) {
            this.resetClearConfirm();
            this.updatePasteButtonState();
            return;
        }
        this.scheduleClearConfirmTimeout(this.clearConfirmRemainingMs);
    }

    startClearConfirm() {
        this.isClearConfirm = true;
        // Give the user a short window to confirm clearing.
        this.scheduleClearConfirmTimeout(5000);
        this.updatePasteButtonState();
    }

    updatePasteButtonState() {
        if (!this.btnPaste || !this.textInput) return;
        const hasText = this.textInput.value.length > 0;
        if (!hasText) {
            this.resetClearConfirm();
        }
        const isConfirm = hasText && this.isClearConfirm;
        this.btnPaste.textContent = hasText ? (isConfirm ? 'Confirm to Clear' : 'Clear') : 'Paste';
        this.btnPaste.setAttribute(
            'aria-label',
            hasText ? (isConfirm ? 'Confirm clear content' : 'Clear content') : 'Paste from clipboard'
        );
        this.btnPaste.classList.toggle('is-confirm', isConfirm);
    }

    async handlePasteButtonClick() {
        if (!this.textInput) return;
        const hasText = this.textInput.value.length > 0;
        if (hasText) {
            if (!this.isClearConfirm) {
                this.startClearConfirm();
                this.textInput.focus();
                return;
            }
            this.resetClearConfirm();
            this.textInput.value = '';
            this.handleTextInputChange();
            this.textInput.focus();
            return;
        }

        this.resetClearConfirm();
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            this.textInput.focus();
            return;
        }

        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                this.textInput.value = text;
                this.handleTextInputChange();
            }
            this.textInput.focus();
        } catch (error) {
            console.warn('Clipboard read failed', error);
            this.textInput.focus();
        }
    }

    handleTextDragEnter(event) {
        if (!event || !this.textInput) return;
        if (!this.hasFileDrop(event)) return;
        event.preventDefault();
        const canAccept = this.canAcceptTextDrop(event);
        this.setDropTargetState(canAccept, !canAccept);
    }

    handleTextDragOver(event) {
        if (!event || !this.textInput) return;
        if (!this.hasFileDrop(event)) return;
        event.preventDefault();
        const canAccept = this.canAcceptTextDrop(event);
        this.setDropTargetState(canAccept, !canAccept);
        event.dataTransfer.dropEffect = canAccept ? 'copy' : 'none';
    }

    handleTextDragLeave(event) {
        if (!event || !this.textInput) return;
        this.setDropTargetState(false, false);
    }

    handleTextDrop(event) {
        if (!event || !this.textInput) return;
        if (!this.hasFileDrop(event)) return;
        event.preventDefault();
        this.setDropTargetState(false, false);
        if (!this.canAcceptTextDrop(event)) return;
        const file = this.getDropTextFile(event);
        if (!file) return;
        this.readFileAsText(file)
            .then((text) => {
                if (!text) return;
                this.textInput.value = text;
                this.handleTextInputChange();
                this.textInput.focus();
            })
            .catch((error) => {
                console.warn('File read failed', error);
                this.textInput.focus();
            });
    }

    setDropTargetState(isActive, isBlocked) {
        if (!this.textInput) return;
        this.textInput.classList.toggle('is-drop-target', isActive);
        this.textInput.classList.toggle('is-drop-blocked', isBlocked);
    }

    hasFileDrop(event) {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return false;
        const types = Array.from(dataTransfer.types || []);
        if (types.includes('Files')) return true;
        const items = Array.from(dataTransfer.items || []);
        if (items.some((item) => item.kind === 'file')) return true;
        const files = Array.from(dataTransfer.files || []);
        return files.length > 0;
    }

    canAcceptTextDrop(event) {
        if (!event || !this.textInput) return false;
        if (this.textInput.value.length > 0) return false;
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return false;
        const items = Array.from(dataTransfer.items || []).filter((item) => item.kind === 'file');
        const files = Array.from(dataTransfer.files || []);
        const fileCount = files.length || items.length;
        if (fileCount > 1) return false;
        const candidate = items[0] || files[0];
        if (candidate && candidate.type && !this.isAllowedDropMime(candidate.type)) return false;
        return true;
    }

    getDropTextFile(event) {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return null;
        const files = Array.from(dataTransfer.files || []);
        if (files.length !== 1) return null;
        const file = files[0];
        const isAllowedType = this.isAllowedDropMime(file.type);
        const isAllowedName = this.isAllowedDropName(file.name);
        if (!isAllowedType && !isAllowedName) return null;
        return file;
    }

    isAllowedDropMime(mimeType) {
        if (!mimeType) return true;
        return mimeType === 'text/plain' || mimeType === 'text/markdown';
    }

    isAllowedDropName(fileName) {
        if (!fileName) return false;
        const lower = fileName.toLowerCase();
        return lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown');
    }

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('File read failed'));
            reader.readAsText(file);
        });
    }

    isChromeBrowser() {
        const ua = navigator.userAgent || '';
        const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (isIOS) {
            return false;
        }

        const uaData = navigator.userAgentData;
        if (uaData && Array.isArray(uaData.brands)) {
            const brands = uaData.brands.map((entry) => entry.brand.toLowerCase());
            const isEdge = brands.some((brand) => brand.includes('microsoft edge') || brand === 'edge');
            const isChromeBrand = brands.some((brand) => brand.includes('google chrome'));
            return isEdge || isChromeBrand;
        }

        const isEdge = /Edg\//.test(ua) || /Edge\//.test(ua);
        const vendor = (navigator.vendor || '').toLowerCase();
        const isGoogleVendor = vendor.includes('google');
        const isChrome = /Chrome|CriOS/.test(ua) && !isEdge && isGoogleVendor;
        return isEdge || isChrome;
    }

    getStorage() {
        // Guard against storage being blocked or full.
        try {
            const storage = window.localStorage;
            const testKey = '__speech_app_test__';
            storage.setItem(testKey, '1');
            storage.removeItem(testKey);
            return storage;
        } catch (error) {
            return null;
        }
    }

    createDefaultSlot() {
        return {
            text: '',
            progress: 0,
            playStatus: 'stopped'
        };
    }

    createDefaultSlots() {
        return Array.from({ length: this.slotCount }, () => this.createDefaultSlot());
    }

    normalizeSlotNumber(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return 1;
        if (parsed < 1 || parsed > this.slotCount) return 1;
        return parsed;
    }

    sanitizeSlot(slot) {
        const next = this.createDefaultSlot();
        if (!slot || typeof slot !== 'object') return next;
        if (typeof slot.text === 'string') {
            next.text = slot.text;
        }
        if (Number.isFinite(slot.progress)) {
            next.progress = Math.max(0, slot.progress);
        }
        if (typeof slot.playStatus === 'string') {
            next.playStatus = slot.playStatus;
        }
        return next;
    }

    loadSlotsFromStorage() {
        if (!this.storage) return;
        let storedSlots = null;
        try {
            storedSlots = this.storage.getItem(this.storageKeys.slots);
        } catch (error) {
            this.storageEnabled = false;
        }

        let slots = null;
        if (storedSlots) {
            try {
                const parsed = JSON.parse(storedSlots);
                if (Array.isArray(parsed)) {
                    slots = parsed.map((slot) => this.sanitizeSlot(slot));
                }
            } catch (error) {
                slots = null;
            }
        }

        if (!slots) {
            slots = this.createDefaultSlots();
            this.safeSetItem(this.storageKeys.slots, JSON.stringify(slots));
        }

        let normalizedSlots = false;
        if (slots.length < this.slotCount) {
            const needed = this.slotCount - slots.length;
            for (let i = 0; i < needed; i += 1) {
                slots.push(this.createDefaultSlot());
            }
            normalizedSlots = true;
        } else if (slots.length > this.slotCount) {
            slots = slots.slice(0, this.slotCount);
            normalizedSlots = true;
        }

        this.slots = slots;
        if (normalizedSlots) {
            this.saveSlotsToStorage();
        }

        let storedActiveSlot = null;
        try {
            storedActiveSlot = this.storage.getItem(this.storageKeys.activeSlot);
        } catch (error) {
            this.storageEnabled = false;
        }
        this.activeSlot = this.normalizeSlotNumber(storedActiveSlot);
        this.safeSetItem(this.storageKeys.activeSlot, String(this.activeSlot));
    }

    cleanupLegacyStorage() {
        if (!this.storage) return;
        try {
            if (!this.storage.getItem(this.storageKeys.slots)) return;
            this.storage.removeItem('speechApp:text');
            this.storage.removeItem('speechApp:progress');
        } catch (error) {
            this.storageEnabled = false;
        }
    }

    saveSlotsToStorage() {
        this.safeSetItem(this.storageKeys.slots, JSON.stringify(this.slots));
    }

    getSlotState(slotNumber) {
        const normalized = this.normalizeSlotNumber(slotNumber);
        return this.slots[normalized - 1] || null;
    }

    applySlotState(slotNumber) {
        if (!this.textInput) return;
        const slot = this.getSlotState(slotNumber);
        if (!slot) return;

        this.resetClearConfirm();
        this.textInput.value = slot.text || '';
        this.lastStoredText = this.textInput.value;
        this.currentChunkIndex = Number.isFinite(slot.progress) ? Math.max(0, slot.progress) : 0;
        this.chunks = [];
        this.updateChunkDisplay('');
        this.updateButtonsState();
        this.updatePasteButtonState();
        this.applyAutoDetectIfNeeded({ force: true });
    }

    persistActiveSlotState(statusOverride) {
        if (!this.textInput) return;
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.text = this.textInput.value;
        slot.progress = this.currentChunkIndex;
        slot.playStatus = statusOverride || this.getCurrentPlayStatus();
        this.saveSlotsToStorage();
    }

    updateSlotButtons() {
        if (this.slotButtons.length === 0) return;
        this.slotButtons.forEach((button) => {
            const slot = Number.parseInt(button.getAttribute('data-slot'), 10);
            const isActive = slot === this.activeSlot;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    getCurrentPlayStatus() {
        if (this.isPlaying && !this.isPaused) return 'playing';
        if (this.isPaused) return 'paused';
        return 'stopped';
    }

    setPlayStatus(status) {
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.playStatus = status;
        this.saveSlotsToStorage();
    }

    stopPlaybackForSlotSwitch() {
        if (!this.isPlaying && !this.isPaused) return;
        this.cancelPlayback();
        this.isPlaying = false;
        this.isPaused = false;
        this.updateButtonsState();
        this.updateChunkDisplay('');
    }

    switchSlot(slotNumber) {
        const normalized = this.normalizeSlotNumber(slotNumber);
        if (normalized === this.activeSlot) return;
        // Save the current slot and stop audio before switching.
        const shouldPause = this.isPlaying && !this.isPaused;
        this.persistActiveSlotState(shouldPause ? 'paused' : null);
        this.stopPlaybackForSlotSwitch();
        this.activeSlot = normalized;
        this.safeSetItem(this.storageKeys.activeSlot, String(this.activeSlot));
        this.applySlotState(this.activeSlot);
        this.updateSlotButtons();
    }

    restoreFromStorage() {
        if (!this.storage) return;
        this.loadSlotsFromStorage();
        this.cleanupLegacyStorage();
        this.applySlotState(this.activeSlot);
        this.loadVoicePreferences();
    }

    loadVoicePreferences() {
        if (!this.storage) return;
        let storedPrefs = null;
        try {
            storedPrefs = this.storage.getItem(this.storageKeys.voicePrefs);
        } catch (error) {
            this.storageEnabled = false;
            return;
        }
        if (!storedPrefs) return;

        try {
            const parsed = JSON.parse(storedPrefs);
            if (!parsed || typeof parsed !== 'object') return;
            const next = {};
            Object.entries(parsed).forEach(([key, value]) => {
                if (typeof value !== 'string') return;
                next[key.toLowerCase()] = value;
            });
            this.voicePreferences = next;
        } catch (error) {
            return;
        }
    }

    saveVoicePreferences() {
        this.safeSetItem(this.storageKeys.voicePrefs, JSON.stringify(this.voicePreferences));
    }

    setVoicePreference(langKey, voiceKey) {
        if (!langKey || !voiceKey) return;
        this.voicePreferences[langKey] = voiceKey;
        this.saveVoicePreferences();
    }

    saveContentToStorage(text) {
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.text = text;
        this.saveSlotsToStorage();
    }

    saveProgressToStorage() {
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.progress = this.currentChunkIndex;
        this.saveSlotsToStorage();
    }

    safeSetItem(key, value) {
        if (!this.storage || !this.storageEnabled) return;
        try {
            this.storage.setItem(key, value);
        } catch (error) {
            this.storageEnabled = false;
        }
    }

    handleTextInputChange() {
        const currentText = this.textInput.value;
        const textChanged = currentText !== this.lastStoredText;

        if (textChanged) {
            this.resetClearConfirm();
            this.lastStoredText = currentText;
            this.saveContentToStorage(currentText);
            this.currentChunkIndex = 0;
            this.chunks = [];
            this.updateChunkDisplay('');
            this.saveProgressToStorage();
            this.setPlayStatus('stopped');

            if (this.isPlaying || this.isPaused) {
                this.cancelPlayback();
                this.isPlaying = false;
                this.isPaused = false;
                this.updateButtonsState();
            } else {
                this.updateButtonsState();
            }
        } else {
            this.saveContentToStorage(currentText);
        }

        this.updatePasteButtonState();

        if (!this.autoDetectToggle || !this.autoDetectToggle.checked) return;

        if (this.detectTimeoutId) {
            clearTimeout(this.detectTimeoutId);
        }

        this.detectTimeoutId = setTimeout(() => {
            this.detectTimeoutId = null;
            const refreshed = this.refreshVoicesFromInput();
            if (!refreshed) {
                this.applyAutoDetect(this.textInput.value);
            }
        }, 200);
    }

    handleAutoDetectToggle() {
        if (!this.autoDetectToggle) return;

        if (this.autoDetectToggle.checked) {
            this.applyAutoDetect(this.textInput.value, { force: true });
        } else {
            this.detectedLang = '';
            this.clearVoiceFilter();
            this.updateDocumentLanguage('en');
            this.updateDetectedLangLabel('');
        }
    }

    chunkText(text) {
        // Normalize/strip markdown, then split into sentence-sized chunks.
        const cleaned = this.prepareSpeechText(text);
        if (!cleaned) return [];

        const sentences = this.splitIntoSentences(cleaned);
        const chunks = sentences.length > 0 ? sentences : [cleaned];

        return this.splitLongChunks(chunks, 240);
    }

    prepareSpeechText(text) {
        // Lightweight markdown cleanup for better speech output.
        let cleaned = (text || '').replace(/\r\n/g, '\n');
        cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
        cleaned = cleaned.replace(/`[^`]*`/g, ' ');
        cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
        cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        cleaned = cleaned.replace(/^#{1,6}\s*/gm, '');
        cleaned = cleaned.replace(/^>\s?/gm, '');
        cleaned = cleaned.replace(/^\s*(\d+)[.)]\s+/gm, '$1. ');
        cleaned = cleaned.replace(/^\s*([A-Za-z])[.)]\s+/gm, '$1. ');
        cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, '');
        cleaned = cleaned.replace(/^\s*([-*_]){3,}\s*$/gm, ' ');
        cleaned = cleaned.replace(/^\[[^\]]+\]:\s*\S+/gm, ' ');
        cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');
        cleaned = cleaned.replace(/(\*\*|__)(.*?)\1/g, '$2');
        cleaned = cleaned.replace(/(^|[\s>])(\*|_)([^*_]+?)\2(?=[\s<]|$)/g, '$1$3');
        cleaned = cleaned.replace(/[ \t]+/g, ' ');
        cleaned = cleaned.replace(/\s*\n\s*/g, '\n');
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        return cleaned.trim();
    }

    splitIntoSentences(text) {
        // Prefer full-stop punctuation over arbitrary length cuts.
        const sentences = [];
        let buffer = '';
        const delimiterRegex = /[.!?。！？…]/;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '\n') {
                if (buffer.trim()) {
                    sentences.push(buffer.trim());
                }
                buffer = '';
                continue;
            }

            buffer += char;
            if (delimiterRegex.test(char)) {
                while (i + 1 < text.length && delimiterRegex.test(text[i + 1])) {
                    buffer += text[i + 1];
                    i += 1;
                }
                if (buffer.trim()) {
                    sentences.push(buffer.trim());
                }
                buffer = '';
            }
        }

        if (buffer.trim()) {
            sentences.push(buffer.trim());
        }

        return sentences;
    }

    splitLongChunks(chunks, maxLen) {
        // If a chunk is still too long, split by softer delimiters or word boundaries.
        const result = [];

        chunks.forEach((chunk) => {
            if (chunk.length <= maxLen) {
                result.push(chunk);
                return;
            }

            const punctuationSplit = this.splitByDelimiters(chunk, /[,，;；:：]/);
            if (punctuationSplit.length > 1) {
                punctuationSplit.forEach((part) => {
                    if (part.length <= maxLen) {
                        result.push(part);
                    } else {
                        this.splitByWhitespaceOrLength(part, maxLen, result);
                    }
                });
                return;
            }

            this.splitByWhitespaceOrLength(chunk, maxLen, result);
        });

        return result;
    }

    splitByDelimiters(text, delimiterRegex) {
        const parts = [];
        let buffer = '';

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '\n') {
                if (buffer.trim()) {
                    parts.push(buffer.trim());
                }
                buffer = '';
                continue;
            }

            buffer += char;
            if (delimiterRegex.test(char)) {
                while (i + 1 < text.length && delimiterRegex.test(text[i + 1])) {
                    buffer += text[i + 1];
                    i += 1;
                }
                if (buffer.trim()) {
                    parts.push(buffer.trim());
                }
                buffer = '';
            }
        }

        if (buffer.trim()) {
            parts.push(buffer.trim());
        }

        return parts;
    }

    splitByWhitespaceOrLength(text, maxLen, result) {
        if (/\s/.test(text)) {
            const words = text.split(/\s+/).filter(Boolean);
            let current = '';
            words.forEach((word) => {
                if (!current) {
                    current = word;
                    return;
                }

                if (current.length + 1 + word.length > maxLen) {
                    result.push(current);
                    current = word;
                } else {
                    current = `${current} ${word}`;
                }
            });
            if (current) {
                result.push(current);
            }
            return;
        }

        for (let i = 0; i < text.length; i += maxLen) {
            result.push(text.slice(i, i + maxLen));
        }
    }

    applyAutoDetectIfNeeded({ force = false } = {}) {
        if (!this.autoDetectToggle || !this.autoDetectToggle.checked) return;
        if (!this.textInput) return;
        this.applyAutoDetect(this.textInput.value, { force });
    }

    applyAutoDetect(text, { force = false } = {}) {
        if (!this.autoDetectToggle || !this.autoDetectToggle.checked) {
            this.updateDocumentLanguage('en');
            this.updateDetectedLangLabel('');
            return;
        }

        const detection = this.detectLanguageInfo(this.prepareSpeechText(text));
        if (!detection || !detection.lang) {
            this.detectedLang = '';
            this.clearVoiceFilter();
            this.updateDocumentLanguage('en');
            this.updateDetectedLangLabel('');
            return;
        }

        const { lang, shouldAutoSwitch } = detection;
        this.detectedLang = lang;
        this.updateDocumentLanguage(lang);
        this.updateDetectedLangLabel(lang);
        this.updateVoiceFilter(lang);

        if (this.voices.length === 0) {
            return;
        }

        if (!shouldAutoSwitch) {
            return;
        }

        const hasGoogle = this.hasGoogleVoiceForLanguage(lang);
        if (!force && this.selectedVoiceMatchesLang(lang)) {
            if (!hasGoogle || this.isSelectedVoiceGoogle()) {
                return;
            }
        }

        this.selectVoiceForLanguage(lang);
    }

    detectLanguageInfo(text) {
        // Script-first detection, then fall back to diacritics/keywords.
        const sample = (text || '').trim().slice(0, 4000);
        if (!sample) {
            return { lang: null, shouldAutoSwitch: false };
        }

        const cjkInfo = this.detectCjkLanguageInfo(sample);
        if (cjkInfo) {
            return cjkInfo;
        }

        if (/[\uac00-\ud7af]/.test(sample)) {
            return { lang: 'ko', shouldAutoSwitch: true };
        }

        const scriptChecks = [
            { lang: 'ru', regex: /[\u0400-\u04ff]/ },
            { lang: 'ar', regex: /[\u0600-\u06ff]/ },
            { lang: 'he', regex: /[\u0590-\u05ff]/ },
            { lang: 'hi', regex: /[\u0900-\u097f]/ },
            { lang: 'th', regex: /[\u0e00-\u0e7f]/ }
        ];

        for (const check of scriptChecks) {
            if (check.regex.test(sample)) {
                return { lang: check.lang, shouldAutoSwitch: true };
            }
        }

        const lower = sample.toLowerCase();
        const scores = new Map();
        const addScore = (lang, regex, weight = 1) => {
            const matches = lower.match(regex);
            if (!matches) return;
            scores.set(lang, (scores.get(lang) || 0) + matches.length * weight);
        };

        addScore('de', /[äöüß]/g, 2);
        addScore('es', /[áéíóúüñ¿¡]/g, 2);
        addScore('fr', /[àâçéèêëîïôûùüÿœ]/g, 2);
        addScore('pt', /[ãõçáéíóúâêôà]/g, 2);
        addScore('it', /[àèéìíòóù]/g, 2);
        addScore('tr', /[ğüşöçıı]/g, 2);
        addScore('vi', /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/g, 2);

        addScore('en', /\b(the|and|with|for|that|this|from|are)\b/g);
        addScore('es', /\b(el|la|los|las|que|para|con|por|una|un)\b/g);
        addScore('fr', /\b(le|la|les|des|pour|avec|une|un)\b/g);
        addScore('de', /\b(und|der|die|das|mit|für|ein|eine)\b/g);
        addScore('it', /\b(il|lo|la|gli|che|per|con|una|un)\b/g);
        addScore('pt', /\b(o|a|os|as|que|para|com|uma|um)\b/g);

        let bestLang = null;
        let bestScore = 0;
        for (const [lang, score] of scores.entries()) {
            if (score > bestScore) {
                bestLang = lang;
                bestScore = score;
            }
        }

        if (bestLang && bestScore > 0) {
            return { lang: bestLang, shouldAutoSwitch: true };
        }

        return { lang: navigator.language || 'en-US', shouldAutoSwitch: true };
    }

    detectCjkLanguageInfo(text) {
        const counts = this.getCjkCounts(text);

        // Bopomofo indicates Traditional Chinese.
        if (counts.bopomofoCount > 0) {
            return { lang: 'zh-TW', shouldAutoSwitch: true };
        }

        if (counts.hanCount === 0 && counts.kanaCount === 0) {
            return null;
        }

        const signalCount = counts.hanCount + counts.kanaCount + counts.latinCount;
        const hanRatio = signalCount > 0 ? counts.hanCount / signalCount : 0;
        const kanaRatio = signalCount > 0 ? counts.kanaCount / signalCount : 0;

        // If Han characters dominate, prefer Chinese even with mixed scripts.
        if (hanRatio >= 0.55) {
            const variant = this.detectChineseVariantWithConfidence(text);
            return { lang: variant.lang, shouldAutoSwitch: true };
        }

        // Strong kana presence implies Japanese.
        if (counts.kanaCount >= 6 && kanaRatio >= 0.2) {
            return { lang: 'ja', shouldAutoSwitch: true };
        }

        if (counts.kanaCount > 0) {
            return { lang: 'ja', shouldAutoSwitch: false };
        }

        const variant = this.detectChineseVariantWithConfidence(text);
        return {
            lang: variant.lang,
            shouldAutoSwitch: variant.confidence === 'high'
        };
    }

    getCjkCounts(text) {
        let hanCount = 0;
        let kanaCount = 0;
        let bopomofoCount = 0;
        let latinCount = 0;

        for (const char of text) {
            if (/[\u4e00-\u9fff]/.test(char)) {
                hanCount += 1;
                continue;
            }
            if (/[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/.test(char)) {
                kanaCount += 1;
                continue;
            }
            if (/[\u3100-\u312f]/.test(char)) {
                bopomofoCount += 1;
                continue;
            }
            if (/[A-Za-z]/.test(char)) {
                latinCount += 1;
            }
        }

        return { hanCount, kanaCount, bopomofoCount, latinCount };
    }

    detectChineseVariantWithConfidence(text) {
        // Simple heuristic: count traditional vs simplified characters.
        const sample = (text || '').slice(0, 4000);
        const { traditionalChars, simplifiedChars } = this.getChineseCharSets();
        let tradCount = 0;
        let simpCount = 0;

        for (const char of sample) {
            if (traditionalChars.has(char)) tradCount += 1;
            if (simplifiedChars.has(char)) simpCount += 1;
        }

        const total = tradCount + simpCount;
        let lang = null;
        if (tradCount > simpCount) {
            lang = 'zh-TW';
        } else if (simpCount > tradCount) {
            lang = 'zh-CN';
        } else {
            const locale = navigator.language || '';
            if (locale.toLowerCase().startsWith('zh-tw') || locale.toLowerCase().startsWith('zh-hk')) {
                lang = 'zh-TW';
            } else {
                lang = 'zh-CN';
            }
        }

        let confidence = 'low';
        if (total >= 6) {
            confidence = 'high';
        } else if (total >= 3) {
            const maxCount = Math.max(tradCount, simpCount);
            const minCount = Math.min(tradCount, simpCount);
            if (minCount === 0 || maxCount / minCount >= 1.6) {
                confidence = 'high';
            } else {
                confidence = 'medium';
            }
        }

        return { lang, confidence, totalMarkers: total };
    }

    getChineseCharSets() {
        if (this.chineseCharSets) return this.chineseCharSets;

        const pairs = [
            ['國', '国'], ['學', '学'], ['術', '术'], ['體', '体'], ['醫', '医'],
            ['門', '门'], ['風', '风'], ['畫', '画'], ['廣', '广'], ['臺', '台'],
            ['萬', '万'], ['與', '与'], ['車', '车'], ['馬', '马'], ['豐', '丰'],
            ['後', '后'], ['發', '发'], ['華', '华'], ['裡', '里'], ['際', '际'],
            ['雲', '云'], ['點', '点'], ['歡', '欢'], ['樂', '乐'], ['羅', '罗'],
            ['齊', '齐'], ['氣', '气'], ['灣', '湾'], ['書', '书'], ['劃', '划'],
            ['聽', '听'], ['說', '说'], ['讀', '读'], ['寫', '写'], ['訊', '讯'],
            ['號', '号'], ['價', '价'], ['區', '区'], ['龜', '龟'], ['實', '实'],
            ['藝', '艺'], ['壓', '压'], ['這', '这'], ['針', '针'], ['達', '达'],
            ['將', '将'], ['圖', '图'], ['當', '当'], ['過', '过'], ['還', '还'],
            ['讓', '让'], ['輸', '输'], ['園', '园'], ['圓', '圆'], ['魚', '鱼'],
            ['鳥', '鸟'], ['龍', '龙'], ['燈', '灯'], ['麵', '面'], ['餘', '余'],
            ['適', '适'], ['幫', '帮'], ['經', '经'], ['邊', '边'], ['蘇', '苏'],
            ['圍', '围'], ['鐵', '铁'], ['觀', '观'], ['鐘', '钟'], ['銀', '银'],
            ['雜', '杂'], ['難', '难'], ['電', '电'], ['歲', '岁'], ['麗', '丽'],
            ['戶', '户'], ['陽', '阳'], ['師', '师'], ['憶', '忆'], ['榮', '荣'],
            ['壯', '壮'], ['陰', '阴'], ['聲', '声'], ['徑', '径'], ['傷', '伤'],
            ['習', '习'], ['歸', '归'], ['顧', '顾'], ['夢', '梦'], ['續', '续'],
            ['絕', '绝'], ['雙', '双'], ['戀', '恋'], ['監', '监'], ['幣', '币'],
            ['顯', '显'], ['檔', '档'], ['環', '环'], ['隱', '隐'], ['縣', '县'],
            ['劍', '剑'], ['劑', '剂'], ['劉', '刘'], ['屬', '属'], ['儀', '仪'],
            ['隨', '随']
        ];

        const traditionalChars = new Set();
        const simplifiedChars = new Set();
        pairs.forEach(([traditional, simplified]) => {
            traditionalChars.add(traditional);
            simplifiedChars.add(simplified);
        });

        this.chineseCharSets = { traditionalChars, simplifiedChars };
        return this.chineseCharSets;
    }

    selectVoiceForLanguage(lang) {
        if (!lang || this.voices.length === 0 || !this.voiceSelect) return false;

        let matches = this.getVoiceMatchesForLanguage(lang);
        if (this.voiceFilterLang) {
            matches = matches.filter(match => this.voiceMatchesFilter(match.voice, this.voiceFilterLang));
        }
        if (matches.length === 0) return false;

        const preferredKey = this.getStoredVoicePreference(lang);
        const preferredMatch = this.findVoiceMatchByKey(matches, preferredKey);
        const naturalMatches = matches.filter(match => match.isMicrosoftNatural);
        const googleMatches = matches.filter(match => match.isGoogle);
        const pickBest = (items) => {
            if (items.length === 0) return null;
            return items.sort((a, b) => {
                if (a.rank !== b.rank) return a.rank - b.rank;
                if (a.isPreview !== b.isPreview) return a.isPreview ? 1 : -1;
                if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
                return 0;
            })[0];
        };

        let selection = null;
        if (preferredMatch) {
            if (preferredMatch.isMicrosoftNatural) {
                selection = preferredMatch;
            } else if (naturalMatches.length === 0) {
                selection = preferredMatch;
            }
        }

        if (!selection) {
            selection = pickBest(naturalMatches) || pickBest(googleMatches) || pickBest(matches);
        }
        if (!selection) return false;

        this.voiceSelect.value = String(selection.index);
        this.selectedVoiceKey = this.getVoiceKey(selection.voice);
        return true;
    }

    selectedVoiceMatchesLang(lang) {
        const voice = this.getSelectedVoice();
        if (!voice || !voice.lang) return false;

        const prefixes = this.getLanguageMatchPrefixes(lang);
        const voiceLang = voice.lang.toLowerCase();

        return prefixes.some(prefix => voiceLang.startsWith(prefix));
    }

    hasGoogleVoiceForLanguage(lang) {
        if (!lang || this.voices.length === 0) return false;
        return this.getVoiceMatchesForLanguage(lang).some(match => match.isGoogle);
    }

    isSelectedVoiceGoogle() {
        const voice = this.getSelectedVoice();
        return this.isGoogleVoice(voice);
    }

    getVoiceMatchesForLanguage(lang) {
        const prefixes = this.getLanguageMatchPrefixes(lang);
        const matches = [];

        this.voices.forEach((voice, index) => {
            if (!voice.lang) return;
            const voiceLang = voice.lang.toLowerCase();
            const rank = prefixes.findIndex(prefix => voiceLang.startsWith(prefix));
            if (rank === -1) return;
            matches.push({
                voice,
                index,
                rank,
                isMicrosoftNatural: this.isMicrosoftNaturalVoice(voice),
                isGoogle: this.isGoogleVoice(voice),
                isPreview: this.isPreviewVoice(voice),
                isDefault: Boolean(voice.default)
            });
        });

        return matches;
    }

    getLanguageMatchPrefixes(lang) {
        const normalized = (lang || '').toLowerCase();
        const base = normalized.split('-')[0];
        const prefixes = [];
        const add = (value) => {
            if (value && !prefixes.includes(value)) {
                prefixes.push(value);
            }
        };

        if (base === 'zh') {
            add(normalized);
            if (normalized.includes('tw') || normalized.includes('hant')) {
                add('zh-hant');
                add('cmn-hant');
                add('cmn');
                add('zh');
                add('yue');
            } else {
                add('zh-hans');
                add('cmn-hans');
                add('cmn');
                add('zh');
            }
        } else if (base === 'en') {
            if (normalized.includes('-')) {
                add(normalized);
            }
            add('en-us');
            add('en-gb');
            add('en');
        } else {
            add(normalized);
            add(base);
        }

        return prefixes;
    }

    isGoogleVoice(voice) {
        if (!voice || !voice.name) return false;
        return voice.name.toLowerCase().includes('google');
    }

    isMicrosoftNaturalVoice(voice) {
        if (!voice || !voice.name) return false;
        const name = voice.name.toLowerCase();
        return name.includes('microsoft') && name.includes('natural');
    }

    isPreviewVoice(voice) {
        if (!voice || !voice.name) return false;
        return voice.name.toLowerCase().includes('preview');
    }

    getVoiceKey(voice) {
        if (!voice) return '';
        if (voice.voiceURI) return `uri:${voice.voiceURI}`;
        return `name:${voice.name || ''}|lang:${voice.lang || ''}`;
    }

    getLanguagePreferenceKey(lang) {
        const normalized = (lang || '').toLowerCase();
        if (!normalized) return '';
        const base = normalized.split('-')[0];
        if (base === 'zh') {
            return normalized;
        }
        return base;
    }

    getVoicePreferenceKey(voice) {
        const hasAutoDetect = this.autoDetectToggle && this.autoDetectToggle.checked;
        const lang = hasAutoDetect && this.detectedLang ? this.detectedLang : (voice ? voice.lang : '');
        return this.getLanguagePreferenceKey(lang);
    }

    getStoredVoicePreference(lang) {
        const key = this.getLanguagePreferenceKey(lang);
        if (!key) return '';
        return this.voicePreferences[key] || '';
    }

    findVoiceMatchByKey(matches, voiceKey) {
        if (!voiceKey) return null;
        return matches.find(match => this.getVoiceKey(match.voice) === voiceKey) || null;
    }

    getVoiceFilterBase(lang) {
        if (!lang) return '';
        return String(lang).toLowerCase().split('-')[0];
    }

    voiceMatchesFilter(voice, filterBase) {
        if (!filterBase) return true;
        if (!voice || !voice.lang) return false;
        const normalized = voice.lang.toLowerCase();
        return normalized === filterBase || normalized.startsWith(`${filterBase}-`);
    }

    updateVoiceFilter(lang) {
        const filterBase = this.getVoiceFilterBase(lang);
        if (filterBase === this.voiceFilterLang) return;
        this.voiceFilterLang = filterBase;
        if (this.voices.length === 0) return;
        this.populateVoiceList({ filterLang: filterBase, skipAutoDetect: true });
    }

    clearVoiceFilter() {
        if (!this.voiceFilterLang) return;
        this.voiceFilterLang = '';
        if (this.voices.length === 0) return;
        this.populateVoiceList({ filterLang: '', skipAutoDetect: true });
    }

    getSelectedVoice() {
        if (!this.voiceSelect) return null;
        const index = Number.parseInt(this.voiceSelect.value, 10);
        if (Number.isNaN(index)) return null;
        return this.voices[index] || null;
    }

    updateDetectedLangLabel(lang) {
        if (!this.autoDetectText) return;

        if (!lang || !this.autoDetectToggle || !this.autoDetectToggle.checked) {
            this.autoDetectText.textContent = this.autoDetectLabelText;
            return;
        }

        const label = this.formatLanguageLabel(lang);
        this.autoDetectText.textContent = `Auto-detected: ${label}`;
    }

    updateDocumentLanguage(lang) {
        const html = document.documentElement;
        if (!html) return;
        html.lang = lang || 'en';
    }

    formatLanguageLabel(lang) {
        const base = lang.split('-')[0];
        let name = null;

        if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
            try {
                const displayNames = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
                name = displayNames.of(base);
            } catch (error) {
                name = null;
            }
        }

        if (!name) {
            const fallback = {
                en: 'English',
                es: 'Spanish',
                fr: 'French',
                de: 'German',
                it: 'Italian',
                pt: 'Portuguese',
                ja: 'Japanese',
                ko: 'Korean',
                zh: 'Chinese',
                ru: 'Russian',
                ar: 'Arabic',
                hi: 'Hindi',
                th: 'Thai',
                vi: 'Vietnamese',
                he: 'Hebrew',
                tr: 'Turkish'
            };
            name = fallback[base] || lang;
        }

        return `${name} (${lang})`;
    }

    togglePlayPause() {
        if (!this.isSpeechSupported) return;
        if (this.isPlaying && !this.isPaused) {
            this.handlePause();
        } else {
            this.handlePlay();
        }
    }

    handleRewind() {
        if (!this.isSpeechSupported) return;
        if (!this.isPlaying) return;

        // Cancel any in-flight utterance to avoid stale callbacks.
        this.cancelPlayback();

        // Decrement index (Rewind one section)
        if (this.currentChunkIndex > 0) {
            this.currentChunkIndex--;
        }

        this.saveProgressToStorage();
        this.isPaused = false;
        this.updateButtonsState();
        this.scheduleSpeak();
    }

    handleSkipForward() {
        if (!this.isSpeechSupported) return;
        if (!this.isPlaying) return;

        this.cancelPlayback();

        const lastIndex = Math.max(this.chunks.length - 1, 0);
        if (this.currentChunkIndex < lastIndex) {
            this.currentChunkIndex++;
        } else {
            this.handleStop();
            return;
        }

        this.saveProgressToStorage();
        this.isPaused = false;
        this.updateButtonsState();
        this.scheduleSpeak();
    }

    handlePlay() {
        if (!this.isSpeechSupported) return;
        if (this.isPaused) {
            this.handleResume();
            return;
        }

        const text = this.textInput.value;
        this.applyAutoDetect(text);
        if (!text && this.chunks.length === 0) return;

        if (!this.isPlaying) {
            this.cancelPlayback();
            this.chunks = this.chunkText(text);
            if (this.chunks.length === 0) return;
            const maxIndex = Math.max(this.chunks.length - 1, 0);
            this.currentChunkIndex = Math.min(this.currentChunkIndex, maxIndex);
            this.saveProgressToStorage();
        }

        this.isPlaying = true;
        this.isPaused = false;
        this.updateButtonsState();
        this.setPlayStatus('playing');

        if (this.voices.length === 0) {
            this.voices = this.synth.getVoices();
        }

        this.scheduleSpeak();
    }

    scheduleSpeak() {
        if (!this.synth) return;
        // Wait for any pending/cancelled speech to drain before speaking again.
        const requestId = ++this.speakRequestId;
        if (this.speakTimeoutId) {
            clearTimeout(this.speakTimeoutId);
        }

        const startTime = Date.now();
        const tryStart = () => {
            if (requestId !== this.speakRequestId) return;

            if ((this.synth.speaking || this.synth.pending) && Date.now() - startTime < 500) {
                this.speakTimeoutId = setTimeout(tryStart, 30);
                return;
            }

            if (this.synth.speaking || this.synth.pending) {
                this.synth.cancel();
            }

            this.speakTimeoutId = null;
            this.speakNextChunk();
        };

        this.speakTimeoutId = setTimeout(tryStart, 0);
    }

    speakNextChunk() {
        if (!this.isSpeechSupported || !this.synth) return;
        if (this.currentChunkIndex >= this.chunks.length) {
            this.handleStop();
            return;
        }

        const chunk = this.chunks[this.currentChunkIndex];
        const utterance = new SpeechSynthesisUtterance(chunk);
        const utteranceId = ++this.utteranceIdCounter;

        // Track the active utterance so canceled callbacks can be ignored.
        this.currentUtterance = utterance;
        this.activeUtteranceId = utteranceId;

        const selectedOption = this.voiceSelect.selectedOptions[0];
        if (selectedOption) {
            const voiceIndex = selectedOption.value;
            if (this.voices[voiceIndex]) {
                utterance.voice = this.voices[voiceIndex];
            }
        }

        utterance.rate = 1.0;

        utterance.onstart = () => {
            if (utteranceId !== this.activeUtteranceId || utterance !== this.currentUtterance) {
                return;
            }
            this.updateChunkDisplay(chunk);
        };

        utterance.onend = () => {
            if (utteranceId !== this.activeUtteranceId || utterance !== this.currentUtterance) {
                return;
            }
            if (this.isPlaying && !this.isPaused) {
                this.currentChunkIndex++;
                this.saveProgressToStorage();
                this.speakNextChunk();
            }
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error', event);
            if (utteranceId !== this.activeUtteranceId || utterance !== this.currentUtterance) {
                return;
            }
            if (this.isPlaying && !this.isPaused) {
                this.currentChunkIndex++;
                this.saveProgressToStorage();
                this.speakNextChunk();
            }
        };

        this.synth.speak(utterance);
    }

    handleResume() {
        if (!this.isSpeechSupported) return;
        if (!this.isPaused) return;

        this.isPaused = false;
        this.isPlaying = true;
        this.synth.resume();
        this.updateButtonsState();
        this.setPlayStatus('playing');
    }

    handlePause() {
        if (!this.isSpeechSupported) return;
        if (!this.isPlaying || this.isPaused) return;

        this.isPlaying = true;
        this.isPaused = true;
        this.synth.pause();
        this.updateButtonsState();
        this.setPlayStatus('paused');
    }

    handleStop() {
        if (!this.isSpeechSupported) return;
        this.cancelPlayback();
        this.isPlaying = false;
        this.isPaused = false;
        this.currentChunkIndex = 0;
        this.saveProgressToStorage();

        this.updateChunkDisplay('');

        this.updateButtonsState();
        this.setPlayStatus('stopped');
    }

    cancelPlayback() {
        if (this.speakTimeoutId) {
            clearTimeout(this.speakTimeoutId);
            this.speakTimeoutId = null;
        }
        this.speakRequestId++;
        // Null out handlers so a canceled utterance can't advance the index.
        if (this.currentUtterance) {
            this.currentUtterance.onend = null;
            this.currentUtterance.onerror = null;
            this.currentUtterance = null;
        }
        this.activeUtteranceId = 0;
        if (this.synth) {
            this.synth.cancel();
        }
    }

    updateChunkDisplay(chunk) {
        if (!this.chunkDisplay) return;

        if (chunk) {
            this.chunkDisplay.textContent = chunk;
            this.chunkDisplay.classList.remove('hidden');
        } else {
            this.chunkDisplay.textContent = '';
            this.chunkDisplay.classList.add('hidden');
        }
    }

    updateButtonsState() {
        if (!this.btnPlayPause) return;
        const iconPlay = this.iconPlay || this.btnPlayPause.querySelector('.icon-play');
        const iconPause = this.iconPause || this.btnPlayPause.querySelector('.icon-pause');
        if (!iconPlay || !iconPause) return;

        if (this.isPlaying && !this.isPaused) {
            iconPlay.classList.add('hidden');
            iconPause.classList.remove('hidden');
            this.btnPlayPause.setAttribute('aria-label', 'Pause');
            this.btnStop.disabled = false;
            this.btnRewind.disabled = false;
            if (this.btnForward) this.btnForward.disabled = false;
        } else {
            iconPlay.classList.remove('hidden');
            iconPause.classList.add('hidden');
            this.btnPlayPause.setAttribute('aria-label', 'Play');

            if (this.isPaused) {
                this.btnStop.disabled = false;
                this.btnRewind.disabled = false;
                if (this.btnForward) this.btnForward.disabled = false;
            } else {
                this.btnStop.disabled = true;
                this.btnRewind.disabled = true;
                if (this.btnForward) this.btnForward.disabled = true;
            }
        }
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SpeechApp();
});
