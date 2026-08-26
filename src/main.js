// BookOS Calc — frontend
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const tauriWin = () => window.__TAURI__.window.getCurrentWindow();
const $ = (s, r=document) => r.querySelector(s);

// ───────── STATE ─────────
const DEFAULT_SETTINGS = {
  mode: 'standard',
  precision: 12,
  thousands: false,
  keySound: false,
  angleUnit: 'deg', // for scientific
  rates: null,      // currency rates relative to USD
  rateFrom: 'USD',
  rateTo: 'EUR',
  unitCat: 'length',
  unitFrom: null,
  unitTo: null,
  uiLang: 'auto'
};
const DEFAULT_RATES = {
  USD: { name: 'Dólar estadounidense', rate: 1 },
  EUR: { name: 'Euro', rate: 0.92 },
  GBP: { name: 'Libra esterlina', rate: 0.79 },
  JPY: { name: 'Yen japonés', rate: 157 },
  MXN: { name: 'Peso mexicano', rate: 17.2 },
  ARS: { name: 'Peso argentino', rate: 1180 },
  CLP: { name: 'Peso chileno', rate: 970 },
  COP: { name: 'Peso colombiano', rate: 4100 },
  BRL: { name: 'Real brasileño', rate: 5.6 },
  CAD: { name: 'Dólar canadiense', rate: 1.37 },
  CHF: { name: 'Franco suizo', rate: 0.88 },
  CNY: { name: 'Yuan chino', rate: 7.25 },
  AUD: { name: 'Dólar australiano', rate: 1.52 }
};
const MODE_NAMES = {
  standard: 'Estándar',
  scientific: 'Científica',
  currency: 'Monetaria',
  units: 'Unidades'
};
const MODE_PAGE = {
  standard: 'calc',
  scientific: 'scientific',
  currency: 'currency',
  units: 'units'
};
let state = { history: [], theme: 'auto', settings: { ...DEFAULT_SETTINGS } };
let currentPage = 'calc';
let isFullscreen = false;
let fsHotzone = null;

let terms = [];
let dispTerms = [];
let current = '0';
let exprDisplay = '';
let justEvaluated = false;
let awaitingOperand = false;
// For repeating "=" (e.g. 5 + 3 = 8, = 11, = 14)
let lastOp = null;       // canonical op char
let lastOperand = null;  // canonical number string

const MAX_HIST = 50;

async function loadState() {
  try { state = await invoke('load_state'); }
  catch { state = { history: [], theme: 'auto' }; }
  if (!Array.isArray(state.history)) state.history = [];
  if (!state.theme) state.theme = 'auto';
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  if (!state.settings.rates || typeof state.settings.rates !== 'object') {
    state.settings.rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
  }
  if (window.BookosI18n) BookosI18n.setLang(state.settings.uiLang || 'auto');
}
async function saveState() { try { await invoke('save_state', { state }); } catch(e){console.error(e);} }

// ───────── THEME ─────────
async function applyTheme() {
  const root = document.documentElement;
  root.classList.remove('light-mode','dark-mode');
  if (state.theme === 'light') root.classList.add('light-mode');
  else if (state.theme === 'dark') root.classList.add('dark-mode');
  else {
    try {
      const sys = await invoke('detect_system_theme');
      if (sys === 'dark') root.classList.add('dark-mode');
      else if (sys === 'light') root.classList.add('light-mode');
    } catch {}
  }
}
function cycleTheme() {
  state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
  saveState();
  applyTheme();
  toast('Tema: ' + (state.theme === 'auto' ? 'Automático' : state.theme === 'light' ? 'Claro' : 'Oscuro'));
}

// ───────── ENGINE ─────────
const OPS = { '+':'+', '−':'-', '×':'*', '÷':'/' };

function cleanFloat(n) {
  if (!isFinite(n) || n === 0) return n;
  const p = (state.settings && state.settings.precision) || 12;
  return parseFloat(n.toPrecision(p));
}

function applyThousands(s) {
  if (!state.settings || !state.settings.thousands) return s;
  if (s === 'Error') return s;
  if (/e/i.test(s)) return s;
  const neg = s.startsWith('-');
  let body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  let intPart = dot === -1 ? body : body.slice(0, dot);
  const decPart = dot === -1 ? '' : body.slice(dot);
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intPart + decPart;
}

function formatNumber(n) {
  if (!isFinite(n)) return 'Error';
  n = cleanFloat(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e12 || abs < 1e-6) {
    return n.toExponential(6).replace(/\.?0+e/, 'e').replace('e+','e');
  }
  return n.toString();
}

