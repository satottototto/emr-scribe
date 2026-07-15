'use strict';

/*
 * EMR Scribe — low-latency handwriting for E-Ink + Wacom EMR devices.
 *
 * Design constraints (Bigme S6 Color+ Lite class hardware):
 *  - No framework. No per-point state updates. No full-scene redraw while inking.
 *  - Canvas 2D with { desynchronized: true } so strokes bypass the WebView
 *    compositor queue where the platform supports it (mobile only by default:
 *    some Windows GPUs render nothing with a desynchronized canvas).
 *  - pointerrawupdate (when available) + getCoalescedEvents() so every EMR
 *    sample (~140Hz+) lands on the canvas, not just one per vsync.
 *  - Full redraws only on load / undo / erase — never during a stroke,
 *    because full-canvas invalidation is what makes E-Ink flash.
 *  - touch-action: none everywhere. Android treats a stylus as a direct
 *    manipulation pointer, so any allowed pan gesture (pan-y) hijacks the pen
 *    and cancels the stroke. Finger panning is implemented manually instead,
 *    which also gives us real palm rejection (ignore touches while the pen
 *    is in use or was seen recently).
 */

const {
	Plugin,
	TextFileView,
	PluginSettingTab,
	Setting,
	Notice,
	TFile,
	Platform,
	normalizePath,
	requestUrl,
	setIcon,
} = require('obsidian');

const VIEW_TYPE = 'emr-scribe-view';
const FILE_EXT = 'scribe';

// Touches that begin within this window after the last pen event are palms.
const PALM_WINDOW_MS = 800;
const AUTO_OCR_DELAY_MS = 1800;

// ---------- i18n ----------

const TR = {
	en: {
		ribbon: 'New handwriting note (Scribe)',
		cmdNew: 'Create new handwriting note',
		cmdNewEmbed: 'Create handwriting note and embed at cursor',
		pen: 'Pen',
		marker: 'Marker',
		eraser: 'Eraser',
		undo: 'Undo',
		redo: 'Redo',
		clearAll: 'Erase all',
		addPage: 'Add page',
		ocrBtn: 'Recognize now (only changed lines are sent)',
		reocrBtn: 'Re-recognize everything (ignore cache)',
		ocrAutoBtn: 'Toggle automatic recognition',
		thickness: 'Thickness',
		color: 'Color',
		opacity: 'Opacity',
		copy: 'Copy',
		copied: 'Copied',
		confirmClear: 'Erase all strokes?',
		noStrokes: 'Nothing to recognize',
		notRecognized: 'No text recognized',
		ocrFailed: 'OCR failed: ',
		pageAdded: 'Page added ({n} pages)',
		pageLimit: 'Cannot add more pages (canvas size limit)',
		endpointMissing: 'Set the OCR endpoint URL in the plugin settings',
		embedNeedFile: 'scribe: specify "file: <path>"',
		embedNotFound: 'scribe: file not found: ',
		embedBroken: 'scribe: cannot read file: ',
		embedHint: ' (tap to edit)',
		setFolder: 'New file folder',
		setFolderDesc: 'Vault folder where new .scribe files are created',
		setPageSize: 'Page width / height (px)',
		setPageSizeDesc: 'Logical size of new pages. 1404×1872 matches Bigme S6-class screens',
		setScale: 'Canvas resolution scale',
		setScaleDesc: '0.5–1.0. Lower is lighter to draw (barely visible on E-Ink at 0.75)',
		setPenOnly: 'Fingers scroll only (pen and mouse always draw)',
		setPenOnlyDesc:
			'Recommended ON. Touches while — or shortly after — using the pen are ignored as palm input. OFF lets fingers draw too',
		setPressure: 'Pressure changes stroke width',
		setPressureDesc: 'Pen only. Markers always keep a constant width',
		setPrediction: 'Draw predicted point',
		setPredictionDesc: 'Lowers perceived latency. Turn off if ghosting bothers you',
		setDesync: 'Low-latency canvas (desynchronized)',
		setDesyncDesc:
			'"Auto" enables it on mobile only (recommended). Some Windows GPUs render nothing when forced ON',
		optAuto: 'Auto (mobile only)',
		optOn: 'Always on',
		optOff: 'Off',
		headOcr: 'Handwriting recognition (OCR)',
		setAutoOcr: 'Auto recognition',
		setAutoOcrDesc:
			'Recognize about 2 s after you stop writing and keep the text below the handwriting (also toggleable from the toolbar)',
		setEngine: 'Recognition engine',
		setEngineDesc:
			'Built-in (Google handwriting): recognizes stroke coordinates — strong for handwriting, no API key, needs network. Note that stroke data is sent to Google servers. Custom HTTP: send the page image to your own OCR server',
		optGoogle: 'Built-in (Google handwriting)',
		optEndpoint: 'Custom HTTP endpoint',
		setLang: 'Recognition language',
		setLangDesc: 'For the built-in engine. Japanese mode also recognizes some English words',
		optJa: 'Japanese',
		optEn: 'English',
		setEndpoint: 'Custom HTTP endpoint URL',
		setEndpointDesc:
			'HTTP API returning {"text": "..."} for POST {"image": "<base64 PNG>"} (used only with the Custom engine)',
		setHud: 'Show debug HUD',
		setHudDesc: 'Shows input events/s and draw time in the toolbar (for tuning)',
	},
	ja: {
		ribbon: '新規手書きノート (Scribe)',
		cmdNew: '新規手書きノートを作成',
		cmdNewEmbed: '新規手書きノートを作成してカーソル位置に埋め込み',
		pen: 'ペン',
		marker: 'マーカー',
		eraser: '消しゴム',
		undo: '元に戻す',
		redo: 'やり直す',
		clearAll: '全消去',
		addPage: 'ページ追加',
		ocrBtn: '今すぐ認識（変更行のみ送信）',
		reocrBtn: '全体を再認識（キャッシュ無視）',
		ocrAutoBtn: '自動認識の切り替え',
		thickness: '太さ',
		color: '色',
		opacity: '透明度',
		copy: 'コピー',
		copied: 'コピーしました',
		confirmClear: 'すべてのストロークを消去しますか？',
		noStrokes: 'ストロークがありません',
		notRecognized: 'テキストを認識できませんでした',
		ocrFailed: 'OCR失敗: ',
		pageAdded: 'ページを追加しました（全{n}ページ）',
		pageLimit: 'これ以上ページを追加できません（キャンバスの上限）',
		endpointMissing: '設定でOCRエンドポイントURLを指定してください',
		embedNeedFile: 'scribe: 「file: <パス>」を指定してください',
		embedNotFound: 'scribe: ファイルが見つかりません: ',
		embedBroken: 'scribe: ファイルを読めません: ',
		embedHint: '（タップで編集）',
		setFolder: '保存フォルダ',
		setFolderDesc: '新規 .scribe ファイルを作成するVault内フォルダ',
		setPageSize: 'ページ幅 / 高さ (px)',
		setPageSizeDesc: '新規ページの論理サイズ。Bigme S6系は 1404×1872 が実寸相当',
		setScale: 'キャンバス解像度スケール',
		setScaleDesc: '0.5〜1.0。下げるほど描画が軽くなる（E-Inkでは0.75でも見た目の差が小さい）',
		setPenOnly: '指はスクロール専用（ペン・マウスは常に描画）',
		setPenOnlyDesc:
			'ON推奨。ペン使用中や直後のタッチはパームとして無視される。OFFにすると指でも描画',
		setPressure: '筆圧で線幅を変える',
		setPressureDesc: 'ペンのみ。マーカーは常に一定幅',
		setPrediction: '予測点の先行描画',
		setPredictionDesc: '体感遅延を下げる。ゴーストが気になる場合はOFF',
		setDesync: '低遅延Canvas (desynchronized)',
		setDesyncDesc:
			'「自動」=タブレット/スマホのみ有効（推奨）。WindowsのGPUによっては「オン」で描画が表示されなくなる場合がある',
		optAuto: '自動（モバイルのみ）',
		optOn: '常にオン',
		optOff: 'オフ',
		headOcr: '手書き認識（OCR）',
		setAutoOcr: '自動認識',
		setAutoOcrDesc:
			'書き終わって約2秒後に自動で認識し、手書きの下にテキストを挿入・更新する（ツールバーからも切替可）',
		setEngine: '認識エンジン',
		setEngineDesc:
			'内蔵（Google手書き認識）: ストローク座標を認識するため手書きに強い。APIキー不要・要ネット接続。ストロークデータがGoogleのサーバへ送信される点に注意。カスタムHTTP: 自前のOCRサーバに画像を送る',
		optGoogle: '内蔵（Google手書き認識）',
		optEndpoint: 'カスタムHTTPエンドポイント',
		setLang: '認識言語',
		setLangDesc: '内蔵エンジン用。日本語モードでも英単語はある程度認識される',
		optJa: '日本語',
		optEn: '英語',
		setEndpoint: 'カスタムHTTPエンドポイントURL',
		setEndpointDesc:
			'POST {"image": "<base64 PNG>"} → {"text": "..."} を返すHTTP API（認識エンジンで「カスタム」を選んだ場合のみ使用）',
		setHud: 'デバッグHUD表示',
		setHudDesc: 'ツールバーに 入力イベント数/秒 と描画時間を表示（チューニング用）',
	},
};

