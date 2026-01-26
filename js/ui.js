export const uiMethods = {
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
    },

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
    },

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
    },

    isTypingTarget(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        const tagName = target.tagName ? target.tagName.toLowerCase() : '';
        return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
    },

    isInteractiveTarget(target) {
        if (!target || !target.closest) return false;
        // Covers buttons, links, and custom button roles (e.g., slot buttons).
        return Boolean(target.closest('button, a, [role="button"]'));
    },

    isActiveSlotButtonTarget(target) {
        if (!target || !target.closest) return false;
        return Boolean(target.closest('.slot-button.is-active'));
    },

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
    },

    registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        window.addEventListener('load', () => {
            navigator.serviceWorker
                .register('./sw.js')
                .then((registration) => this.enableServiceWorkerUpdates(registration))
                .catch(() => {});
        });
    },

    enableServiceWorkerUpdates(registration) {
        if (!registration || typeof registration.update !== 'function') return;
        const updateRegistration = () => {
            registration.update().catch(() => {});
        };
        updateRegistration();
        window.addEventListener('online', updateRegistration);
    },

    updateChromeTipVisibility() {
        if (!this.chromeTip) return;
        this.chromeTip.hidden = this.isChromeBrowser();
    },

    resetClearConfirm() {
        if (!this.isClearConfirm) return;
        this.isClearConfirm = false;
        if (this.clearConfirmTimeoutId) {
            clearTimeout(this.clearConfirmTimeoutId);
            this.clearConfirmTimeoutId = null;
        }
        this.clearConfirmStartedAt = 0;
        this.clearConfirmRemainingMs = 0;
    },

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
    },

    pauseClearConfirmTimer() {
        if (!this.isClearConfirm || !this.clearConfirmTimeoutId) return;
        // Preserve remaining time so hover/focus doesn't burn the countdown.
        const elapsed = Date.now() - this.clearConfirmStartedAt;
        this.clearConfirmRemainingMs = Math.max(0, this.clearConfirmRemainingMs - elapsed);
        clearTimeout(this.clearConfirmTimeoutId);
        this.clearConfirmTimeoutId = null;
        this.clearConfirmStartedAt = 0;
    },

    resumeClearConfirmTimer() {
        if (!this.isClearConfirm || this.clearConfirmTimeoutId) return;
        // Resume from the remaining time.
        if (this.clearConfirmRemainingMs <= 0) {
            this.resetClearConfirm();
            this.updatePasteButtonState();
            return;
        }
        this.scheduleClearConfirmTimeout(this.clearConfirmRemainingMs);
    },

    startClearConfirm() {
        this.isClearConfirm = true;
        // Give the user a short window to confirm clearing.
        this.scheduleClearConfirmTimeout(5000);
        this.updatePasteButtonState();
    },

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
    },

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
    },

    // Drag/drop support: accept a single .txt/.md file only when the textarea is empty.
    handleTextDragEnter(event) {
        if (!event || !this.textInput) return;
        if (!this.hasFileDrop(event)) return;
        event.preventDefault();
        const canAccept = this.canAcceptTextDrop(event);
        this.setDropTargetState(canAccept, !canAccept);
    },

    handleTextDragOver(event) {
        if (!event || !this.textInput) return;
        if (!this.hasFileDrop(event)) return;
        event.preventDefault();
        const canAccept = this.canAcceptTextDrop(event);
        this.setDropTargetState(canAccept, !canAccept);
        event.dataTransfer.dropEffect = canAccept ? 'copy' : 'none';
    },

    handleTextDragLeave(event) {
        if (!event || !this.textInput) return;
        this.setDropTargetState(false, false);
    },

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
    },

    setDropTargetState(isActive, isBlocked) {
        if (!this.textInput) return;
        this.textInput.classList.toggle('is-drop-target', isActive);
        this.textInput.classList.toggle('is-drop-blocked', isBlocked);
    },

    hasFileDrop(event) {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return false;
        const types = Array.from(dataTransfer.types || []);
        if (types.includes('Files')) return true;
        const items = Array.from(dataTransfer.items || []);
        if (items.some((item) => item.kind === 'file')) return true;
        const files = Array.from(dataTransfer.files || []);
        return files.length > 0;
    },

    canAcceptTextDrop(event) {
        if (!event || !this.textInput) return false;
        if (this.textInput.value.length > 0) return false;
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return false;
        const items = Array.from(dataTransfer.items || []).filter((item) => item.kind === 'file');
        const files = Array.from(dataTransfer.files || []);
        const fileCount = files.length || items.length;
        if (fileCount > 1) return false;
        const candidate = files[0] || items[0];
        if (candidate && candidate.name && !this.isAllowedDropName(candidate.name)) return false;
        if (candidate && candidate.type && !this.isAllowedDropMime(candidate.type)) return false;
        return true;
    },

    getDropTextFile(event) {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return null;
        const files = Array.from(dataTransfer.files || []);
        if (files.length !== 1) return null;
        const file = files[0];
        if (!this.isAllowedDropName(file.name)) return null;
        if (file.type && !this.isAllowedDropMime(file.type)) return null;
        return file;
    },

    isAllowedDropMime(mimeType) {
        if (!mimeType) return false;
        return mimeType === 'text/plain' || mimeType === 'text/markdown';
    },

    isAllowedDropName(fileName) {
        if (!fileName) return false;
        const lower = fileName.toLowerCase();
        return lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.markdown');
    },

    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('File read failed'));
            reader.readAsText(file);
        });
    },

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
    },

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

        // Debounced language detection while typing.
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
};
