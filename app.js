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

        this.storage = this.getStorage();
        this.storageEnabled = Boolean(this.storage);
        this.storageKeys = {
            text: 'speechApp:text',
            progress: 'speechApp:progress'
        };
        this.lastStoredText = '';

        // DOM elements
        this.textInput = document.getElementById('text-input');
        this.voiceSelect = document.getElementById('voice-select');
        this.autoDetectToggle = document.getElementById('auto-detect');
        this.autoDetectText = document.getElementById('auto-detect-text');
        this.chunkDisplay = document.getElementById('chunk-display');
        this.btnPlayPause = document.getElementById('btn-play-pause');
        this.btnRewind = document.getElementById('btn-rewind');
        this.btnStop = document.getElementById('btn-stop');
        this.iconPlay = this.btnPlayPause ? this.btnPlayPause.querySelector('.icon-play') : null;
        this.iconPause = this.btnPlayPause ? this.btnPlayPause.querySelector('.icon-pause') : null;
        this.autoDetectLabelText = this.autoDetectText ? this.autoDetectText.textContent.trim() : 'Auto-detect language';

        this.init();
    }

    init() {
        // Restore input/progress early so UI reflects last session.
        this.restoreFromStorage();
        this.addEventListeners();
        this.registerServiceWorker();

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
                this.populateVoiceList();
            }, 100);
            return;
        }
        this.populateVoiceList();
    }

    populateVoiceList() {
        this.voiceSelect.innerHTML = '';
        const fragment = document.createDocumentFragment();
        this.voices.forEach((voice, index) => {
            const option = document.createElement('option');
            option.textContent = `${voice.name} (${voice.lang})`;
            option.setAttribute('data-lang', voice.lang);
            option.setAttribute('data-name', voice.name);
            option.value = index;
            if (voice.default) option.selected = true;
            fragment.appendChild(option);
        });
        this.voiceSelect.appendChild(fragment);
        this.applyAutoDetect(this.textInput.value, { force: true });
    }

    addEventListeners() {
        this.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
        this.btnRewind.addEventListener('click', () => this.handleRewind());
        this.btnStop.addEventListener('click', () => this.handleStop());
        this.textInput.addEventListener('input', () => this.handleTextInputChange());
        if (this.autoDetectToggle) {
            this.autoDetectToggle.addEventListener('change', () => this.handleAutoDetectToggle());
        }
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
        if (this.btnStop) this.btnStop.disabled = true;
    }

    registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        });
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

    restoreFromStorage() {
        if (!this.storage) return;

        let storedText = null;
        try {
            storedText = this.storage.getItem(this.storageKeys.text);
        } catch (error) {
            this.storageEnabled = false;
            return;
        }
        if (storedText !== null) {
            this.textInput.value = storedText;
            this.lastStoredText = storedText;
        } else {
            this.lastStoredText = this.textInput.value;
        }

        let storedProgress = null;
        try {
            storedProgress = this.storage.getItem(this.storageKeys.progress);
        } catch (error) {
            this.storageEnabled = false;
            return;
        }
        if (!storedProgress) return;

        try {
            const parsed = JSON.parse(storedProgress);
            if (parsed && parsed.text === this.textInput.value && Number.isFinite(parsed.index)) {
                this.currentChunkIndex = Math.max(0, parsed.index);
            }
        } catch (error) {
            return;
        }
    }

    saveContentToStorage(text) {
        this.safeSetItem(this.storageKeys.text, text);
    }

    saveProgressToStorage() {
        const payload = {
            text: this.textInput.value,
            index: this.currentChunkIndex
        };
        this.safeSetItem(this.storageKeys.progress, JSON.stringify(payload));
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
            this.lastStoredText = currentText;
            this.saveContentToStorage(currentText);
            this.currentChunkIndex = 0;
            this.chunks = [];
            this.updateChunkDisplay('');
            this.saveProgressToStorage();

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

        if (!this.autoDetectToggle || !this.autoDetectToggle.checked) return;

        if (this.detectTimeoutId) {
            clearTimeout(this.detectTimeoutId);
        }

        this.detectTimeoutId = setTimeout(() => {
            this.detectTimeoutId = null;
            this.applyAutoDetect(this.textInput.value);
        }, 200);
    }

    handleAutoDetectToggle() {
        if (!this.autoDetectToggle) return;

        if (this.autoDetectToggle.checked) {
            this.applyAutoDetect(this.textInput.value, { force: true });
        } else {
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

    applyAutoDetect(text, { force = false } = {}) {
        if (!this.autoDetectToggle || !this.autoDetectToggle.checked) {
            this.updateDetectedLangLabel('');
            return;
        }

        const lang = this.detectLanguage(this.prepareSpeechText(text));
        if (!lang) {
            this.updateDetectedLangLabel('');
            return;
        }

        this.updateDetectedLangLabel(lang);

        if (this.voices.length === 0) {
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

    detectLanguage(text) {
        // Script-first detection, then fall back to diacritics/keywords.
        const sample = (text || '').trim().slice(0, 4000);
        if (!sample) return null;

        if (/[\u3040-\u309f\u30a0-\u30ff]/.test(sample)) {
            return 'ja';
        }
        if (/[\uac00-\ud7af]/.test(sample)) {
            return 'ko';
        }
        if (/[\u3100-\u312f]/.test(sample)) {
            return 'zh-TW';
        }
        if (/[\u4e00-\u9fff]/.test(sample)) {
            return this.detectChineseVariant(sample);
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
                return check.lang;
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
            return bestLang;
        }

        return navigator.language || 'en-US';
    }

    detectChineseVariant(text) {
        // Simple heuristic: count traditional vs simplified characters.
        const sample = (text || '').slice(0, 4000);
        const { traditionalChars, simplifiedChars } = this.getChineseCharSets();
        let tradCount = 0;
        let simpCount = 0;

        for (const char of sample) {
            if (traditionalChars.has(char)) tradCount += 1;
            if (simplifiedChars.has(char)) simpCount += 1;
        }

        if (tradCount === 0 && simpCount === 0) {
            const locale = navigator.language || '';
            if (locale.toLowerCase().startsWith('zh-tw') || locale.toLowerCase().startsWith('zh-hk')) {
                return 'zh-TW';
            }
            return 'zh-CN';
        }

        if (tradCount > simpCount) {
            return 'zh-TW';
        }

        return 'zh-CN';
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

        const matches = this.getVoiceMatchesForLanguage(lang);
        if (matches.length === 0) return false;

        const googleMatches = matches.filter(match => match.isGoogle);
        const pickBest = (items) => {
            if (items.length === 0) return null;
            return items.sort((a, b) => {
                if (a.rank !== b.rank) return a.rank - b.rank;
                if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
                return 0;
            })[0];
        };

        const selection = pickBest(googleMatches) || pickBest(matches);
        if (!selection) return false;

        this.voiceSelect.value = String(selection.index);
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
                isGoogle: this.isGoogleVoice(voice),
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

        add(normalized);

        if (base === 'zh') {
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
        } else {
            add(base);
        }

        return prefixes;
    }

    isGoogleVoice(voice) {
        if (!voice || !voice.name) return false;
        return voice.name.toLowerCase().includes('google');
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
    }

    handlePause() {
        if (!this.isSpeechSupported) return;
        if (!this.isPlaying || this.isPaused) return;

        this.isPlaying = true;
        this.isPaused = true;
        this.synth.pause();
        this.updateButtonsState();
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
        } else {
            iconPlay.classList.remove('hidden');
            iconPause.classList.add('hidden');
            this.btnPlayPause.setAttribute('aria-label', 'Play');

            if (this.isPaused) {
                this.btnStop.disabled = false;
                this.btnRewind.disabled = false;
            } else {
                this.btnStop.disabled = true;
                this.btnRewind.disabled = true;
            }
        }
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SpeechApp();
});