const OBSIDIAN_LANG = window.localStorage.getItem('language') || 'en';
const LANG = TR[OBSIDIAN_LANG] ? OBSIDIAN_LANG : 'en';

function t(key) {
	return (TR[LANG] && TR[LANG][key]) || TR.en[key] || key;
}

// ---------- settings / data ----------

const DEFAULT_SETTINGS = {
	folder: 'Scribe',
	pageWidth: 1404,
	pageHeight: 1872,
	canvasScale: 1.0,
	penOnly: true,
	usePressure: true,
	usePrediction: true,
	desyncCanvas: 'auto', // 'auto' = mobile only / 'on' / 'off'
	ocrProvider: 'google', // 'google' (built-in stroke recognition) | 'endpoint'
	ocrLanguage: 'ja',
	ocrEndpoint: '',
	autoOcr: false,
	showDebugHud: false,
	penStyle: { c: '#000000', w: 3, o: 1 },
	markerStyle: { c: '#f1c40f', w: 16, o: 0.45 },
};

const PALETTE = ['#000000', '#5f6368', '#c0392b', '#e67e22', '#1a4f9c', '#1e8449', '#f1c40f'];
const PEN_WIDTHS = [1.5, 2.5, 3.5, 5, 7];
const MARKER_WIDTHS = [8, 12, 16, 24, 32];

function newDocData(settings) {
	return {
		version: 1,
		width: settings.pageWidth,
		height: settings.pageHeight,
		strokes: [],
		ocr: null,
	};
}

function round1(n) {
	return Math.round(n * 10) / 10;
}

function strokeWidthFor(base, pressure, usePressure) {
	if (!usePressure || !(pressure > 0)) return base;
	return base * (0.35 + 1.5 * pressure);
}

function avgStrokeWidth(stroke, usePressure) {
	if (!usePressure || !stroke.p.length) return stroke.w;
	let sum = 0;
	for (const pt of stroke.p) sum += pt[2] || 0.5;
	return strokeWidthFor(stroke.w, sum / stroke.p.length, true);
}

/** A stroke that must be rendered as ONE path (alpha blending would darken
 *  segment joints if drawn segment-by-segment). */
function isFlatStroke(s) {
	return (s.o != null && s.o < 1) || s.t === 'marker';
}

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
function segDist(px, py, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx, cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy);
}