// Safe evaluator for + - * / chains (no Function/eval — CSP-safe).
// Tokenizes the canonical string then applies precedence in two passes.
function evalExpr(canon) {
  if (!canon) return null;
  let s = canon.replace(/[+\-*/]$/, '');
  if (!/^[\-]?[\d.]/.test(s)) return null;

  // Tokenize: numbers (with optional leading unary -) and operators.
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      const prev = toks[toks.length - 1];
      const isUnary = c === '-' && (toks.length === 0 || (typeof prev === 'string' && '+-*/'.includes(prev)));
      if (!isUnary) { toks.push(c); i++; continue; }
      // fall through to read a negative number
    }
    // Number (possibly with leading minus for unary)
    let j = i;
    if (s[j] === '-' || s[j] === '+') j++;
    let sawDigit = false, sawDot = false;
    while (j < s.length) {
      const d = s[j];
      if (d >= '0' && d <= '9') { sawDigit = true; j++; }
      else if (d === '.' && !sawDot) { sawDot = true; j++; }
      else break;
    }
    if (!sawDigit) return null;
    const n = parseFloat(s.slice(i, j));
    if (!isFinite(n)) return null;
    toks.push(n);
    i = j;
  }
  if (!toks.length) return null;

  // Pass 1: * /
  for (let k = 1; k < toks.length - 1; ) {
    const op = toks[k];
    if (op === '*' || op === '/') {
      const a = toks[k - 1], b = toks[k + 1];
      if (typeof a !== 'number' || typeof b !== 'number') return null;
      const r = op === '*' ? a * b : a / b;
      if (!isFinite(r)) return null;
      toks.splice(k - 1, 3, r);
    } else { k += 2; }
  }
  // Pass 2: + -
  let acc = toks[0];
  for (let k = 1; k < toks.length; k += 2) {
    const op = toks[k], b = toks[k + 1];
    if (typeof acc !== 'number' || typeof b !== 'number') return null;
    acc = op === '+' ? acc + b : acc - b;
  }
  if (typeof acc !== 'number' || isNaN(acc)) return null;
  return acc;
}

function setDisplay() {
  $('#display-expr').textContent = exprDisplay;
  const el = $('#display-result');
  const shown = applyThousands(current);
  el.textContent = shown;
  el.classList.remove('shrink','shrink-2','error');
  if (current === 'Error') el.classList.add('error');
  if (shown.length > 10) el.classList.add('shrink');
  if (shown.length > 14) el.classList.add('shrink-2');
  highlightActiveOp();
}

function highlightActiveOp() {
  document.querySelectorAll('.key-op').forEach(b => b.classList.remove('locked'));
  if (!awaitingOperand || !terms.length) return;
  const lastCanon = terms[terms.length-1];
  if (!/[+\-*/]/.test(lastCanon)) return;
  const dispOp = Object.keys(OPS).find(k => OPS[k] === lastCanon);
  if (!dispOp) return;
  const btn = document.querySelector(`.key-op[data-k="${dispOp}"]`);
  if (btn) btn.classList.add('locked');
}

