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
	Menu,
	Modal,
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
		importBtn: 'Import (camera / photo / file)',
		importCamera: 'Camera',
		importPhoto: 'Photos',
		importFile: 'File (PDF / image)',
		importing: 'Importing…',
		importFailed: 'Import failed: ',
		importedN: 'Imported {n} page(s)',
		pdfUnsupported: 'PDF import is unavailable in this environment (image import still works)',
		noImageFile: 'Not an importable file',
		ballLabel: 'Tools',
		pagePrev: 'Previous page',
		pageNext: 'Next page',
		pageMenu: 'Page actions',
		pageGoto: 'Go to page…',
		pageDelete: 'Delete this page',
		pageMoveUp: 'Move page up',
		pageMoveDown: 'Move page down',
		gotoTitle: 'Go to page',
		gotoOk: 'Go',
		confirmDeletePage: 'Delete this page and its handwriting?',
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
		headDisplay: 'Display',
		setLanguage: 'Language',
		setLanguageDesc: 'UI language. "Auto" follows Obsidian. Reopen notes to fully apply',
		optLangAuto: 'Auto (follow Obsidian)',
		setPageNum: 'Page number position',
		setPageNumDesc: 'Where the page number is drawn on each page (helpful on E-Ink where dashed separators are faint)',
		optCornerOff: 'Off',
		optCornerTL: 'Top-left',
		optCornerTR: 'Top-right',
		optCornerBL: 'Bottom-left',
		optCornerBR: 'Bottom-right',
		setFloatingBall: 'Floating ball toolbar',
		setFloatingBallDesc: 'Collapse the toolbar into a draggable floating button (good for E-Ink / small screens). Reopen notes to apply',
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
		importBtn: 'インポート（カメラ / 写真 / ファイル）',
		importCamera: 'カメラ',
		importPhoto: '写真',
		importFile: 'ファイル（PDF / 画像）',
		importing: 'インポート中…',
		importFailed: 'インポート失敗: ',
		importedN: '{n}ページを取り込みました',
		pdfUnsupported: 'この環境ではPDF取り込みが使えません（画像の取り込みは可能）',
		noImageFile: '取り込めないファイルです',
		ballLabel: 'ツール',
		pagePrev: '前のページ',
		pageNext: '次のページ',
		pageMenu: 'ページ操作',
		pageGoto: 'ページを指定…',
		pageDelete: 'このページを削除',
		pageMoveUp: 'ページを上へ',
		pageMoveDown: 'ページを下へ',
		gotoTitle: 'ページを指定',
		gotoOk: '移動',
		confirmDeletePage: 'このページと手書きを削除しますか？',
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
		headDisplay: '表示',
		setLanguage: '言語',
		setLanguageDesc: 'UIの言語。「自動」はObsidianに追従。反映にはノートを開き直す',
		optLangAuto: '自動（Obsidianに追従）',
		setPageNum: 'ページ番号の位置',
		setPageNumDesc: '各ページに描くページ番号の位置（E-Inkでは点線区切りが薄いので便利）',
		optCornerOff: 'なし',
		optCornerTL: '左上',
		optCornerTR: '右上',
		optCornerBL: '左下',
		optCornerBR: '右下',
		setFloatingBall: 'フローティングボール',
		setFloatingBallDesc: 'ツールバーをドラッグ可能な丸ボタンに畳む（E-Ink/小画面向け）。反映にはノートを開き直す',
	},
};

// LANG is resolved from the plugin's language setting (falling back to
// Obsidian's UI language). It is mutable so the setting can change it live.
let LANG = 'en';

function resolveLang(pref) {
	const obsidian = window.localStorage.getItem('language') || 'en';
	const pick = pref && pref !== 'auto' ? pref : obsidian;
	LANG = TR[pick] ? pick : 'en';
}

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
	language: 'auto', // 'auto' | 'en' | 'ja'
	pageNumPos: 'br', // 'off' | 'tl' | 'tr' | 'bl' | 'br'
	floatingBall: false,
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