function docToSvg(doc) {
	const parts = [];
	for (const s of doc.strokes || []) {
		if (!s.p || !s.p.length) continue;
		const o = s.o != null ? s.o : 1;
		const w = round1(isFlatStroke(s) ? s.w : avgStrokeWidth(s, true));
		let d = `M${s.p[0][0]} ${s.p[0][1]}`;
		if (s.p.length === 1) {
			d += `L${s.p[0][0] + 0.01} ${s.p[0][1]}`;
		} else {
			for (let i = 1; i < s.p.length; i++) d += `L${s.p[i][0]} ${s.p[i][1]}`;
		}
		const op = o < 1 ? ` stroke-opacity="${o}"` : '';
		parts.push(
			`<path d="${d}" fill="none" stroke="${s.c}"${op} stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
		);
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}" ` +
		`class="emr-scribe-svg">${parts.join('')}</svg>`
	);
}

// ---------- recognition ----------

/**
 * Group strokes into horizontal text lines, top-to-bottom.
 * Vertical gaps up to ~half a character height stay in the same line, so
 * multi-stroke characters like 二/三 aren't split; the recognizer merges all
 * ink in one request into a single line, so this segmentation is required.
 * Strokes are matched against every existing line (nearest wins), so going
 * back to add a mark to an earlier line still works.
 */
function clusterLines(strokes, pageWidth) {
	const baseTol = Math.max(35, pageWidth * 0.035);
	// Cap the merge tolerance: without it one tall stroke (a bracket, an
	// arrow, a sketch) chain-merges every following line into a single giant
	// "line" whose recognition then fails for everything below it.
	const maxTol = pageWidth * 0.12;
	const lines = [];
	for (const s of strokes) {
		if (!s.p || !s.p.length) continue;
		let minY = Infinity, maxY = -Infinity;
		for (const pt of s.p) {
			if (pt[1] < minY) minY = pt[1];
			if (pt[1] > maxY) maxY = pt[1];
		}
		let best = null, bestGap = Infinity;
		for (const line of lines) {
			const gap = Math.max(line.minY - maxY, minY - line.maxY, 0);
			const tol = Math.min(
				maxTol,
				Math.max(baseTol, 0.6 * Math.max(line.maxY - line.minY, maxY - minY))
			);
			if (gap <= tol && gap < bestGap) {
				best = line;
				bestGap = gap;
			}
		}
		if (best) {
			best.strokes.push(s);
			best.minY = Math.min(best.minY, minY);
			best.maxY = Math.max(best.maxY, maxY);
		} else {
			lines.push({ minY, maxY, strokes: [s] });
		}
	}
	lines.sort((a, b) => a.minY - b.minY);
	return lines.map((l) => l.strokes);
}

/** Cheap identity key for a line's strokes — used to cache recognition
 *  results so auto-OCR only re-sends lines that actually changed. */
function lineKey(line) {
	let k = String(line.length);
	for (const s of line) {
		const p = s.p;
		const a = p[0], b = p[p.length - 1];
		k += `|${p.length},${a[0]},${a[1]},${b[0]},${b[1]}`;
	}
	return k;
}

/**
 * Google handwriting recognition (same engine as Google Translate's
 * handwriting input; no API key). Takes raw stroke coordinates — far more
 * accurate for handwriting than image OCR. Sends ink to Google's servers.
 */
async function recognizeGoogleInk(lineStrokes, lang) {
	// Normalize the line to its own origin: the recognizer is designed for a
	// single-line input box, so a small writing area around the actual ink is
	// more reliable than page-absolute coordinates on a tall multi-page canvas.
	const M = 20;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const s of lineStrokes) {
		for (const pt of s.p) {
			if (pt[0] < minX) minX = pt[0];
			if (pt[0] > maxX) maxX = pt[0];
			if (pt[1] < minY) minY = pt[1];
			if (pt[1] > maxY) maxY = pt[1];
		}
	}
	const ink = lineStrokes.map((s) => {
		const xs = [], ys = [], ts = [];
		s.p.forEach((pt, i) => {
			xs.push(Math.round(pt[0] - minX + M));
			ys.push(Math.round(pt[1] - minY + M));
			ts.push(pt[3] != null ? pt[3] : i * 15);
		});
		return [xs, ys, ts];
	});
	const body = {
		options: 'enable_pre_space',
		requests: [
			{
				writing_guide: {
					writing_area_width: Math.round(maxX - minX + 2 * M),
					writing_area_height: Math.round(maxY - minY + 2 * M),
				},
				ink,
				language: lang,
			},
		],
	};
	const res = await requestUrl({
		url: 'https://inputtools.google.com/request?ime=handwriting&app=obsidian&cs=1&oe=UTF-8',
		method: 'POST',
		contentType: 'application/json',
		body: JSON.stringify(body),
	});
	const j = res.json;
	if (!Array.isArray(j) || j[0] !== 'SUCCESS') {
		throw new Error('bad response: ' + JSON.stringify(j).slice(0, 120));
	}
	const candidates = j[1] && j[1][0] && j[1][0][1];
	return candidates && candidates.length ? candidates[0] : '';
}

// ---------- view ----------