function flashResult() {
  const el = $('#display-result');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function pushHistory(exprD, resultStr) {
  state.history.unshift({ expr: exprD, result: resultStr, t: Date.now() });
  if (state.history.length > MAX_HIST) state.history.length = MAX_HIST;
  saveState();
  if (currentPage === 'history') renderHistory();
}

function rebuildExprDisplay() { exprDisplay = dispTerms.join(' '); }

function resetAll() {
  terms = []; dispTerms = []; current = '0'; exprDisplay = '';
  justEvaluated = false; awaitingOperand = false;
  lastOp = null; lastOperand = null;
}

function handleKey(k) {
  if (current === 'Error' && k !== 'C') {
    if (k === '⌫') { resetAll(); setDisplay(); }
    return;
  }

  if (/^[0-9]$/.test(k)) {
    if (justEvaluated) { resetAll(); }
    if (awaitingOperand) { current = k; awaitingOperand = false; }
    else if (current === '0') current = k;
    else if (current === '-0') current = '-' + k;
    else current = current + k;
    setDisplay();
    return;
  }
  if (k === '.') {
    if (justEvaluated) { resetAll(); }
    if (awaitingOperand) { current = '0.'; awaitingOperand = false; }
    else if (!current.includes('.')) current = current + '.';
    setDisplay();
    return;
  }
  if (k in OPS) {
    if (justEvaluated) { justEvaluated = false; }
    if (awaitingOperand && terms.length) {
      terms[terms.length-1] = OPS[k];
      dispTerms[dispTerms.length-1] = k;
    } else {
      terms.push(current, OPS[k]);
      dispTerms.push(current, k);
      const v = evalExpr(terms.join(''));
      if (v !== null) current = formatNumber(v);
      awaitingOperand = true;
    }
    rebuildExprDisplay();
    setDisplay();
    return;
  }
  if (k === '=') {
    // Repeat "=" path: reapply lastOp + lastOperand to current
    if (justEvaluated && lastOp && lastOperand !== null) {
      const canon = current + lastOp + lastOperand;
      const v = evalExpr(canon);
      if (v === null) { current = 'Error'; setDisplay(); return; }
      const result = formatNumber(v);
      const dispOp = Object.keys(OPS).find(K => OPS[K] === lastOp);
      const finalDisp = current + ' ' + dispOp + ' ' + lastOperand;
      pushHistory(finalDisp, result);
      exprDisplay = finalDisp + ' =';
      current = result;
      setDisplay();
      flashResult();
      return;
    }
    if (!terms.length) return;
    // Remember last op + operand for "=" repeat
    const opIdx = terms.length - 1;
    if (/[+\-*/]/.test(terms[opIdx])) {
      lastOp = terms[opIdx];
      lastOperand = current;
    }
    const canon = terms.join('') + current;
    dispTerms.push(current);
    const v = evalExpr(canon);
    if (v === null) {
      current = 'Error';
      exprDisplay = dispTerms.join(' ');
      setDisplay();
      return;
    }
    const result = formatNumber(v);
    const finalDisp = dispTerms.join(' ');
    pushHistory(finalDisp, result);
    terms = []; dispTerms = [];
    exprDisplay = finalDisp + ' =';
    current = result;
    justEvaluated = true;
    awaitingOperand = false;
    setDisplay();
    flashResult();
    return;
  }
  if (k === 'C') {
    resetAll();
    setDisplay();
    return;
  }
  if (k === '⌫') {
    if (justEvaluated) { resetAll(); setDisplay(); return; }
    if (awaitingOperand && terms.length) {
      // Undo last operator
      dispTerms.pop();
      terms.pop();
      // restore current to previous operand
      const prevOperand = terms.length ? terms[terms.length-1] : '0';
      current = prevOperand;
      if (terms.length) { terms.pop(); dispTerms.pop(); }
      awaitingOperand = false;
      rebuildExprDisplay();
      setDisplay();
      return;
    }
    if (current.length > 1 && !(current.length === 2 && current.startsWith('-'))) {
      current = current.slice(0, -1);
    } else {
      current = '0';
    }
    setDisplay();
    return;
  }
  if (k === '±') {
    if (current === '0') return;
    current = current.startsWith('-') ? current.slice(1) : '-' + current;
    setDisplay();
    return;
  }
  if (k === '%') {
    const n = parseFloat(current);
    if (isNaN(n)) return;
    current = formatNumber(n / 100);
    justEvaluated = false;
    setDisplay();
    return;
  }
}

// ───────── KEY SOUND ─────────
let audioCtx = null;
function playKeyTone(k) {
  if (!state.settings || !state.settings.keySound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    let freq = 660;
    if (k === '=') freq = 880;
    else if (k in OPS) freq = 740;
    else if (k === 'C' || k === '⌫') freq = 520;
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.value = 0;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.start(t); o.stop(t + 0.09);
  } catch {}
}

// ───────── TOAST ─────────
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ───────── CLIPBOARD ─────────
async function copyResult() {
  if (current === 'Error') return;
  try {
    await navigator.clipboard.writeText(current);
    toast('Copiado: ' + current);
  } catch {
    // Fallback selection
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($('#display-result'));
    sel.removeAllRanges();
    sel.addRange(range);
    try { document.execCommand('copy'); toast('Copiado'); } catch {}
    sel.removeAllRanges();
  }
}

async function pasteNumber() {
  try {
    const text = await navigator.clipboard.readText();
    const n = parseFloat(text.replace(',', '.'));
    if (isNaN(n)) { toast('Portapapeles inválido'); return; }
    const s = formatNumber(n);
    if (justEvaluated) resetAll();
    current = s;
    awaitingOperand = false;
    setDisplay();
    toast('Pegado: ' + s);
  } catch { toast('Portapapeles inaccesible'); }
}

// ───────── KEYPAD WIRE ─────────
function wireKeypad() {
  $('#keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    const k = b.dataset.k;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 90);
    playKeyTone(k);
    handleKey(k);
  });
  $('#display-result').addEventListener('click', copyResult);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === 'Escape' && isFullscreen) { toggleFullscreen(); return; }
    // Global shortcuts (work on both pages)
    if (e.ctrlKey || e.metaKey) {
      if (e.key === ',' || e.key === '.') {
        e.preventDefault();
        showPage(currentPage === 'settings' ? 'calc' : 'settings');
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        if (window.getSelection().toString()) return; // allow native copy
        e.preventDefault(); copyResult(); return;
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault(); pasteNumber(); return;
      }
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        showPage(currentPage === 'calc' ? 'history' : 'calc');
        return;
      }
    }
    if (currentPage !== 'calc' && currentPage !== 'scientific') {
      if (e.key === 'Escape') { showPage(modePage()); }
      return;
    }
    // Scientific has its own key handling via the keypad clicks; route digits/ops still
    if (currentPage === 'scientific') {
      const sciMap = {
        'Enter':'=','=':'=','+':'+','-':'−','*':'×','/':'÷',
        '(':'(',')':')','.':'.',',':'.','Backspace':'⌫','Escape':'C','Delete':'C','%':'%'
      };
      let k2 = null;
      if (/^[0-9]$/.test(e.key)) k2 = e.key;
      else if (e.key in sciMap) k2 = sciMap[e.key];
      if (!k2) return;
      e.preventDefault();
      playKeyTone(k2);
      sciHandle(k2);
      return;
    }
    const map = {
      'Enter':'=', '=':'=',
      '+':'+', '-':'−',
      '*':'×', 'x':'×', 'X':'×',
      '/':'÷',
      'Backspace':'⌫',
      'Escape':'C', 'Delete':'C',
      '%':'%',
      '.':'.', ',':'.'
    };
    let k = null;
    if (/^[0-9]$/.test(e.key)) k = e.key;
    else if (e.key in map) k = map[e.key];
    if (!k) return;
    e.preventDefault();
    const btn = document.querySelector(`.key[data-k="${k}"]`);
    if (btn) {
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 90);
    }
    playKeyTone(k);
    handleKey(k);
  });
}

// ───────── HISTORY PAGE ─────────
function renderHistory() {
  const list = $('#hist-list');
  const empty = $('#hist-empty');
  list.innerHTML = '';
  if (!state.history.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  list.classList.remove('hidden');
  empty.classList.add('hidden');
  for (const h of state.history) {
    const item = document.createElement('div');
    item.className = 'hist-item';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    const e1 = document.createElement('div');
    e1.className = 'hist-expr';
    e1.textContent = h.expr;
    const r1 = document.createElement('div');
    r1.className = 'hist-res';
    r1.textContent = h.result;
    item.append(e1, r1);
    const useEntry = () => {
      resetAll();
      current = h.result;
      exprDisplay = '';
      setDisplay();
      showPage('calc');
      toast('Cargado: ' + h.result);
    };
    item.addEventListener('click', useEntry);
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); useEntry(); }
    });
    list.append(item);
  }
}