class GoToPageModal extends Modal {
	constructor(app, count, current, onGo) {
		super(app);
		this.count = count;
		this.current = current;
		this.onGo = onGo;
	}
	onOpen() {
		this.titleEl.setText(t('gotoTitle'));
		const row = this.contentEl.createDiv({ cls: 'emr-scribe-goto' });
		const input = row.createEl('input', { type: 'number' });
		input.min = '1';
		input.max = String(this.count);
		input.value = String(this.current + 1);
		const go = () => {
			let n = parseInt(input.value, 10);
			if (!(n >= 1)) n = 1;
			if (n > this.count) n = this.count;
			this.close();
			this.onGo(n - 1);
		};
		const btn = row.createEl('button', { text: t('gotoOk') });
		btn.addEventListener('click', go);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') go();
		});
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}
	onClose() {
		this.contentEl.empty();
	}
}

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
		this.textSaveTimer = null;
		// One <canvas> pair per page. A single tall canvas breaks past the
		// GPU max texture size (~4096px on E-Ink SoCs): the whole thing gets
		// squeezed into one texture, stretching everything and misplacing new
		// ink. Per-page canvases stay well under the limit at any page count.
		this.pages = []; // [{ wrap, main, over, mctx, octx }]
		this.bgImages = new Map(); // vault path → HTMLImageElement | 'loading' | null
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
			this.syncPages();
			this.ensureAllBgs();
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
			this.syncPages();
			this.ensureAllBgs();
			this.fullRedraw();
			this.updateTextPane();
		}
	}

	/** Rebuild the whole view UI (used when floating-ball / language change). */
	rebuild() {
		if (!this.domReady) return;
		this.buildDom();
		if (this.docData) {
			this.syncPages();
			this.ensureAllBgs();
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

	/** Build the full set of tool buttons into `container`. Shared by the
	 *  normal toolbar and the floating-ball popover so both stay identical.
	 *  `onAny` (optional) is called after any action fires (used to close the
	 *  floating popover). */
	buildActionButtons(container, onAny) {
		const after = () => { if (onAny) onAny(); };

		this.penBtn = this.iconBtn(container, 'pencil', t('pen'));
		this.markerBtn = this.iconBtn(container, 'highlighter', t('marker'));
		this.eraserBtn = this.iconBtn(container, 'eraser', t('eraser'));
		this.penBtn.addEventListener('click', () => this.selectTool('pen'));
		this.markerBtn.addEventListener('click', () => this.selectTool('marker'));
		this.eraserBtn.addEventListener('click', () => this.selectTool('eraser'));

		container.createDiv({ cls: 'emr-scribe-sep' });

		const undoBtn = this.iconBtn(container, 'undo-2', t('undo'));
		undoBtn.addEventListener('click', () => { this.undo(); after(); });
		const redoBtn = this.iconBtn(container, 'redo-2', t('redo'));
		redoBtn.addEventListener('click', () => { this.redo(); after(); });
		const clearBtn = this.iconBtn(container, 'eraser', t('clearAll'));
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
			after();
		});

		const addPageBtn = this.iconBtn(container, 'file-plus', t('addPage'));
		addPageBtn.addEventListener('click', () => { this.addPage(); after(); });

		const importBtn = this.iconBtn(container, 'image-plus', t('importBtn'));
		importBtn.addEventListener('click', (e) => { this.openImportMenu(e); after(); });

		container.createDiv({ cls: 'emr-scribe-sep' });

		const ocrBtn = container.createEl('button', { text: 'OCR', cls: 'emr-scribe-btn' });
		ocrBtn.setAttribute('aria-label', t('ocrBtn'));
		ocrBtn.addEventListener('click', () => { this.runOcr(true); after(); });

		const reocrBtn = container.createEl('button', { cls: 'emr-scribe-btn' });
		reocrBtn.createSpan({ text: 'Re', cls: 'emr-scribe-btn-sub' });
		reocrBtn.createSpan({ text: 'OCR' });
		reocrBtn.setAttribute('aria-label', t('reocrBtn'));
		reocrBtn.addEventListener('click', () => {
			this.ocrCache.clear();
			this.runOcr(true);
			after();
		});

		this.autoOcrBtn = container.createEl('button', { cls: 'emr-scribe-btn' });
		this.autoOcrBtn.createSpan({ text: 'Auto' });
		this.autoStateEl = this.autoOcrBtn.createSpan({ text: '○', cls: 'emr-scribe-btn-sub' });
		this.autoOcrBtn.setAttribute('aria-label', t('ocrAutoBtn'));
		this.autoOcrBtn.addEventListener('click', async () => {
			this.plugin.settings.autoOcr = !this.plugin.settings.autoOcr;
			await this.plugin.saveSettings();
			this.refreshToolbar();
			if (this.plugin.settings.autoOcr) this.scheduleAutoOcr();
		});

		this.refreshToolbar();
	}

	/** Collapsed toolbar: a draggable round button that opens a popover with
	 *  the same actions. Keeps the whole screen free for writing on E-Ink. */
	buildFloatingBall(root) {
		const ball = root.createDiv({ cls: 'emr-scribe-ball' });
		setIcon(ball, 'pencil');
		ball.setAttribute('aria-label', t('ballLabel'));
		const menu = root.createDiv({ cls: 'emr-scribe-ball-menu' });
		menu.style.display = 'none';
		this.buildActionButtons(menu, () => { menu.style.display = 'none'; });

		const closeMenu = () => { menu.style.display = 'none'; };
		const openMenu = () => {
			// place the menu just above the ball, clamped to the view
			menu.style.display = '';
			const rb = ball.getBoundingClientRect();
			const rr = root.getBoundingClientRect();
			const mw = menu.offsetWidth || 240;
			let left = rb.left - rr.left + rb.width / 2 - mw / 2;
			left = Math.max(6, Math.min(left, rr.width - mw - 6));
			menu.style.left = left + 'px';
			const bottom = rr.height - (rb.top - rr.top) + 8;
			menu.style.bottom = Math.min(bottom, rr.height - 6) + 'px';
		};

		// pointer-based drag with a tap threshold: a small movement is a tap
		// (toggles the menu), a larger one repositions the ball.
		let down = null;
		let moved = false;
		ball.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			ball.setPointerCapture(e.pointerId);
			const rr = root.getBoundingClientRect();
			down = { x: e.clientX, y: e.clientY, ox: ball.offsetLeft, oy: ball.offsetTop, rr };
			moved = false;
		});
		ball.addEventListener('pointermove', (e) => {
			if (!down) return;
			const dx = e.clientX - down.x, dy = e.clientY - down.y;
			if (!moved && Math.hypot(dx, dy) < 8) return;
			moved = true;
			closeMenu();
			let left = down.ox + dx, top = down.oy + dy;
			left = Math.max(0, Math.min(left, down.rr.width - ball.offsetWidth));
			top = Math.max(0, Math.min(top, down.rr.height - ball.offsetHeight));
			ball.style.left = left + 'px';
			ball.style.top = top + 'px';
			ball.style.right = 'auto';
			ball.style.bottom = 'auto';
		});
		const end = (e) => {
			if (!down) return;
			down = null;
			if (!moved) {
				if (menu.style.display === 'none') openMenu();
				else closeMenu();
			}
		};
		ball.addEventListener('pointerup', end);
		ball.addEventListener('pointercancel', end);
	}

	// ---------- import (camera / photo / PDF-image background) ----------

	openImportMenu(evt) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t('importCamera')).setIcon('camera').onClick(() => this.pickFiles('camera')));
		menu.addItem((i) => i.setTitle(t('importPhoto')).setIcon('image').onClick(() => this.pickFiles('photo')));
		menu.addItem((i) => i.setTitle(t('importFile')).setIcon('file').onClick(() => this.pickFiles('file')));
		if (evt && evt.clientX != null) menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
		else menu.showAtPosition({ x: 100, y: 100 });
	}

	pickFiles(kind) {
		const input = document.createElement('input');
		input.type = 'file';
		if (kind === 'camera') {
			input.accept = 'image/*';
			input.capture = 'environment';
		} else if (kind === 'photo') {
			input.accept = 'image/*';
			input.multiple = true;
		} else {
			input.accept = 'application/pdf,image/*';
			input.multiple = true;
		}
		input.addEventListener('change', async () => {
			const files = Array.from(input.files || []);
			for (const f of files) {
				try {
					await this.importFile(f);
				} catch (err) {
					new Notice(t('importFailed') + (err && err.message ? err.message : String(err)));
				}
			}
		});
		input.click();
	}

	async importFile(file) {
		const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
		const isImg = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
		if (isPdf) {
			await this.importPdf(file);
		} else if (isImg) {
			new Notice(t('importing'));
			const buf = await file.arrayBuffer();
			const ext = (file.name.split('.').pop() || 'png').toLowerCase();
			const asset = await this.saveAsset(buf, ext);
			this.addBackgroundPage(asset.path);
			new Notice(t('importedN').replace('{n}', '1'));
		} else {
			new Notice(t('noImageFile'));
		}
	}

	async importPdf(file) {
		const pdfjs = window.pdfjsLib;
		if (!pdfjs || !pdfjs.getDocument) {
			new Notice(t('pdfUnsupported'));
			return;
		}
		new Notice(t('importing'));
		const buf = await file.arrayBuffer();
		const pdf = await pdfjs.getDocument({ data: buf }).promise;
		let n = 0;
		for (let p = 1; p <= pdf.numPages; p++) {
			const page = await pdf.getPage(p);
			const base = page.getViewport({ scale: 1 });
			const scale = Math.min(2.5, 1600 / base.width);
			const viewport = page.getViewport({ scale });
			const c = document.createElement('canvas');
			c.width = Math.round(viewport.width);
			c.height = Math.round(viewport.height);
			await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			const asset = await this.saveAsset(await blob.arrayBuffer(), 'png');
			if (!this.addBackgroundPage(asset.path)) break;
			n++;
		}
		new Notice(t('importedN').replace('{n}', String(n)));
	}

	async saveAsset(arrayBuffer, ext) {
		const parent = this.file && this.file.parent ? this.file.parent.path : '';
		const dir = normalizePath((parent ? parent + '/' : '') + '_scribe_assets');
		if (!this.app.vault.getAbstractFileByPath(dir)) {
			await this.app.vault.createFolder(dir).catch(() => {});
		}
		const base = this.file ? this.file.basename : 'scribe';
		const rnd = Math.random().toString(36).slice(2, 6);
		const path = normalizePath(`${dir}/${base}-${Date.now()}-${rnd}.${ext}`);
		return this.app.vault.createBinary(path, arrayBuffer);
	}

	/** Attach an image as the background of a page (reusing the first blank
	 *  page, otherwise appending a new one), then draw on top of it. */
	addBackgroundPage(path) {
		const doc = this.docData;
		if (!doc.bgs) doc.bgs = [];
		let idx;
		if (this.pages.length === 1 && !doc.strokes.length && !doc.bgs[0]) {
			idx = 0;
		} else {
			if (!doc.pageH) doc.pageH = doc.height;
			if (Math.round(doc.height / doc.pageH) >= 200) {
				new Notice(t('pageLimit'));
				return false;
			}
			doc.height += doc.pageH;
			idx = this.pages.length;
		}
		doc.bgs[idx] = path;
		this.syncPages();
		this.ensureBg(idx);
		this.fullRedraw();
		this.requestSave();
		this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight });
		return true;
	}

	ensureAllBgs() {
		const bgs = this.docData && this.docData.bgs;
		if (!bgs) return;
		for (let i = 0; i < bgs.length; i++) if (bgs[i]) this.ensureBg(i);
	}

	ensureBg(i) {
		const path = this.docData.bgs && this.docData.bgs[i];
		if (!path || this.bgImages.has(path)) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.bgImages.set(path, null);
			return;
		}
		this.bgImages.set(path, 'loading');
		const img = new Image();
		img.onload = () => {
			this.bgImages.set(path, img);
			this.fullRedraw();
		};
		img.onerror = () => this.bgImages.set(path, null);
		img.src = this.app.vault.getResourcePath(file);
	}

	buildDom() {
		const root = this.contentEl;
		root.empty();
		root.addClass('emr-scribe-root');
		// rebuild() calls this on an already-live view: drop stale refs/timers
		// and page canvases so nothing points at removed DOM.
		this.pages = [];
		this.penBtn = this.markerBtn = this.eraserBtn = null;
		this.autoOcrBtn = this.autoStateEl = this.hudEl = null;
		if (this.dbgTimer) {
			window.clearInterval(this.dbgTimer);
			this.dbgTimer = null;
		}

		if (this.plugin.settings.floatingBall) {
			this.buildFloatingBall(root);
		} else {
			const bar = root.createDiv({ cls: 'emr-scribe-toolbar' });
			this.buildActionButtons(bar);
			if (this.plugin.settings.showDebugHud) {
				this.hudEl = bar.createSpan({ cls: 'emr-scribe-hud', text: '—' });
				this.dbgTimer = window.setInterval(() => this.updateHud(), 500);
			}
		}

		this.panelEl = root.createDiv({ cls: 'emr-scribe-panel' });
		this.panelEl.style.display = 'none';

		this.scrollEl = root.createDiv({ cls: 'emr-scribe-scroll' });
		// Page canvases are created lazily by syncPages(); wrapEl just stacks them.
		this.wrapEl = this.scrollEl.createDiv({ cls: 'emr-scribe-canvas-wrap' });

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

		// Always-visible page navigation footer (works in both toolbar and
		// floating-ball modes) — the non-scroll way to move between pages.
		this.buildNavFooter(root);

		// touch-action must be 'none': Android lets the STYLUS trigger pan
		// gestures too, which cancels strokes mid-write. Finger panning is
		// handled manually in the pointer handlers instead.
		this.wrapEl.style.touchAction = 'none';

		this.scrollEl.addEventListener('scroll', () => this.updatePageIndicator());

		this.bindPointerEvents();
		this.refreshToolbar();
	}

	buildNavFooter(root) {
		const nav = root.createDiv({ cls: 'emr-scribe-nav' });

		const prev = this.iconBtn(nav, 'chevron-left', t('pagePrev'));
		prev.addEventListener('click', () => this.gotoRelative(-1));

		this.navIndicatorEl = nav.createEl('button', {
			cls: 'emr-scribe-btn emr-scribe-nav-indicator',
			text: '1 / 1',
		});
		this.navIndicatorEl.setAttribute('aria-label', t('pageGoto'));
		this.navIndicatorEl.addEventListener('click', () => {
			new GoToPageModal(this.app, this.pages.length, this.currentPage(), (i) =>
				this.goToPage(i)
			).open();
		});

		const next = this.iconBtn(nav, 'chevron-right', t('pageNext'));
		next.addEventListener('click', () => this.gotoRelative(1));

		nav.createDiv({ cls: 'emr-scribe-nav-spacer' });

		const menuBtn = this.iconBtn(nav, 'more-vertical', t('pageMenu'));
		menuBtn.addEventListener('click', (e) => this.openPageMenu(e));

		this.updatePageIndicator();
	}

	// ---------- page navigation & management ----------

	pageStep() {
		if (!this.pages.length || !this.pages[0].wrap) return 0;
		return this.pages[0].wrap.getBoundingClientRect().height || 0;
	}

	currentPage() {
		const step = this.pageStep();
		if (!step) return 0;
		const i = Math.round(this.scrollEl.scrollTop / step);
		return Math.max(0, Math.min(this.pages.length - 1, i));
	}

	goToPage(i) {
		const step = this.pageStep();
		const idx = Math.max(0, Math.min(this.pages.length - 1, i));
		this.scrollEl.scrollTo({ top: idx * step });
		this.updatePageIndicator(idx);
	}

	gotoRelative(d) {
		this.goToPage(this.currentPage() + d);
	}

	updatePageIndicator(force) {
		if (!this.navIndicatorEl) return;
		const cur = force != null ? force : this.currentPage();
		this.navIndicatorEl.setText(`${cur + 1} / ${this.pages.length}`);
	}

	openPageMenu(evt) {
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle(t('pageGoto')).setIcon('hash').onClick(() =>
				new GoToPageModal(this.app, this.pages.length, this.currentPage(), (n) =>
					this.goToPage(n)
				).open()
			)
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle(t('pageMoveUp')).setIcon('arrow-up').onClick(() => {
				const c = this.currentPage();
				if (c > 0) this.swapPages(c, c - 1, c - 1);
			})
		);
		menu.addItem((i) =>
			i.setTitle(t('pageMoveDown')).setIcon('arrow-down').onClick(() => {
				const c = this.currentPage();
				if (c < this.pages.length - 1) this.swapPages(c, c + 1, c + 1);
			})
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle(t('pageDelete')).setIcon('trash-2').onClick(() => {
				if (window.confirm(t('confirmDeletePage'))) this.deletePage(this.currentPage());
			})
		);
		if (evt && evt.clientX != null) menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
		else menu.showAtPosition({ x: 100, y: 100 });
	}

	/** Which page a stroke belongs to (by its first point). */
	strokePageIndex(s, pageH, count) {
		const y = s.p && s.p.length ? s.p[0][1] : 0;
		return Math.max(0, Math.min(count - 1, Math.floor(y / pageH)));
	}

	deletePage(idx) {
		const doc = this.docData;
		const count = this.pages.length;
		const pageH = doc.pageH || doc.height;
		if (count <= 1) {
			// keep one page: just clear it
			doc.strokes = [];
			if (doc.bgs) doc.bgs[0] = null;
			this.redoStack = [];
			this.fullRedraw();
			this.requestSave();
			this.scheduleAutoOcr();
			this.updatePageIndicator(0);
			return;
		}
		const kept = [];
		for (const s of doc.strokes) {
			const p = this.strokePageIndex(s, pageH, count);
			if (p === idx) continue; // drop strokes on the deleted page
			if (p > idx) for (const pt of s.p) pt[1] -= pageH; // shift lower pages up
			kept.push(s);
		}
		doc.strokes = kept;
		if (doc.bgs) doc.bgs.splice(idx, 1);
		doc.height -= pageH;
		this.redoStack = [];
		this.ocrCache.clear();
		this.syncPages();
		this.ensureAllBgs();
		this.fullRedraw();
		this.requestSave();
		this.scheduleAutoOcr();
		this.goToPage(Math.min(idx, this.pages.length - 1));
	}

	swapPages(a, b, focus) {
		const doc = this.docData;
		const count = this.pages.length;
		const pageH = doc.pageH || doc.height;
		for (const s of doc.strokes) {
			const p = this.strokePageIndex(s, pageH, count);
			if (p === a) for (const pt of s.p) pt[1] += (b - a) * pageH;
			else if (p === b) for (const pt of s.p) pt[1] += (a - b) * pageH;
		}
		if (doc.bgs) {
			const tmp = doc.bgs[a];
			doc.bgs[a] = doc.bgs[b];
			doc.bgs[b] = tmp;
		}
		this.redoStack = [];
		this.ocrCache.clear();
		this.syncPages();
		this.ensureAllBgs();
		this.fullRedraw();
		this.requestSave();
		this.scheduleAutoOcr();
		this.goToPage(focus != null ? focus : a);
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
		if (!this.penBtn) return;
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

	/** Create/remove/size one canvas pair per page so no single canvas ever
	 *  exceeds the GPU texture limit. Strokes are stored in absolute document
	 *  coordinates; each page's context carries a transform that offsets it to
	 *  the page, so all draw code can keep passing absolute coordinates. */
	syncPages() {
		const doc = this.docData;
		if (!doc) return;
		const scale = this.plugin.settings.canvasScale || 1;
		const pageH = doc.pageH || doc.height;
		doc.pageH = pageH;
		const count = Math.max(1, Math.round(doc.height / pageH));
		const ds = this.plugin.settings.desyncCanvas;
		const desync = ds === 'on' || (ds === 'auto' && Platform.isMobile);

		while (this.pages.length > count) this.pages.pop().wrap.remove();
		while (this.pages.length < count) {
			const wrap = this.wrapEl.createDiv({ cls: 'emr-scribe-page' });
			const main = wrap.createEl('canvas', { cls: 'emr-scribe-canvas' });
			const over = wrap.createEl('canvas', { cls: 'emr-scribe-overlay' });
			this.pages.push({ wrap, main, over, mctx: null, octx: null });
		}

		const wpx = Math.round(doc.width * scale);
		const hpx = Math.round(pageH * scale);
		for (let i = 0; i < this.pages.length; i++) {
			const p = this.pages[i];
			p.main.width = wpx;
			p.main.height = hpx;
			p.over.width = wpx;
			p.over.height = hpx;
			p.mctx = p.main.getContext('2d', { desynchronized: desync, alpha: false });
			p.octx = p.over.getContext('2d', { desynchronized: desync });
			const off = -i * pageH * scale;
			p.mctx.setTransform(scale, 0, 0, scale, 0, off);
			p.octx.setTransform(scale, 0, 0, scale, 0, off);
			for (const c of [p.mctx, p.octx]) {
				c.lineCap = 'round';
				c.lineJoin = 'round';
			}
		}
		this.updatePageIndicator();
	}

	// ---------- rendering ----------

	pageForY(y) {
		const pageH = this.docData.pageH || this.docData.height;
		let i = Math.floor(y / pageH);
		if (i < 0) i = 0;
		if (i > this.pages.length - 1) i = this.pages.length - 1;
		return i;
	}

	fillBackground() {
		const { width } = this.docData;
		const pageH = this.docData.pageH;
		const count = this.pages.length;
		const bgs = this.docData.bgs;
		for (let i = 0; i < count; i++) {
			const ctx = this.pages[i].mctx;
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, i * pageH, width, pageH);
			// imported background image (PDF page / photo), contained & centered
			const bgPath = bgs && bgs[i];
			if (bgPath) {
				const im = this.bgImages.get(bgPath);
				if (im && im !== 'loading') {
					const sc = Math.min(width / im.width, pageH / im.height);
					const dw = im.width * sc, dh = im.height * sc;
					ctx.drawImage(im, (width - dw) / 2, i * pageH + (pageH - dh) / 2, dw, dh);
				} else if (im === undefined) {
					this.ensureBg(i);
				}
			}
			// dashed separator drawn inside the bottom of every non-last page
			if (i < count - 1) {
				ctx.save();
				ctx.strokeStyle = '#c8c8c8';
				ctx.lineWidth = 1;
				ctx.setLineDash([8, 8]);
				const y = (i + 1) * pageH - 1;
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(width, y);
				ctx.stroke();
				ctx.restore();
			}
			this.drawPageNumber(ctx, i, width, pageH);
		}
	}

	drawPageNumber(ctx, i, width, pageH) {
		const pos = this.plugin.settings.pageNumPos || 'br';
		if (pos === 'off') return;
		const m = 26;
		const fs = 34;
		ctx.save();
		ctx.fillStyle = '#9a9a9a';
		ctx.font = `${fs}px sans-serif`;
		ctx.textAlign = pos === 'tr' || pos === 'br' ? 'right' : 'left';
		const top = pos === 'tl' || pos === 'tr';
		ctx.textBaseline = top ? 'top' : 'alphabetic';
		const x = pos === 'tr' || pos === 'br' ? width - m : m;
		const y = top ? i * pageH + m : (i + 1) * pageH - m;
		ctx.fillText(String(i + 1), x, y);
		ctx.restore();
	}

	/** Extend the document downward by one page. Existing strokes keep their
	 *  coordinates; a new page canvas is appended. */
	addPage() {
		const doc = this.docData;
		if (!doc) return;
		if (!doc.pageH) doc.pageH = doc.height;
		if (Math.round(doc.height / doc.pageH) >= 200) {
			new Notice(t('pageLimit'));
			return;
		}
		doc.height += doc.pageH;
		this.syncPages();
		this.fullRedraw();
		this.requestSave();
		new Notice(t('pageAdded').replace('{n}', String(Math.round(doc.height / doc.pageH))));
		this.scrollEl.scrollTo({ top: this.scrollEl.scrollHeight });
	}

	fullRedraw() {
		if (!this.pages.length || !this.docData) return;
		this.fillBackground();
		for (const s of this.docData.strokes) this.drawStrokeFinal(s);
		this.clearOverlay();
	}

	// low-level primitives (absolute coords; ctx transform handles page offset)

	_seg(ctx, s, a, b) {
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

	_dot(ctx, s, pt) {
		ctx.strokeStyle = s.c;
		ctx.lineWidth = strokeWidthFor(s.w, pt[2], this.plugin.settings.usePressure);
		ctx.beginPath();
		ctx.moveTo(pt[0], pt[1]);
		ctx.lineTo(pt[0] + 0.01, pt[1]);
		ctx.stroke();
	}

	/** One single path with constant width — required for translucent ink,
	 *  otherwise segment joints double-blend and look dotted. */
	_flatPath(ctx, s, pts, extraPt) {
		ctx.globalAlpha = s.o != null ? s.o : 1;
		ctx.strokeStyle = s.c;
		ctx.lineWidth = s.t === 'marker' ? s.w : avgStrokeWidth(s, this.plugin.settings.usePressure);
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

	// page routing: draw a segment on whichever page(s) it touches. Each page
	// canvas clips to its own bounds, so drawing on both endpoints' pages
	// renders a boundary-crossing segment correctly.
	segOnPages(a, b, s, overlay) {
		const pa = this.pageForY(a[1]);
		const pb = this.pageForY(b[1]);
		this._seg(overlay ? this.pages[pa].octx : this.pages[pa].mctx, s, a, b);
		if (pb !== pa) this._seg(overlay ? this.pages[pb].octx : this.pages[pb].mctx, s, a, b);
	}

	flatPathOnPages(s, pts, extraPt, overlay) {
		let minY = Infinity, maxY = -Infinity;
		for (const pt of pts) {
			if (pt[1] < minY) minY = pt[1];
			if (pt[1] > maxY) maxY = pt[1];
		}
		if (extraPt) {
			if (extraPt[1] < minY) minY = extraPt[1];
			if (extraPt[1] > maxY) maxY = extraPt[1];
		}
		const from = this.pageForY(minY), to = this.pageForY(maxY);
		for (let i = from; i <= to; i++) {
			this._flatPath(overlay ? this.pages[i].octx : this.pages[i].mctx, s, pts, extraPt);
		}
	}

	/** Final-quality render of a completed stroke onto the main canvases. */
	drawStrokeFinal(s) {
		const pts = s.p;
		if (!pts.length) return;
		if (isFlatStroke(s)) {
			this.flatPathOnPages(s, pts, null, false);
			return;
		}
		if (pts.length === 1) {
			this._dot(this.pages[this.pageForY(pts[0][1])].mctx, s, pts[0]);
			return;
		}
		for (let i = 1; i < pts.length; i++) this.segOnPages(pts[i - 1], pts[i], s, false);
	}

	clearOverlay() {
		const { width, height } = this.docData;
		const pageH = this.docData.pageH;
		for (let i = 0; i < this.pages.length; i++) {
			this.pages[i].octx.clearRect(0, i * pageH, width, Math.min(pageH, height));
		}
	}

	/** Translucent in-progress stroke: repaint the whole (single) stroke on
	 *  the cleared overlay every event, composite onto the main canvas once
	 *  at pointerup. Opaque strokes never take this path. */
	redrawActiveOnOverlay(e) {
		if (!this.pages.length || !this.active) return;
		this.clearOverlay();
		let extra = null;
		if (e && this.plugin.settings.usePrediction && e.getPredictedEvents) {
			const preds = e.getPredictedEvents();
			if (preds.length) extra = this.toLogical(preds[preds.length - 1]);
		}
		this.flatPathOnPages(this.active, this.active.p, extra, true);
	}

	drawPrediction(e) {
		if (!this.plugin.settings.usePrediction || !this.pages.length || !this.active) return;
		this.clearOverlay();
		if (!e.getPredictedEvents) return;
		const preds = e.getPredictedEvents();
		if (!preds.length) return;
		const last = this.active.p[this.active.p.length - 1];
		const pt = this.toLogical(preds[preds.length - 1]);
		this.segOnPages(last, pt, this.active, true);
	}

	// ---------- input ----------

	toLogical(e) {
		const r = this.wrapEl.getBoundingClientRect();
		const t0 = this.strokeT0 != null ? Math.max(0, Math.round(e.timeStamp - this.strokeT0)) : 0;
		return [
			round1((e.clientX - r.left) * (this.docData.width / r.width)),
			round1((e.clientY - r.top) * (this.docData.height / r.height)),
			Math.round((e.pressure || 0) * 1000) / 1000,
			t0,
		];
	}

	bindPointerEvents() {
		// Bound on wrapEl (the page stack), so a single listener set serves
		// every page canvas and keeps working as pages are added/removed.
		const cv = this.wrapEl;
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
			this.wrapEl.setPointerCapture(e.pointerId);
			return;
		}

		if (this.activePointerId != null) return;
		e.preventDefault();
		// Pen touching down kills any palm-initiated pan immediately.
		this.panPointerId = null;
		this.hidePanel();
		this.wrapEl.setPointerCapture(e.pointerId);
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
		else this.drawStrokeFinal(this.active); // renders the initial dot
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
				if (!flat) this.segOnPages(last, pt, this.active, false);
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
		if (isFlatStroke(s)) this.drawStrokeFinal(s);
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

	/** Flatten all page canvases into one PNG (base64) for image-based OCR
	 *  endpoints, downscaled to stay within a safe single-texture size. */
	composePng() {
		const doc = this.docData;
		const maxDim = 4096;
		const sc = Math.min(1, maxDim / Math.max(doc.width, doc.height));
		const cv = document.createElement('canvas');
		cv.width = Math.round(doc.width * sc);
		cv.height = Math.round(doc.height * sc);
		const cx = cv.getContext('2d');
		cx.fillStyle = '#ffffff';
		cx.fillRect(0, 0, cv.width, cv.height);
		const pageH = doc.pageH || doc.height;
		for (let i = 0; i < this.pages.length; i++) {
			cx.drawImage(
				this.pages[i].main,
				0, Math.round(i * pageH * sc),
				cv.width, Math.round(pageH * sc)
			);
		}
		return cv.toDataURL('image/png').split(',')[1];
	}

	async ocrViaEndpoint() {
		const ep = this.plugin.settings.ocrEndpoint;
		if (!ep) {
			throw new Error(t('endpointMissing'));
		}
		const png = this.composePng();
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

		new Setting(containerEl).setName(t('headDisplay')).setHeading();

		new Setting(containerEl)
			.setName(t('setLanguage'))
			.setDesc(t('setLanguageDesc'))
			.addDropdown((d) =>
				d
					.addOption('auto', t('optLangAuto'))
					.addOption('en', t('optEn'))
					.addOption('ja', t('optJa'))
					.setValue(this.plugin.settings.language)
					.onChange(async (v) => {
						this.plugin.settings.language = v;
						resolveLang(v);
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(t('setPageNum'))
			.setDesc(t('setPageNumDesc'))
			.addDropdown((d) =>
				d
					.addOption('off', t('optCornerOff'))
					.addOption('tl', t('optCornerTL'))
					.addOption('tr', t('optCornerTR'))
					.addOption('bl', t('optCornerBL'))
					.addOption('br', t('optCornerBR'))
					.setValue(this.plugin.settings.pageNumPos)
					.onChange(async (v) => {
						this.plugin.settings.pageNumPos = v;
						await this.plugin.saveSettings();
						this.plugin.redrawViews();
					})
			);

		new Setting(containerEl)
			.setName(t('setFloatingBall'))
			.setDesc(t('setFloatingBallDesc'))
			.addToggle((tc) =>
				tc.setValue(this.plugin.settings.floatingBall).onChange(async (v) => {
					this.plugin.settings.floatingBall = v;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				})
			);

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

	/** Rebuild every open Scribe view (toolbar/ball/language changes). */
	refreshViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
			if (leaf.view && typeof leaf.view.rebuild === 'function') leaf.view.rebuild();
		});
	}

	/** Redraw every open Scribe view without rebuilding its UI (page numbers). */
	redrawViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
			if (leaf.view && typeof leaf.view.fullRedraw === 'function') leaf.view.fullRedraw();
		});
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
		resolveLang(this.settings.language);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
};