class ScribeView extends TextFileView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.docData = null;
		this.redoStack = [];
		this.active = null; // in-progress stroke
		this.activePointerId = null;
		this.strokeT0 = null;
		this.erasing = false;
		this.tool = 'pen'; // 'pen' | 'marker' | 'eraser'
		this.panelTool = null;
		// finger pan state
		this.panPointerId = null;
		this.panStartY = 0;
		this.panStartTop = 0;
		this.lastPenTime = -1e9;
		this.domReady = false;
		this.ocrTimer = null;
		this.ocrBusy = false;
		this.ocrPending = false;
		this.ocrCache = new Map(); // lineKey → recognized text
		// debug HUD counters
		this.dbgEvents = 0;
		this.dbgDrawMs = 0;
		this.dbgTimer = null;
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return this.file ? this.file.basename : 'Scribe';
	}
	getIcon() {
		return 'pencil';
	}

	getViewData() {
		return JSON.stringify(this.docData || newDocData(this.plugin.settings));
	}

	setViewData(data) {
		try {
			this.docData = JSON.parse(data);
		} catch (e) {
			this.docData = newDocData(this.plugin.settings);
		}
		if (!this.docData.strokes) this.docData.strokes = [];
		this.redoStack = [];
		if (this.domReady) {
			this.resizeCanvases();
			this.fullRedraw();
			this.updateTextPane();
		}
	}

	clear() {
		this.docData = null;
	}

	async onOpen() {
		this.buildDom();
		this.domReady = true;
		if (this.docData) {
			this.resizeCanvases();
			this.fullRedraw();
			this.updateTextPane();
		}
	}

	async onClose() {
		if (this.dbgTimer) window.clearInterval(this.dbgTimer);
		if (this.ocrTimer) window.clearTimeout(this.ocrTimer);
		if (this.textSaveTimer) {
			// flush a pending text edit before the view goes away
			window.clearTimeout(this.textSaveTimer);
			this.textSaveTimer = null;
			if (this.docData && this.textBody) {
				this.docData.ocr = { text: this.textBody.value, at: new Date().toISOString() };
			}
		}
	}

	currentStyle() {
		return this.tool === 'marker'
			? this.plugin.settings.markerStyle
			: this.plugin.settings.penStyle;
	}

	// ---------- DOM ----------

	iconBtn(parent, icon, label) {
		const b = parent.createEl('button', { cls: 'emr-scribe-btn' });
		setIcon(b, icon);
		b.setAttribute('aria-label', label);
		return b;
	}

	buildDom() {
		const root = this.contentEl;
		root.empty();
		root.addClass('emr-scribe-root');

		const bar = root.createDiv({ cls: 'emr-scribe-toolbar' });

		this.penBtn = this.iconBtn(bar, 'pencil', t('pen'));
		this.markerBtn = this.iconBtn(bar, 'highlighter', t('marker'));
		this.eraserBtn = this.iconBtn(bar, 'eraser', t('eraser'));
		this.penBtn.addEventListener('click', () => this.selectTool('pen'));
		this.markerBtn.addEventListener('click', () => this.selectTool('marker'));
		this.eraserBtn.addEventListener('click', () => this.selectTool('eraser'));

		bar.createDiv({ cls: 'emr-scribe-sep' });

		const undoBtn = this.iconBtn(bar, 'undo-2', t('undo'));
		undoBtn.addEventListener('click', () => this.undo());
		const redoBtn = this.iconBtn(bar, 'redo-2', t('redo'));
		redoBtn.addEventListener('click', () => this.redo());
		const clearBtn = this.iconBtn(bar, 'eraser', t('clearAll'));
		clearBtn.createSpan({ text: 'ALL', cls: 'emr-scribe-btn-sub' });
		clearBtn.addEventListener('click', () => {
			if (!this.docData.strokes.length) return;
			if (window.confirm(t('confirmClear'))) {
				this.docData.strokes = [];
				this.redoStack = [];
				this.fullRedraw();
				this.requestSave();
				this.scheduleAutoOcr();
			}
		});

		const addPageBtn = this.iconBtn(bar, 'file-plus', t('addPage'));
		addPageBtn.addEventListener('click', () => this.addPage());

		bar.createDiv({ cls: 'emr-scribe-sep' });

		const ocrBtn = bar.createEl('button', { text: 'OCR', cls: 'emr-scribe-btn' });
		ocrBtn.setAttribute('aria-label', t('ocrBtn'));
		ocrBtn.addEventListener('click', () => this.runOcr(true));

		const reocrBtn = bar.createEl('button', { cls: 'emr-scribe-btn' });
		reocrBtn.createSpan({ text: 'Re', cls: 'emr-scribe-btn-sub' });
		reocrBtn.createSpan({ text: 'OCR' });
		reocrBtn.setAttribute('aria-label', t('reocrBtn'));
		reocrBtn.addEventListener('click', () => {
			this.ocrCache.clear();
			this.runOcr(true);
		});

		this.autoOcrBtn = bar.createEl('button', { cls: 'emr-scribe-btn' });
		this.autoOcrBtn.createSpan({ text: 'Auto' });
		this.autoStateEl = this.autoOcrBtn.createSpan({ text: '○', cls: 'emr-scribe-btn-sub' });
		this.autoOcrBtn.setAttribute('aria-label', t('ocrAutoBtn'));
		this.autoOcrBtn.addEventListener('click', async () => {
			this.plugin.settings.autoOcr = !this.plugin.settings.autoOcr;
			await this.plugin.saveSettings();
			this.refreshToolbar();
			if (this.plugin.settings.autoOcr) this.scheduleAutoOcr();
		});

		if (this.plugin.settings.showDebugHud) {
			this.hudEl = bar.createSpan({ cls: 'emr-scribe-hud', text: '—' });
			this.dbgTimer = window.setInterval(() => this.updateHud(), 500);
		}

		this.panelEl = root.createDiv({ cls: 'emr-scribe-panel' });
		this.panelEl.style.display = 'none';

		this.scrollEl = root.createDiv({ cls: 'emr-scribe-scroll' });
		this.wrapEl = this.scrollEl.createDiv({ cls: 'emr-scribe-canvas-wrap' });
		this.canvas = this.wrapEl.createEl('canvas', { cls: 'emr-scribe-canvas' });
		this.overlay = this.wrapEl.createEl('canvas', { cls: 'emr-scribe-overlay' });

		// The OCR text lives directly under the handwriting, selectable.
		this.textPane = this.scrollEl.createDiv({ cls: 'emr-scribe-textpane' });
		this.textPane.style.display = 'none';
		const copyBtn = this.iconBtn(this.textPane, 'copy', t('copy'));
		copyBtn.addClass('emr-scribe-copybtn');
		copyBtn.addEventListener('click', async () => {
			const txt = this.docData && this.docData.ocr && this.docData.ocr.text;
			if (txt) {
				await navigator.clipboard.writeText(txt);
				new Notice(t('copied'));
			}
		});
		// Editable plain text: user corrections are saved back into the file.
		// Note that a later OCR pass overwrites the whole text again.
		this.textBody = this.textPane.createEl('textarea', { cls: 'emr-scribe-textpane-body' });
		this.textBody.addEventListener('input', () => {
			this.autoGrowTextPane();
			if (this.textSaveTimer) window.clearTimeout(this.textSaveTimer);
			this.textSaveTimer = window.setTimeout(() => {
				this.textSaveTimer = null;
				if (!this.docData) return;
				this.docData.ocr = { text: this.textBody.value, at: new Date().toISOString() };
				this.requestSave();
			}, 600);
		});

		// touch-action must be 'none': Android lets the STYLUS trigger pan
		// gestures too, which cancels strokes mid-write. Finger panning is
		// handled manually in the pointer handlers instead.
		this.canvas.style.touchAction = 'none';

		this.bindPointerEvents();
		this.refreshToolbar();
	}

	selectTool(tool) {
		if (this.tool === tool && (tool === 'pen' || tool === 'marker')) {
			this.togglePanel();
		} else {
			this.tool = tool;
			if (tool === 'eraser') this.hidePanel();
			else if (this.panelEl.style.display !== 'none') this.renderPanel();
		}
		this.refreshToolbar();
	}

	togglePanel() {
		if (this.panelEl.style.display === 'none') {
			this.renderPanel();
			this.panelEl.style.display = '';
		} else {
			this.hidePanel();
		}
	}

	hidePanel() {
		this.panelEl.style.display = 'none';
	}

	renderPanel() {
		const panel = this.panelEl;
		panel.empty();
		this.panelTool = this.tool;
		const style = this.currentStyle();
		const widths = this.tool === 'marker' ? MARKER_WIDTHS : PEN_WIDTHS;

		const wRow = panel.createDiv({ cls: 'emr-scribe-panel-row' });
		wRow.createSpan({ text: t('thickness'), cls: 'emr-scribe-panel-label' });
		for (const w of widths) {
			const b = wRow.createEl('button', { cls: 'emr-scribe-dotbtn' });
			// Horizontal bar at the actual stroke thickness — tiny centered
			// dots are invisible on E-Ink panels.
			const barEl = b.createSpan({ cls: 'emr-scribe-thickbar' });
			const px = Math.max(3, Math.round(this.tool === 'marker' ? w * 0.55 : w * 1.6));
			barEl.style.height = px + 'px';
			if (Math.abs(style.w - w) < 0.01) b.addClass('is-active');
			b.addEventListener('click', async () => {
				style.w = w;
				await this.plugin.saveSettings();
				this.renderPanel();
			});
		}

		const cRow = panel.createDiv({ cls: 'emr-scribe-panel-row' });
		cRow.createSpan({ text: t('color'), cls: 'emr-scribe-panel-label' });
		for (const c of PALETTE) {
			const b = cRow.createEl('button', { cls: 'emr-scribe-swatch' });
			b.style.background = c;
			if (style.c.toLowerCase() === c) b.addClass('is-active');
			b.addEventListener('click', async () => {
				style.c = c;
				await this.plugin.saveSettings();
				this.renderPanel();
				this.refreshToolbar();
			});
		}
		const picker = cRow.createEl('input', { type: 'color', cls: 'emr-scribe-picker' });
		picker.value = /^#[0-9a-fA-F]{6}$/.test(style.c) ? style.c : '#000000';
		picker.addEventListener('change', async () => {
			style.c = picker.value;
			await this.plugin.saveSettings();
			this.renderPanel();
			this.refreshToolbar();
		});

		const oRow = panel.createDiv({ cls: 'emr-scribe-panel-row' });
		oRow.createSpan({ text: t('opacity'), cls: 'emr-scribe-panel-label' });
		const slider = oRow.createEl('input', { type: 'range', cls: 'emr-scribe-range' });
		slider.min = '10';
		slider.max = '100';
		slider.step = '5';
		slider.value = String(Math.round((style.o != null ? style.o : 1) * 100));
		const pct = oRow.createSpan({ text: slider.value + '%', cls: 'emr-scribe-pct' });
		slider.addEventListener('input', () => {
			pct.setText(slider.value + '%');
		});
		slider.addEventListener('change', async () => {
			style.o = Number(slider.value) / 100;
			await this.plugin.saveSettings();
		});
	}

	refreshToolbar() {
		this.penBtn.toggleClass('is-active', this.tool === 'pen');
		this.markerBtn.toggleClass('is-active', this.tool === 'marker');
		this.eraserBtn.toggleClass('is-active', this.tool === 'eraser');
		this.penBtn.style.borderBottom = '3px solid ' + this.plugin.settings.penStyle.c;
		this.markerBtn.style.borderBottom = '3px solid ' + this.plugin.settings.markerStyle.c;
		if (this.autoOcrBtn) {
			this.autoOcrBtn.toggleClass('is-active', this.plugin.settings.autoOcr);
			if (this.autoStateEl) this.autoStateEl.setText(this.plugin.settings.autoOcr ? '●' : '○');
		}
	}

	updateHud() {
		if (!this.hudEl) return;
		this.hudEl.setText(`${this.dbgEvents * 2}ev/s draw:${this.dbgDrawMs.toFixed(1)}ms`);
		this.dbgEvents = 0;
	}

	resizeCanvases() {
		const doc = this.docData;
		const scale = this.plugin.settings.canvasScale || 1;
		for (const cv of [this.canvas, this.overlay]) {
			cv.width = Math.round(doc.width * scale);
			cv.height = Math.round(doc.height * scale);
		}
		// desynchronized: low-latency hint. Default is mobile-only because
		// some Windows GPU configurations render nothing when it is forced.
		const ds = this.plugin.settings.desyncCanvas;
		const desync = ds === 'on' || (ds === 'auto' && Platform.isMobile);
		this.ctx = this.canvas.getContext('2d', { desynchronized: desync, alpha: false });
		this.octx = this.overlay.getContext('2d', { desynchronized: desync });
		this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
		this.octx.setTransform(scale, 0, 0, scale, 0, 0);
		for (const c of [this.ctx, this.octx]) {
			c.lineCap = 'round';
			c.lineJoin = 'round';
		}
	}

	// ---------- rendering ----------

	fillBackground() {
		const { width, height } = this.docData;
		this.ctx.fillStyle = '#ffffff';
		this.ctx.fillRect(0, 0, width, height);
		// dashed page separators on multi-page documents
		const ph = this.docData.pageH || 0;
		if (ph > 0 && height > ph) {
			this.ctx.save();
			this.ctx.strokeStyle = '#c8c8c8';
			this.ctx.lineWidth = 1;
			this.ctx.setLineDash([8, 8]);
			for (let y = ph; y < height; y += ph) {
				this.ctx.beginPath();
				this.ctx.moveTo(0, y);
				this.ctx.lineTo(width, y);
				this.ctx.stroke();
			}
			this.ctx.restore();
		}
	}

	/** Extend the document downward by one page. Existing strokes keep their
	 *  coordinates; only the canvas grows. */
	addPage() {
		const doc = this.docData;
		if (!doc) return;
		if (!doc.pageH) doc.pageH = doc.height;
		const scale = this.plugin.settings.canvasScale || 1;
		const newH = doc.height + doc.pageH;
		// Canvas backing stores hit browser limits around 16k px per side.
		if (Math.round(newH * scale) > 16000) {
			new Notice(t('pageLimit'));
			return;
		}
		doc.height = newH;
		this.resizeCanvases();
		this.fullRedraw();
		this.requestSave();
		new Notice(t('pageAdded').replace('{n}', String(Math.round(doc.height / doc.pageH))));
		this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight });
	}

	fullRedraw() {
		if (!this.ctx || !this.docData) return;
		this.fillBackground();
		for (const s of this.docData.strokes) this.drawStrokeFinal(this.ctx, s);
		this.clearOverlay();
	}

	/** Final-quality render of a completed stroke. */
	drawStrokeFinal(ctx, s) {
		if (!s.p.length) return;
		if (isFlatStroke(s)) {
			this.drawFlatPath(ctx, s, s.p, null);
		} else {
			this.drawStrokeSegmented(ctx, s);
		}
	}

	/** One single path with constant width — required for translucent ink,
	 *  otherwise segment joints double-blend and look dotted. */
	drawFlatPath(ctx, s, pts, extraPt) {
		ctx.globalAlpha = s.o != null ? s.o : 1;
		ctx.strokeStyle = s.c;
		ctx.lineWidth =
			s.t === 'marker' ? s.w : avgStrokeWidth(s, this.plugin.settings.usePressure);
		ctx.beginPath();
		ctx.moveTo(pts[0][0], pts[0][1]);
		if (pts.length === 1 && !extraPt) {
			ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
		} else {
			for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
			if (extraPt) ctx.lineTo(extraPt[0], extraPt[1]);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	drawStrokeSegmented(ctx, s) {
		const pts = s.p;
		if (!pts.length) return;
		ctx.strokeStyle = s.c;
		if (pts.length === 1) {
			ctx.lineWidth = strokeWidthFor(s.w, pts[0][2], this.plugin.settings.usePressure);
			ctx.beginPath();
			ctx.moveTo(pts[0][0], pts[0][1]);
			ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
			ctx.stroke();
			return;
		}
		for (let i = 1; i < pts.length; i++) {
			this.drawSegment(ctx, s, pts[i - 1], pts[i]);
		}
	}

	drawSegment(ctx, s, a, b) {
		ctx.strokeStyle = s.c;
		ctx.lineWidth = strokeWidthFor(
			s.w,
			((a[2] || 0) + (b[2] || 0)) / 2,
			this.plugin.settings.usePressure
		);
		ctx.beginPath();
		ctx.moveTo(a[0], a[1]);
		ctx.lineTo(b[0], b[1]);
		ctx.stroke();
	}

	clearOverlay() {
		if (!this.octx) return;
		const { width, height } = this.docData;
		this.octx.clearRect(0, 0, width, height);
	}

	/** Translucent in-progress stroke: repaint the whole (single) stroke on
	 *  the cleared overlay every event, composite onto the main canvas once
	 *  at pointerup. Opaque strokes never take this path. */
	redrawActiveOnOverlay(e) {
		if (!this.octx || !this.active) return;
		this.clearOverlay();
		let extra = null;
		if (e && this.plugin.settings.usePrediction && e.getPredictedEvents) {
			const preds = e.getPredictedEvents();
			if (preds.length) extra = this.toLogical(preds[preds.length - 1]);
		}
		this.drawFlatPath(this.octx, this.active, this.active.p, extra);
	}

	drawPrediction(e) {
		if (!this.plugin.settings.usePrediction || !this.octx || !this.active) return;
		this.clearOverlay();
		if (!e.getPredictedEvents) return;
		const preds = e.getPredictedEvents();
		if (!preds.length) return;
		const last = this.active.p[this.active.p.length - 1];
		const pt = this.toLogical(preds[preds.length - 1]);
		this.drawSegment(this.octx, this.active, last, pt);
	}

	// ---------- input ----------

	toLogical(e) {
		const r = this.canvas.getBoundingClientRect();
		const t0 = this.strokeT0 != null ? Math.max(0, Math.round(e.timeStamp - this.strokeT0)) : 0;
		return [
			round1((e.clientX - r.left) * (this.docData.width / r.width)),
			round1((e.clientY - r.top) * (this.docData.height / r.height)),
			Math.round((e.pressure || 0) * 1000) / 1000,
			t0,
		];
	}

	bindPointerEvents() {
		const cv = this.canvas;
		cv.addEventListener('contextmenu', (e) => e.preventDefault());
		cv.addEventListener('pointerdown', (e) => this.onPointerDown(e));
		const move = (e) => this.onPointerMove(e);
		// pointerrawupdate delivers samples without waiting for rAF alignment.
		// Fall back to pointermove where unsupported; never bind both.
		if ('onpointerrawupdate' in cv) {
			cv.addEventListener('pointerrawupdate', move);
		} else {
			cv.addEventListener('pointermove', move);
		}
		cv.addEventListener('pointerup', (e) => this.onPointerEnd(e));
		cv.addEventListener('pointercancel', (e) => this.onPointerEnd(e));
	}

	onPointerDown(e) {
		if (e.pointerType === 'pen') this.lastPenTime = e.timeStamp;

		if (e.pointerType === 'touch' && this.plugin.settings.penOnly) {
			// Palm rejection: ignore touches while the pen is active or was
			// seen recently (hover counts). Otherwise the touch pans the page.
			if (this.active || this.erasing) return;
			if (e.timeStamp - this.lastPenTime < PALM_WINDOW_MS) return;
			if (this.panPointerId != null) return; // second finger: ignore
			this.panPointerId = e.pointerId;
			this.panStartY = e.clientY;
			this.panStartTop = this.scrollEl.scrollTop;
			this.canvas.setPointerCapture(e.pointerId);
			return;
		}

		if (this.activePointerId != null) return;
		e.preventDefault();
		// Pen touching down kills any palm-initiated pan immediately.
		this.panPointerId = null;
		this.hidePanel();
		this.canvas.setPointerCapture(e.pointerId);
		this.activePointerId = e.pointerId;

		const hwEraser = (e.buttons & 32) === 32 || e.button === 5;
		if (this.tool === 'eraser' || hwEraser) {
			this.erasing = true;
			this.eraseAt(this.toLogical(e));
			return;
		}
		this.strokeT0 = e.timeStamp;
		const st = this.currentStyle();
		this.active = {
			c: st.c,
			w: st.w,
			o: st.o != null ? st.o : 1,
			t: this.tool,
			p: [this.toLogical(e)],
		};
		if (isFlatStroke(this.active)) this.redrawActiveOnOverlay(null);
		else this.drawStrokeSegmented(this.ctx, this.active);
	}

	onPointerMove(e) {
		if (e.pointerType === 'pen') this.lastPenTime = e.timeStamp;

		if (e.pointerId === this.panPointerId) {
			this.scrollEl.scrollTop = this.panStartTop - (e.clientY - this.panStartY);
			return;
		}
		if (e.pointerId !== this.activePointerId) return;
		if (!this.active && !this.erasing) return;

		const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
		const batch = events.length ? events : [e];
		const t0 = performance.now();
		if (this.erasing) {
			for (const ev of batch) this.eraseAt(this.toLogical(ev));
		} else {
			const pts = this.active.p;
			const flat = isFlatStroke(this.active);
			for (const ev of batch) {
				const pt = this.toLogical(ev);
				const last = pts[pts.length - 1];
				if (pt[0] === last[0] && pt[1] === last[1]) continue;
				pts.push(pt);
				if (!flat) this.drawSegment(this.ctx, this.active, last, pt);
			}
			if (flat) this.redrawActiveOnOverlay(e);
			else this.drawPrediction(e);
		}
		this.dbgEvents += batch.length;
		this.dbgDrawMs = performance.now() - t0;
	}

	onPointerEnd(e) {
		if (e.pointerId === this.panPointerId) {
			this.panPointerId = null;
			return;
		}
		if (e.pointerId !== this.activePointerId) return;
		this.activePointerId = null;
		this.strokeT0 = null;
		if (this.erasing) {
			this.erasing = false;
			this.requestSave();
			this.scheduleAutoOcr();
			return;
		}
		if (!this.active) return;
		const s = this.active;
		this.active = null;
		this.docData.strokes.push(s);
		this.clearOverlay();
		if (isFlatStroke(s)) this.drawStrokeFinal(this.ctx, s);
		this.redoStack = [];
		this.requestSave();
		this.scheduleAutoOcr();
	}

	eraseAt(pt) {
		const strokes = this.docData.strokes;
		let removed = false;
		for (let i = strokes.length - 1; i >= 0; i--) {
			const s = strokes[i];
			const threshold = s.w + 12;
			const pts = s.p;
			let hit = pts.length === 1 && Math.hypot(pt[0] - pts[0][0], pt[1] - pts[0][1]) < threshold;
			for (let j = 1; !hit && j < pts.length; j++) {
				if (segDist(pt[0], pt[1], pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]) < threshold) {
					hit = true;
				}
			}
			if (hit) {
				strokes.splice(i, 1);
				removed = true;
			}
		}
		if (removed) this.fullRedraw();
	}

	undo() {
		if (!this.docData.strokes.length) return;
		this.redoStack.push(this.docData.strokes.pop());
		this.fullRedraw();
		this.requestSave();
		this.scheduleAutoOcr();
	}

	redo() {
		if (!this.redoStack.length) return;
		this.docData.strokes.push(this.redoStack.pop());
		this.fullRedraw();
		this.requestSave();
		this.scheduleAutoOcr();
	}

	// ---------- OCR ----------

	scheduleAutoOcr() {
		if (!this.plugin.settings.autoOcr) return;
		if (this.ocrTimer) window.clearTimeout(this.ocrTimer);
		this.ocrTimer = window.setTimeout(() => {
			this.ocrTimer = null;
			this.runOcr(false);
		}, AUTO_OCR_DELAY_MS);
	}

	async runOcr(manual) {
		if (!this.docData) return;
		if (!this.docData.strokes.length) {
			if (this.docData.ocr) {
				this.docData.ocr = null;
				this.updateTextPane();
				this.requestSave();
			} else if (manual) {
				new Notice(t('noStrokes'));
			}
			return;
		}
		if (this.ocrBusy) {
			this.ocrPending = true; // re-run once the current pass finishes
			return;
		}
		this.ocrBusy = true;
		try {
			let text = '';
			if (this.plugin.settings.ocrProvider === 'endpoint') {
				text = await this.ocrViaEndpoint();
			} else {
				text = await this.ocrViaGoogle();
			}
			if (!text) {
				if (manual) new Notice(t('notRecognized'));
				return;
			}
			this.docData.ocr = { text, at: new Date().toISOString() };
			this.updateTextPane();
			this.requestSave();
		} catch (err) {
			if (manual) new Notice(t('ocrFailed') + (err && err.message ? err.message : String(err)));
		} finally {
			this.ocrBusy = false;
			if (this.ocrPending) {
				this.ocrPending = false;
				this.runOcr(false);
			}
		}
	}

	async ocrViaGoogle() {
		const lang = this.plugin.settings.ocrLanguage || 'ja';
		// Markers are highlights, not text — including them would corrupt
		// the recognition of the strokes underneath.
		const textStrokes = this.docData.strokes.filter((s) => s.t !== 'marker');
		if (!textStrokes.length) return '';
		const lines = clusterLines(textStrokes, this.docData.width);
		const results = [];
		for (const line of lines) {
			// Per-line cache: only lines that changed since the last pass hit
			// the network, so auto-OCR normally costs one request, not N.
			const key = lineKey(line);
			let text = this.ocrCache.get(key);
			if (text == null) {
				text = await recognizeGoogleInk(line, lang);
				if (this.ocrCache.size > 800) this.ocrCache.clear();
				this.ocrCache.set(key, text);
			}
			results.push(text);
		}
		return results.join('\n').trim();
	}

	async ocrViaEndpoint() {
		const ep = this.plugin.settings.ocrEndpoint;
		if (!ep) {
			throw new Error(t('endpointMissing'));
		}
		const png = this.canvas.toDataURL('image/png').split(',')[1];
		const res = await requestUrl({
			url: ep,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({ image: png }),
		});
		try {
			const j = res.json;
			return j.text != null ? j.text : j.result != null ? j.result : '';
		} catch (e) {
			return res.text || '';
		}
	}

	updateTextPane() {
		if (!this.textPane) return;
		// Never clobber an edit in progress.
		if (document.activeElement === this.textBody) return;
		const text = this.docData && this.docData.ocr && this.docData.ocr.text;
		if (text) {
			this.textBody.value = text;
			this.textPane.style.display = '';
			this.autoGrowTextPane();
		} else {
			this.textPane.style.display = 'none';
		}
	}

	autoGrowTextPane() {
		const el = this.textBody;
		if (!el) return;
		// Grow with content up to ~45% of the viewport, then scroll inside —
		// keeps the whole text reachable on tablets regardless of page height.
		el.style.height = 'auto';
		const max = Math.round(window.innerHeight * 0.45);
		el.style.height = Math.min(el.scrollHeight + 4, max) + 'px';
	}
}