function modePage() { return MODE_PAGE[state.settings.mode] || 'calc'; }

function showPage(name) {
  if (isFullscreen && name !== modePage()) return;
  currentPage = name;
  const pages = {
    calc: $('#page-calc'),
    scientific: $('#page-scientific'),
    currency: $('#page-currency'),
    units: $('#page-units'),
    history: $('#page-history'),
    settings: $('#page-settings')
  };
  const titles = {
    calc: 'Calculadora',
    scientific: 'Científica',
    currency: 'Monetaria',
    units: 'Unidades',
    history: 'Historial',
    settings: 'Ajustes'
  };
  for (const k in pages) {
    const p = pages[k]; if (!p) continue;
    if (k === name) {
      p.classList.remove('hidden','slide-in-r','slide-in-l');
      void p.offsetWidth;
      p.classList.add(['history','settings'].includes(name) ? 'slide-in-r' : 'slide-in-l');
    } else {
      p.classList.add('hidden');
    }
  }
  $('#history-btn').classList.toggle('active', name === 'history');
  $('#settings-btn').classList.toggle('active', name === 'settings');
  $('#tb-title').textContent = titles[name];
  // Update mode chip label
  const chipLabel = $('#mode-chip-label');
  if (chipLabel) chipLabel.textContent = MODE_NAMES[state.settings.mode] || 'Estándar';
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'currency') renderCurrency();
  if (name === 'units') renderUnits();
  if (name === 'scientific') renderScientific();
}

function setMode(m) {
  if (!(m in MODE_NAMES)) return;
  state.settings.mode = m;
  saveState();
  showPage(MODE_PAGE[m]);
  setSeg('seg-mode', m);
  // Update menu marks
  document.querySelectorAll('#mode-menu button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === m);
  });
}

// ───────── SETTINGS PAGE ─────────
function renderSettings() {
  // Theme segmented
  setSeg('seg-theme', state.theme);
  setSeg('seg-mode', state.settings.mode);
  setSeg('seg-precision', String(state.settings.precision));
  setToggle('tg-thousands', state.settings.thousands);
  setToggle('tg-sound', state.settings.keySound);
  $('#hist-count').textContent = state.history.length;
}
function setSeg(id, value) {
  const root = document.getElementById(id);
  if (!root) return;
  root.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === value);
  });
}
function setToggle(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('active', !!on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}
function wireSettingsPage() {
  // Segmented controls
  document.querySelectorAll('.seg').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const key = seg.dataset.key;
      const val = btn.dataset.v;
      if (key === 'theme') {
        state.theme = val;
        applyTheme();
      } else if (key === 'precision') {
        state.settings.precision = parseInt(val, 10);
        // Reformat current number
        const n = parseFloat(current);
        if (!isNaN(n)) current = formatNumber(n);
        setDisplay();
      } else if (key === 'mode') {
        setMode(val);
        setSeg(seg.id, val);
        return;
      } else if (key === 'unitcat') {
        state.settings.unitCat = val;
        state.settings.unitFrom = null;
        state.settings.unitTo = null;
        renderUnits();
      }
      setSeg(seg.id, val);
      saveState();
    });
  });
  // Toggles
  const wireToggle = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    const fire = () => {
      state.settings[key] = !state.settings[key];
      setToggle(id, state.settings[key]);
      saveState();
      if (key === 'thousands') setDisplay();
    };
    el.addEventListener('click', fire);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
    });
  };
  wireToggle('tg-thousands', 'thousands');
  wireToggle('tg-sound', 'keySound');
  const langSel = $('#ui-lang');
  if (langSel) {
    langSel.value = state.settings.uiLang || 'auto';
    langSel.addEventListener('change', () => {
      state.settings.uiLang = langSel.value;
      saveState();
      if (window.BookosI18n) BookosI18n.setLang(langSel.value);
    });
  }
  // Clear history row
  $('#row-clear-hist').addEventListener('click', () => {
    if (!state.history.length) { toast('Historial ya está vacío'); return; }
    state.history = [];
    saveState();
    renderSettings();
    toast('Historial limpiado');
  });
}

// ───────── FULLSCREEN ─────────
async function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  const mc = $('#mc');
  // Apply CSS state immediately so layout responds regardless of Tauri call result
  mc.classList.toggle('fullscreen-calc', isFullscreen);
  mc.classList.toggle('windowed', !isFullscreen);
  if (isFullscreen) {
    if (!['calc','scientific','currency','units'].includes(currentPage)) showPage(modePage());
    setupFsChrome();
  } else {
    teardownFsChrome();
  }
  // Then try to drive the actual window state
  try {
    await tauriWin().setFullscreen(isFullscreen);
  } catch (e) {
    console.error('setFullscreen failed, falling back to maximize:', e);
    try { await tauriWin().toggleMaximize(); } catch (e2) { console.error(e2); }
  }
}
function setupFsChrome() {
  const mc = $('#mc');
  const titlebar = $('.titlebar');
  if (fsHotzone) fsHotzone.remove();
  fsHotzone = document.createElement('div');
  fsHotzone.className = 'fs-hotzone';
  document.body.append(fsHotzone);
  const show = () => mc.classList.add('show-chrome');
  const hide = () => mc.classList.remove('show-chrome');
  fsHotzone.addEventListener('mouseenter', show);
  titlebar.addEventListener('mouseenter', show);
  titlebar.addEventListener('mouseleave', hide);
}
function teardownFsChrome() {
  const mc = $('#mc');
  mc.classList.remove('show-chrome');
  if (fsHotzone) { fsHotzone.remove(); fsHotzone = null; }
}

