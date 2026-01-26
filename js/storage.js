export const storageMethods = {
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
    },

    createDefaultSlot() {
        return {
            text: '',
            progress: 0,
            playStatus: 'stopped'
        };
    },

    createDefaultSlots() {
        return Array.from({ length: this.slotCount }, () => this.createDefaultSlot());
    },

    normalizeSlotNumber(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return 1;
        if (parsed < 1 || parsed > this.slotCount) return 1;
        return parsed;
    },

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
    },

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

        // Normalize stored slots to the current slotCount.
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
    },

    cleanupLegacyStorage() {
        if (!this.storage) return;
        try {
            if (!this.storage.getItem(this.storageKeys.slots)) return;
            this.storage.removeItem('speechApp:text');
            this.storage.removeItem('speechApp:progress');
        } catch (error) {
            this.storageEnabled = false;
        }
    },

    saveSlotsToStorage() {
        this.safeSetItem(this.storageKeys.slots, JSON.stringify(this.slots));
    },

    getSlotState(slotNumber) {
        const normalized = this.normalizeSlotNumber(slotNumber);
        return this.slots[normalized - 1] || null;
    },

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
    },

    persistActiveSlotState(statusOverride) {
        if (!this.textInput) return;
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.text = this.textInput.value;
        slot.progress = this.currentChunkIndex;
        slot.playStatus = statusOverride || this.getCurrentPlayStatus();
        this.saveSlotsToStorage();
    },

    updateSlotButtons() {
        if (this.slotButtons.length === 0) return;
        this.slotButtons.forEach((button) => {
            const slot = Number.parseInt(button.getAttribute('data-slot'), 10);
            const isActive = slot === this.activeSlot;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    },

    getCurrentPlayStatus() {
        if (this.isPlaying && !this.isPaused) return 'playing';
        if (this.isPaused) return 'paused';
        return 'stopped';
    },

    setPlayStatus(status) {
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.playStatus = status;
        this.saveSlotsToStorage();
    },

    stopPlaybackForSlotSwitch() {
        if (!this.isPlaying && !this.isPaused) return;
        this.cancelPlayback();
        this.isPlaying = false;
        this.isPaused = false;
        this.updateButtonsState();
        this.updateChunkDisplay('');
    },

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
    },

    restoreFromStorage() {
        if (!this.storage) return;
        this.loadSlotsFromStorage();
        this.cleanupLegacyStorage();
        this.applySlotState(this.activeSlot);
        this.loadVoicePreferences();
    },

    saveContentToStorage(text) {
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.text = text;
        this.saveSlotsToStorage();
    },

    saveProgressToStorage() {
        const slot = this.getSlotState(this.activeSlot);
        if (!slot) return;
        slot.progress = this.currentChunkIndex;
        this.saveSlotsToStorage();
    },

    safeSetItem(key, value) {
        if (!this.storage || !this.storageEnabled) return;
        try {
            this.storage.setItem(key, value);
        } catch (error) {
            this.storageEnabled = false;
        }
    }
};