// ---------- settings tab ----------

class ScribeSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t('setFolder'))
			.setDesc(t('setFolderDesc'))
			.addText((tc) =>
				tc.setValue(this.plugin.settings.folder).onChange(async (v) => {
					this.plugin.settings.folder = v.trim() || 'Scribe';
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('setPageSize'))
			.setDesc(t('setPageSizeDesc'))
			.addText((tc) =>
				tc.setValue(String(this.plugin.settings.pageWidth)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n > 100) this.plugin.settings.pageWidth = n;
					await this.plugin.saveSettings();
				})
			)
			.addText((tc) =>
				tc.setValue(String(this.plugin.settings.pageHeight)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n > 100) this.plugin.settings.pageHeight = n;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('setScale'))
			.setDesc(t('setScaleDesc'))
			.addSlider((s) =>
				s
					.setLimits(0.5, 1.5, 0.25)
					.setValue(this.plugin.settings.canvasScale)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.canvasScale = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('setPenOnly'))
			.setDesc(t('setPenOnlyDesc'))
			.addToggle((tc) =>
				tc.setValue(this.plugin.settings.penOnly).onChange(async (v) => {
					this.plugin.settings.penOnly = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('setPressure'))
			.setDesc(t('setPressureDesc'))
			.addToggle((tc) =>
				tc.setValue(this.plugin.settings.usePressure).onChange(async (v) => {
					this.plugin.settings.usePressure = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('setPrediction'))
			.setDesc(t('setPredictionDesc'))
			.addToggle((tc) =>
				tc.setValue(this.plugin.settings.usePrediction).onChange(async (v) => {
					this.plugin.settings.usePrediction = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('setDesync'))
			.setDesc(t('setDesyncDesc'))
			.addDropdown((d) =>
				d
					.addOption('auto', t('optAuto'))
					.addOption('on', t('optOn'))
					.addOption('off', t('optOff'))
					.setValue(this.plugin.settings.desyncCanvas)
					.onChange(async (v) => {
						this.plugin.settings.desyncCanvas = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName(t('headOcr')).setHeading();

		new Setting(containerEl)
			.setName(t('setAutoOcr'))
			.setDesc(t('setAutoOcrDesc'))
			.addToggle((tc) =>
				tc.setValue(this.plugin.settings.autoOcr).onChange(async (v) => {
					this.plugin.settings.autoOcr = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t('setEngine'))
			.setDesc(t('setEngineDesc'))
			.addDropdown((d) =>
				d
					.addOption('google', t('optGoogle'))
					.addOption('endpoint', t('optEndpoint'))
					.setValue(this.plugin.settings.ocrProvider)
					.onChange(async (v) => {
						this.plugin.settings.ocrProvider = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('setLang'))
			.setDesc(t('setLangDesc'))
			.addDropdown((d) =>
				d
					.addOption('ja', t('optJa'))
					.addOption('en', t('optEn'))
					.setValue(this.plugin.settings.ocrLanguage)
					.onChange(async (v) => {
						this.plugin.settings.ocrLanguage = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('setEndpoint'))
			.setDesc(t('setEndpointDesc'))
			.addText((tc) =>
				tc
					.setPlaceholder('http://…/ocr')
					.setValue(this.plugin.settings.ocrEndpoint)
					.onChange(async (v) => {
						this.plugin.settings.ocrEndpoint = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t('setHud'))
			.setDesc(t('setHudDesc'))
			.addToggle((tc) =>
				tc.setValue(this.plugin.settings.showDebugHud).onChange(async (v) => {
					this.plugin.settings.showDebugHud = v;
					await this.plugin.saveSettings();
				})
			);
	}
}

// ---------- plugin ----------

module.exports = class EmrScribePlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new ScribeView(leaf, this));
		this.registerExtensions([FILE_EXT], VIEW_TYPE);

		this.addRibbonIcon('pencil', t('ribbon'), () => this.createAndOpen());

		this.addCommand({
			id: 'new-scribe',
			name: t('cmdNew'),
			callback: () => this.createAndOpen(),
		});

		this.addCommand({
			id: 'new-scribe-embed',
			name: t('cmdNewEmbed'),
			editorCallback: async (editor) => {
				const file = await this.createScribeFile();
				editor.replaceSelection('```scribe\nfile: ' + file.path + '\n```\n');
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(file);
			},
		});

		this.registerMarkdownCodeBlockProcessor('scribe', async (source, el, ctx) => {
			const m = source.match(/file:\s*(.+)/);
			if (!m) {
				el.setText(t('embedNeedFile'));
				return;
			}
			const path = normalizePath(m[1].trim());
			let file = this.app.vault.getAbstractFileByPath(path);
			if (!file) file = this.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			if (!(file instanceof TFile)) {
				el.setText(t('embedNotFound') + path);
				return;
			}
			let doc;
			try {
				doc = JSON.parse(await this.app.vault.cachedRead(file));
			} catch (e) {
				el.setText(t('embedBroken') + path);
				return;
			}
			const wrap = el.createDiv({ cls: 'emr-scribe-embed' });
			wrap.innerHTML = docToSvg(doc);
			wrap.setAttribute('aria-label', file.basename + t('embedHint'));
			wrap.addEventListener('click', async () => {
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(file);
			});
			if (doc.ocr && doc.ocr.text) {
				el.createDiv({ cls: 'emr-scribe-embed-text', text: doc.ocr.text });
			}
		});

		this.addSettingTab(new ScribeSettingTab(this.app, this));
	}

	async createScribeFile() {
		const folder = normalizePath(this.settings.folder || 'Scribe');
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {});
		}
		const d = new Date();
		const pad = (n) => String(n).padStart(2, '0');
		const stamp =
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
			`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
		const path = normalizePath(`${folder}/Scribe ${stamp}.${FILE_EXT}`);
		return this.app.vault.create(path, JSON.stringify(newDocData(this.settings)));
	}

	async createAndOpen() {
		const file = await this.createScribeFile();
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
	}

	async loadSettings() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.settings.penStyle = Object.assign({}, DEFAULT_SETTINGS.penStyle, saved && saved.penStyle);
		this.settings.markerStyle = Object.assign(
			{},
			DEFAULT_SETTINGS.markerStyle,
			saved && saved.markerStyle
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
};