// ───────── WINDOW CTRL ─────────
function wireWindow() {
  $('#minimize').addEventListener('click', () => tauriWin().minimize());
  $('#maximize').addEventListener('click', () => tauriWin().toggleMaximize());
  $('#close').addEventListener('click', () => tauriWin().close());
  $('#theme-btn').addEventListener('click', cycleTheme);
  $('#fullscreen-btn').addEventListener('click', toggleFullscreen);
  $('#history-btn').addEventListener('click', () => {
    showPage(currentPage === 'history' ? modePage() : 'history');
  });
  $('#settings-btn').addEventListener('click', () => {
    showPage(currentPage === 'settings' ? modePage() : 'settings');
  });
  $('#hist-clear').addEventListener('click', () => {
    if (!state.history.length) return;
    state.history = [];
    saveState();
    renderHistory();
    toast('Historial limpiado');
  });
}

// ───────── SYSTEM THEME LISTENER ─────────
function wireSystemTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => { if (state.theme === 'auto') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', handler);
  else if (mq.addListener) mq.addListener(handler);
  // Antes había aquí un setInterval de 5s. Cada vuelta llamaba a
  // detect_system_theme, que lanza hasta 3 procesos (kreadconfig6, kreadconfig5,
  // gsettings), y corría siempre: con la app minimizada, con la pantalla
  // bloqueada, toda la sesión. Unas 17.000 comprobaciones al día por app.
  //
  // matchMedia cubre el caso normal. Para los cambios de tema del escritorio que
  // matchMedia no ve, basta con volver a mirar cuando la ventana recupera el
  // foco o la visibilidad: es justo el momento en que el usuario vuelve de
  // Ajustes y podría notar el desajuste.
  const recheck = () => { if (state.theme === 'auto' && !document.hidden) applyTheme(); };
  document.addEventListener('visibilitychange', recheck);
  window.addEventListener('focus', recheck);
}

// ───────── SCIENTIFIC ─────────
let sciExpr = '';      // canonical JS expression
let sciDisplay = '';   // pretty display
let sciResult = '0';
let sciAns = 0;
let sciJustEvaluated = false;

function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function sciEval(canon) {
  if (!canon) return null;
  try {
    const angle = state.settings.angleUnit;
    const sin = angle === 'deg' ? (x) => Math.sin(x * Math.PI / 180) : Math.sin;
    const cos = angle === 'deg' ? (x) => Math.cos(x * Math.PI / 180) : Math.cos;
    const tan = angle === 'deg' ? (x) => Math.tan(x * Math.PI / 180) : Math.tan;
    const fn = new Function('sin','cos','tan','ln','log','sqrt','abs','pow','exp','pi','e','fact','ans','mod',
      '"use strict";return (' + canon + ')');
    const v = fn(sin, cos, tan, Math.log, Math.log10, Math.sqrt, Math.abs, Math.pow, Math.exp,
      Math.PI, Math.E, factorial, sciAns, (a,b)=>a%b);
    if (typeof v !== 'number' || isNaN(v)) return null;
    return v;
  } catch { return null; }
}

function sciSetDisplay() {
  $('#sci-expr').textContent = sciDisplay;
  const el = $('#sci-result');
  const shown = applyThousands(sciResult);
  el.textContent = shown;
  el.classList.remove('shrink','shrink-2','error');
  if (sciResult === 'Error') el.classList.add('error');
  if (shown.length > 10) el.classList.add('shrink');
  if (shown.length > 14) el.classList.add('shrink-2');
}

function sciHandle(k) {
  if (sciResult === 'Error' && k !== 'C') {
    if (k === '⌫') { sciExpr=''; sciDisplay=''; sciResult='0'; sciSetDisplay(); }
    return;
  }
  const append = (canon, disp) => {
    if (sciJustEvaluated) {
      // If next key is digit/var, start fresh; if op, continue with Ans
      if (/^[0-9.(]/.test(canon) || /^(sin|cos|tan|ln|log|sqrt|abs|pi|e\b|fact)/.test(canon)) {
        sciExpr = ''; sciDisplay = '';
      } else {
        sciExpr = 'ans'; sciDisplay = 'Ans';
      }
      sciJustEvaluated = false;
    }
    sciExpr += canon;
    sciDisplay += disp;
  };

  if (/^[0-9]$/.test(k)) { append(k, k); }
  else if (k === '00') { append('00', '00'); }
  else if (k === '.') { append('.', '.'); }
  else if (k === '+') { append('+', ' + '); }
  else if (k === '−') { append('-', ' − '); }
  else if (k === '×') { append('*', ' × '); }
  else if (k === '÷') { append('/', ' ÷ '); }
  else if (k === '(') { append('(', '('); }
  else if (k === ')') { append(')', ')'); }
  else if (k === 'π') { append('pi', 'π'); }
  else if (k === 'e') { append('e', 'e'); }
  else if (k === 'sin') { append('sin(', 'sin('); }
  else if (k === 'cos') { append('cos(', 'cos('); }
  else if (k === 'tan') { append('tan(', 'tan('); }
  else if (k === 'ln') { append('ln(', 'ln('); }
  else if (k === 'log') { append('log(', 'log('); }
  else if (k === '√') { append('sqrt(', '√('); }
  else if (k === 'abs') { append('abs(', '|'); }
  else if (k === 'x²') { append('**2', '²'); }
  else if (k === 'xʸ') { append('**', '^'); }
  else if (k === '1/x') { append('1/(', '1/('); }
  else if (k === '!') { append(')', '!'); /* visual only */ if (sciExpr.endsWith(')')) {
      // Replace last token with fact(token)
      // simpler: postfix-treat: find last number/group and wrap in fact()
      const m = sciExpr.match(/(\d+(?:\.\d+)?|\([^()]*\))\)$/);
      if (m) {
        const lastTok = m[1];
        sciExpr = sciExpr.slice(0, sciExpr.length - lastTok.length - 1) + 'fact(' + lastTok + ')';
      }
    }
  }
  else if (k === 'mod') { append('%', ' mod '); }
  else if (k === 'ee') { append('*10**', '·10^'); }
  else if (k === 'exp') { append('exp(', 'exp('); }
  else if (k === '%') {
    // percent: divide last number by 100
    const m = sciExpr.match(/(\d+(?:\.\d+)?)$/);
    if (m) {
      const tok = m[1];
      sciExpr = sciExpr.slice(0, -tok.length) + '(' + tok + '/100)';
      sciDisplay = sciDisplay.slice(0, sciDisplay.lastIndexOf(tok)) + tok + '%';
    }
  }
  else if (k === 'ans') { append('ans', 'Ans'); }
  else if (k === 'C') { sciExpr=''; sciDisplay=''; sciResult='0'; sciJustEvaluated=false; }
  else if (k === '⌫') {
    if (sciJustEvaluated) { sciExpr=''; sciDisplay=''; sciResult='0'; sciJustEvaluated=false; }
    else {
      // remove last token (heuristic: strip multi-char fn or single char)
      const reCanon = /(sin\(|cos\(|tan\(|ln\(|log\(|sqrt\(|abs\(|exp\(|fact\(|ans|pi|\*\*|.)$/;
      const reDisp = /(sin\(|cos\(|tan\(|ln\(|log\(|√\(|exp\(|Ans| · |·10\^| mod |\s.\s|\^|²|.)$/;
      sciExpr = sciExpr.replace(reCanon, '');
      sciDisplay = sciDisplay.replace(reDisp, '');
    }
  }
  else if (k === '±') {
    // wrap last number in -()
    const m = sciExpr.match(/(\d+(?:\.\d+)?)$/);
    if (m) {
      const tok = m[1];
      sciExpr = sciExpr.slice(0, -tok.length) + '(-' + tok + ')';
      sciDisplay = sciDisplay.slice(0, sciDisplay.lastIndexOf(tok)) + '(-' + tok + ')';
    }
  }
  else if (k === 'deg') {
    state.settings.angleUnit = state.settings.angleUnit === 'deg' ? 'rad' : 'deg';
    saveState();
    $('#sci-deg').textContent = state.settings.angleUnit.toUpperCase();
    return;
  }
  else if (k === '=') {
    let exprBalanced = sciExpr;
    // auto-close unmatched (
    const open = (exprBalanced.match(/\(/g) || []).length;
    const close = (exprBalanced.match(/\)/g) || []).length;
    if (open > close) exprBalanced += ')'.repeat(open - close);
    const v = sciEval(exprBalanced);
    if (v === null) { sciResult = 'Error'; sciSetDisplay(); return; }
    const r = formatNumber(v);
    pushHistory(sciDisplay + (open > close ? ')'.repeat(open - close) : ''), r);
    sciAns = v;
    sciResult = r;
    sciDisplay = sciDisplay + (open > close ? ')'.repeat(open - close) : '') + ' =';
    sciExpr = String(v);
    sciJustEvaluated = true;
  }
  sciSetDisplay();
}

function renderScientific() {
  $('#sci-deg').textContent = state.settings.angleUnit.toUpperCase();
  sciSetDisplay();
}

function wireScientific() {
  $('#keypad-sci').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 90);
    playKeyTone(b.dataset.k);
    sciHandle(b.dataset.k);
  });
}

// ───────── CURRENCY ─────────
function populateCurrencySelects() {
  const codes = Object.keys(state.settings.rates).sort();
  for (const id of ['cur-from', 'cur-to']) {
    const sel = $('#' + id);
    sel.innerHTML = '';
    for (const c of codes) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c + ' — ' + state.settings.rates[c].name;
      sel.append(o);
    }
  }
  $('#cur-from').value = state.settings.rateFrom in state.settings.rates ? state.settings.rateFrom : codes[0];
  $('#cur-to').value = state.settings.rateTo in state.settings.rates ? state.settings.rateTo : codes[1] || codes[0];
}

function currencyConvert() {
  const from = $('#cur-from').value;
  const to = $('#cur-to').value;
  const valStr = $('#cur-from-val').value.replace(',', '.');
  const v = parseFloat(valStr);
  const r = state.settings.rates;
  if (isNaN(v) || !r[from] || !r[to]) { $('#cur-to-val').value = ''; return; }
  // rates are "X per 1 USD" → usd = v/from.rate; result = usd*to.rate
  const result = (v / r[from].rate) * r[to].rate;
  $('#cur-to-val').value = formatNumber(result);
}

function renderRateList() {
  const list = $('#rate-list');
  list.innerHTML = '';
  const codes = Object.keys(state.settings.rates).sort();
  for (const code of codes) {
    const row = document.createElement('div');
    row.className = 'rate-row';
    // Sin innerHTML con datos del usuario: el nombre/código de una moneda
    // añadida a mano no debe poder inyectar HTML en el webview.
    row.innerHTML = `
      <div class="rate-code"></div>
      <div class="rate-name"></div>
      <input class="rate-val" type="text" inputmode="decimal">
      <button class="rate-del" title="Eliminar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6l12 12"/></svg>
      </button>`;
    row.querySelector('.rate-code').textContent = code;
    row.querySelector('.rate-name').textContent = state.settings.rates[code].name;
    const inp = row.querySelector('.rate-val');
    inp.dataset.code = code;
    inp.value = state.settings.rates[code].rate;
    const del = row.querySelector('.rate-del');
    del.dataset.code = code;
    del.setAttribute('aria-label', 'Eliminar ' + code);
    list.append(row);
  }
  list.querySelectorAll('.rate-val').forEach(i => {
    i.addEventListener('input', (e) => {
      const code = e.target.dataset.code;
      const v = parseFloat(e.target.value.replace(',', '.'));
      if (!isNaN(v) && v > 0) {
        state.settings.rates[code].rate = v;
        saveState();
        currencyConvert();
      }
    });
  });
  list.querySelectorAll('.rate-del').forEach(b => {
    b.addEventListener('click', (e) => {
      const code = e.currentTarget.dataset.code;
      if (code === 'USD') { toast('USD es la base, no se puede borrar'); return; }
      if (Object.keys(state.settings.rates).length <= 2) { toast('Mínimo 2 divisas'); return; }
      delete state.settings.rates[code];
      saveState();
      populateCurrencySelects();
      renderRateList();
      currencyConvert();
    });
  });
}

function addRatePrompt() {
  const code = prompt('Código de divisa (ej: NZD, KRW, INR)');
  if (!code) return;
  const C = code.trim().toUpperCase().slice(0, 5);
  if (state.settings.rates[C]) { toast(C + ' ya existe'); return; }
  const name = prompt('Nombre de la divisa', C) || C;
  const rateStr = prompt('Tasa relativa al USD (cuántos ' + C + ' = 1 USD)', '1');
  const rate = parseFloat((rateStr || '1').replace(',', '.'));
  if (isNaN(rate) || rate <= 0) { toast('Tasa inválida'); return; }
  state.settings.rates[C] = { name, rate };
  saveState();
  populateCurrencySelects();
  renderRateList();
  toast('Añadida: ' + C);
}

function renderCurrency() {
  populateCurrencySelects();
  renderRateList();
  currencyConvert();
}

function wireCurrency() {
  $('#cur-from').addEventListener('change', (e) => {
    state.settings.rateFrom = e.target.value;
    saveState();
    currencyConvert();
  });
  $('#cur-to').addEventListener('change', (e) => {
    state.settings.rateTo = e.target.value;
    saveState();
    currencyConvert();
  });
  $('#cur-from-val').addEventListener('input', currencyConvert);
  $('#rate-add').addEventListener('click', addRatePrompt);
}

// ───────── UNITS ─────────
const UNITS = {
  length: {
    label: 'Longitud',
    base: 'm',
    items: {
      mm: { name: 'Milímetros', f: 0.001 },
      cm: { name: 'Centímetros', f: 0.01 },
      m:  { name: 'Metros', f: 1 },
      km: { name: 'Kilómetros', f: 1000 },
      in: { name: 'Pulgadas', f: 0.0254 },
      ft: { name: 'Pies', f: 0.3048 },
      yd: { name: 'Yardas', f: 0.9144 },
      mi: { name: 'Millas', f: 1609.344 },
      nmi:{ name: 'Millas náuticas', f: 1852 }
    }
  },
  mass: {
    label: 'Masa',
    base: 'kg',
    items: {
      mg: { name: 'Miligramos', f: 1e-6 },
      g:  { name: 'Gramos', f: 0.001 },
      kg: { name: 'Kilogramos', f: 1 },
      t:  { name: 'Toneladas', f: 1000 },
      oz: { name: 'Onzas', f: 0.0283495 },
      lb: { name: 'Libras', f: 0.453592 },
      st: { name: 'Stones', f: 6.35029 }
    }
  },
  temperature: {
    label: 'Temperatura',
    base: 'C',
    items: {
      C: { name: 'Celsius' },
      F: { name: 'Fahrenheit' },
      K: { name: 'Kelvin' }
    }
  },
  volume: {
    label: 'Volumen',
    base: 'L',
    items: {
      ml: { name: 'Mililitros', f: 0.001 },
      cl: { name: 'Centilitros', f: 0.01 },
      L:  { name: 'Litros', f: 1 },
      m3: { name: 'Metros cúbicos', f: 1000 },
      tsp:{ name: 'Cucharaditas', f: 0.00492892 },
      tbsp:{name: 'Cucharadas', f: 0.0147868 },
      cup:{ name: 'Tazas (US)', f: 0.236588 },
      pt: { name: 'Pintas (US)', f: 0.473176 },
      gal:{ name: 'Galones (US)', f: 3.78541 }
    }
  },
  area: {
    label: 'Área',
    base: 'm2',
    items: {
      mm2:{ name: 'Milímetros²', f: 1e-6 },
      cm2:{ name: 'Centímetros²', f: 0.0001 },
      m2: { name: 'Metros²', f: 1 },
      ha: { name: 'Hectáreas', f: 10000 },
      km2:{ name: 'Kilómetros²', f: 1e6 },
      in2:{ name: 'Pulgadas²', f: 0.00064516 },
      ft2:{ name: 'Pies²', f: 0.092903 },
      ac: { name: 'Acres', f: 4046.86 }
    }
  },
  time: {
    label: 'Tiempo',
    base: 's',
    items: {
      ms:{ name: 'Milisegundos', f: 0.001 },
      s: { name: 'Segundos', f: 1 },
      min:{name: 'Minutos', f: 60 },
      h: { name: 'Horas', f: 3600 },
      d: { name: 'Días', f: 86400 },
      wk:{ name: 'Semanas', f: 604800 },
      yr:{ name: 'Años', f: 31557600 }
    }
  }
};

function convertUnit(cat, from, to, v) {
  if (cat === 'temperature') {
    // Convert from→C then C→to
    let c;
    if (from === 'C') c = v;
    else if (from === 'F') c = (v - 32) * 5/9;
    else if (from === 'K') c = v - 273.15;
    else return NaN;
    if (to === 'C') return c;
    if (to === 'F') return c * 9/5 + 32;
    if (to === 'K') return c + 273.15;
    return NaN;
  }
  const items = UNITS[cat].items;
  if (!items[from] || !items[to]) return NaN;
  return v * items[from].f / items[to].f;
}

function populateUnitSelects() {
  const cat = state.settings.unitCat;
  const items = UNITS[cat].items;
  const codes = Object.keys(items);
  for (const id of ['unit-from', 'unit-to']) {
    const sel = $('#' + id);
    sel.innerHTML = '';
    for (const c of codes) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c + ' — ' + items[c].name;
      sel.append(o);
    }
  }
  $('#unit-from').value = (state.settings.unitFrom && items[state.settings.unitFrom]) ? state.settings.unitFrom : codes[0];
  $('#unit-to').value = (state.settings.unitTo && items[state.settings.unitTo]) ? state.settings.unitTo : (codes[1] || codes[0]);
}

function unitConvert() {
  const cat = state.settings.unitCat;
  const from = $('#unit-from').value;
  const to = $('#unit-to').value;
  const valStr = $('#unit-from-val').value.replace(',', '.');
  const v = parseFloat(valStr);
  if (isNaN(v)) { $('#unit-to-val').value = ''; return; }
  const r = convertUnit(cat, from, to, v);
  $('#unit-to-val').value = isNaN(r) ? '' : formatNumber(r);
}

function renderUnits() {
  setSeg('seg-unit-cat', state.settings.unitCat);
  populateUnitSelects();
  unitConvert();
}

function wireUnits() {
  $('#unit-from').addEventListener('change', (e) => {
    state.settings.unitFrom = e.target.value;
    saveState();
    unitConvert();
  });
  $('#unit-to').addEventListener('change', (e) => {
    state.settings.unitTo = e.target.value;
    saveState();
    unitConvert();
  });
  $('#unit-from-val').addEventListener('input', unitConvert);
}

// ───────── MODE CHIP ─────────
function wireModeChip() {
  const chip = $('#mode-chip');
  const menu = $('#mode-menu');
  const open = () => {
    menu.classList.remove('hidden');
    document.querySelectorAll('#mode-menu button').forEach(b => {
      b.classList.toggle('on', b.dataset.mode === state.settings.mode);
    });
    setTimeout(() => document.addEventListener('click', closeOnOut), 0);
  };
  const close = () => { menu.classList.add('hidden'); document.removeEventListener('click', closeOnOut); };
  const closeOnOut = (e) => { if (!menu.contains(e.target) && e.target !== chip) close(); };
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    setMode(b.dataset.mode);
    close();
  });
}

// ───────── BLOCK ZOOM / CONTEXT MENU ─────────
function blockZoom() {
  // Ctrl+wheel
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); }
  }, { passive: false });
  // Ctrl+ +/- / 0
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+','-','=','_','0'].includes(e.key)) {
      // allow our own '=' inside calc by checking if calc page; Ctrl+= rarely used elsewhere
      if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_' || e.key === '0') {
        // but DON'T block plain '=' / '+' / '-' / '0' without ctrl
        if (e.ctrlKey || e.metaKey) e.preventDefault();
      }
    }
  });
  // Pinch zoom
  window.addEventListener('gesturestart', e => e.preventDefault());
  window.addEventListener('gesturechange', e => e.preventDefault());
  document.addEventListener('contextmenu', e => e.preventDefault());
}

// ───────── BOOT ─────────
(async function init() {
  await loadState();
  await applyTheme();
  wireWindow();
  wireKeypad();
  wireScientific();
  wireCurrency();
  wireUnits();
  wireModeChip();
  wireSettingsPage();
  wireSystemTheme();
  blockZoom();
  setDisplay();
  // Show the correct page for current mode
  showPage(modePage());
})();
