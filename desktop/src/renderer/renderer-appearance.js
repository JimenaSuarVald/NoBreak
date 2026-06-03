// renderer-appearance.js — apariencia visual: tamano de tarjetas de album,
// accesibilidad (texto/tipografia/colores) y presets de tema con sus pickers.

// --- Album-card sizing ------------------------------------------------------
// Tamaño mínimo de las cards de álbum, en px. Se almacena el valor en
// crudo en localStorage (nobreak-album-size-px) y se aplica a la variable
// CSS --album-card-min. Vive antes del IIFE de boot porque éste lo llama
// de forma síncrona y los `const` no se hoistean (TDZ).
function getAlbumSizePx() {
    const v = Number(localStorage.getItem('nobreak-album-size-px'));
    if (v >= 80 && v <= 400) return v;
    // Migración de la versión vieja con valores small/medium/large.
    const old = localStorage.getItem('nobreak-album-size');
    if (old === 'small')  return 130;
    if (old === 'medium') return 180;
    if (old === 'large')  return 240;
    return 180;
}
function applyAlbumSizePx(px) {
    px = Math.max(80, Math.min(400, Number(px) || 180));
    document.documentElement.style.setProperty('--album-card-min', px + 'px');
    localStorage.setItem('nobreak-album-size-px', String(px));
    syncAlbumSizeUi(px);
}
function syncAlbumSizeUi(px) {
    const slider = document.getElementById('album-size-slider');
    if (slider && Number(slider.value) !== px) slider.value = px;
    const label = document.getElementById('album-size-value');
    if (label) label.textContent = px + ' px';
    document.querySelectorAll('.settings-size-btn').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.px) === px);
    });
}
function setupAlbumSize() {
    applyAlbumSizePx(getAlbumSizePx());
    const slider = document.getElementById('album-size-slider');
    slider?.addEventListener('input', () => applyAlbumSizePx(slider.value));
    document.querySelectorAll('.settings-size-btn').forEach(b => {
        b.addEventListener('click', () => applyAlbumSizePx(b.dataset.px));
    });
}

// --- Accesibilidad: tamaño del texto, tipografía y colores ----------------
// Se guarda como un único JSON en localStorage ('nobreak-accessibility').
// Los colores reutilizan el sistema de "custom colors" del tema; los
// pickers de esta sección comparten estado con los de Apariencia.

const FONT_FAMILIES = {
    system: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
    sans:   "'Inter', 'Helvetica Neue', Arial, sans-serif",
    serif:  "'Georgia', 'Times New Roman', serif",
    mono:   "'Consolas', 'Courier New', monospace",
};

function getAccessibility() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem('nobreak-accessibility') || '{}') || {}; }
    catch { raw = {}; }
    const scale = Number(raw.textScale);
    return {
        textScale:  (Number.isFinite(scale) && scale >= 0.5 && scale <= 2) ? scale : 1,
        fontFamily: FONT_FAMILIES[raw.fontFamily] ? raw.fontFamily : 'system',
    };
}
function setAccessibility(partial) {
    const next = { ...getAccessibility(), ...partial };
    if (next.textScale < 0.5) next.textScale = 0.5;
    if (next.textScale > 2)   next.textScale = 2;
    if (!FONT_FAMILIES[next.fontFamily]) next.fontFamily = 'system';
    localStorage.setItem('nobreak-accessibility', JSON.stringify(next));
    return next;
}
function applyAccessibility(a) {
    const cfg = a || getAccessibility();
    // Zoom estilo Chrome (no afecta al layout, sólo escala el render). Si la
    // API no está disponible aún (boot muy temprano) se intenta más tarde
    // — el flag se queda en applyAccessibility-on-next-paint.
    if (window.api && typeof window.api.setZoomFactor === 'function') {
        try { window.api.setZoomFactor(cfg.textScale); }
        catch (e) { console.warn('[a11y] setZoomFactor failed:', e?.message); }
    }
    document.documentElement.style.setProperty('--app-font-family', FONT_FAMILIES[cfg.fontFamily]);
    // Sync labels/inputs si existen (showApp ya los habrá creado).
    const slider = document.getElementById('text-scale-slider');
    if (slider) slider.value = String(Math.round(cfg.textScale * 100));
    const label = document.getElementById('text-scale-value');
    if (label) label.textContent = Math.round(cfg.textScale * 100) + ' %';
    const sel = document.getElementById('font-family-select');
    if (sel && sel.value !== cfg.fontFamily) sel.value = cfg.fontFamily;
}

function setupAccessibility() {
    // Renderiza color-pickers para --fg y --fg-dim — reutilizan applyCustomColor
    // del sistema de tema, así un cambio aquí se ve también en Apariencia.
    const pickersEl = document.getElementById('a11y-color-pickers');
    if (pickersEl) {
        pickersEl.innerHTML = '';
        for (const [v, label] of [['--fg', 'Texto'], ['--fg-dim', 'Texto tenue']]) {
            const wrap = document.createElement('div');
            wrap.className = 'color-picker';
            wrap.innerHTML = `
                <label for="a11y-cp-${v.replace(/--/, '')}">${label}</label>
                <input type="color" id="a11y-cp-${v.replace(/--/, '')}" data-var="${v}">
            `;
            const input = wrap.querySelector('input');
            input.addEventListener('input', () => applyCustomColor(v, input.value));
            pickersEl.appendChild(wrap);
        }
        // syncThemeUi recorre cualquier .color-picker input — incluye los nuevos.
        syncThemeUi();
    }

    applyAccessibility(getAccessibility());

    const slider = document.getElementById('text-scale-slider');
    slider?.addEventListener('input', () => {
        const cfg = setAccessibility({ textScale: Number(slider.value) / 100 });
        applyAccessibility(cfg);
    });

    const fontSel = document.getElementById('font-family-select');
    fontSel?.addEventListener('change', () => {
        const cfg = setAccessibility({ fontFamily: fontSel.value });
        applyAccessibility(cfg);
    });

    document.getElementById('a11y-reset')?.addEventListener('click', () => {
        const cfg = setAccessibility({ textScale: 1, fontFamily: 'system' });
        applyAccessibility(cfg);
    });
}

function setupLibraryRefresh() {
    document.getElementById('settings-rescan')?.addEventListener('click', async () => {
        $('status-bar').textContent = 'Re-escaneando biblioteca…';
        try {
            await window.api.rescan();
            $('status-bar').textContent = 'Escaneo lanzado. Los géneros se irán rellenando con MusicBrainz en segundo plano (1 álbum/seg).';
        } catch (e) { alert('No se pudo re-escanear: ' + e.message); }
    });
    document.getElementById('settings-refresh-tags')?.addEventListener('click', async () => {
        try {
            await window.api.refreshTags();
            $('status-bar').textContent = 'Re-análisis de tags de MusicBrainz en marcha (1 álbum/seg).';
        } catch (e) { alert('No se pudo lanzar el re-análisis: ' + e.message); }
    });
}

// --- Tema (presets + color pickers) ----------------------------------------
// Cada preset es una paleta coherente. data-theme se ajusta a "dark" o
// "light" para que selectores del CSS antiguo sigan funcionando.
const THEME_PRESETS = {
    'rojo-carmesi': {
        label: 'Rojo carmesí',
        light: false,
        vars: {
            '--bg':       '#0d0809',
            '--bg-elev':  '#1a1012',
            '--bg-deep':  '#050203',
            '--fg':       '#f4eaec',
            '--fg-dim':   '#9c7a80',
            '--line':     '#2d1a1f',
            '--field-bg': '#1f1316',
            '--field-bd': '#3d2228',
            '--accent':   '#dc2626',
            '--error':    '#f87171',
        },
    },
    'vinilo-nocturno': {
        label: 'Vinilo nocturno',
        light: false,
        vars: {
            '--bg':       '#0a0a14',
            '--bg-elev':  '#15152a',
            '--bg-deep':  '#04040a',
            '--fg':       '#e8e6f0',
            '--fg-dim':   '#8a87a8',
            '--line':     '#252540',
            '--field-bg': '#1a1a30',
            '--field-bd': '#3a3a5a',
            '--accent':   '#f59e0b',
            '--error':    '#ef4444',
        },
    },
    'neon-cyberpunk': {
        label: 'Neón cyberpunk',
        light: false,
        vars: {
            '--bg':       '#08050f',
            '--bg-elev':  '#12091e',
            '--bg-deep':  '#020108',
            '--fg':       '#e0d4ff',
            '--fg-dim':   '#9080b0',
            '--line':     '#2a1450',
            '--field-bg': '#180c2e',
            '--field-bd': '#4a2580',
            '--accent':   '#ff2e88',
            '--error':    '#ff4040',
        },
    },
    'bosque-otonal': {
        label: 'Bosque otoñal',
        light: false,
        vars: {
            '--bg':       '#1a0f08',
            '--bg-elev':  '#241810',
            '--bg-deep':  '#0f0904',
            '--fg':       '#f0e4d4',
            '--fg-dim':   '#a89070',
            '--line':     '#3a2818',
            '--field-bg': '#241810',
            '--field-bd': '#4a3520',
            '--accent':   '#d97706',
            '--error':    '#dc2626',
        },
    },
    'origami': {
        label: 'Origami',
        light: true,
        vars: {
            '--bg':       '#faf7f2',
            '--bg-elev':  '#ffffff',
            '--bg-deep':  '#ebe7e0',
            '--fg':       '#1c1a18',
            '--fg-dim':   '#6c6862',
            '--line':     '#d8d2c8',
            '--field-bg': '#ffffff',
            '--field-bd': '#c8c0b4',
            '--accent':   '#b91c1c',
            '--error':    '#dc2626',
        },
    },
};

// Etiquetas amigables para cada variable expuesta al color-picker.
const COLOR_VARS = [
    ['--bg',        'Fondo'],
    ['--bg-elev',   'Fondo elevado'],
    ['--bg-deep',   'Fondo profundo'],
    ['--fg',        'Texto'],
    ['--fg-dim',    'Texto tenue'],
    ['--line',      'Líneas'],
    ['--field-bg',  'Campos (fondo)'],
    ['--field-bd',  'Campos (borde)'],
    ['--accent',    'Acento'],
    ['--error',     'Error'],
];

function getThemePreset() {
    const v = localStorage.getItem('nobreak-theme-preset');
    return THEME_PRESETS[v] ? v : 'rojo-carmesi';
}
function getCustomColors() {
    try { return JSON.parse(localStorage.getItem('nobreak-theme-custom') || '{}') || {}; }
    catch { return {}; }
}
function setCustomColors(obj) {
    localStorage.setItem('nobreak-theme-custom', JSON.stringify(obj || {}));
}

function applyThemePreset(presetKey, opts = {}) {
    const preset = THEME_PRESETS[presetKey] || THEME_PRESETS['rojo-carmesi'];
    document.documentElement.setAttribute('data-theme', preset.light ? 'light' : 'dark');
    const custom = opts.keepCustom === false ? {} : getCustomColors();
    for (const [v] of COLOR_VARS) {
        const value = custom[v] || preset.vars[v] || '';
        document.documentElement.style.setProperty(v, value);
    }
    localStorage.setItem('nobreak-theme-preset', presetKey);
    if (opts.keepCustom === false) setCustomColors({});
    syncThemeUi();
}

function applyCustomColor(varName, value) {
    const custom = getCustomColors();
    if (value) custom[varName] = value;
    else delete custom[varName];
    setCustomColors(custom);
    const preset = THEME_PRESETS[getThemePreset()];
    document.documentElement.style.setProperty(varName, value || preset.vars[varName] || '');
    syncThemeUi();
}

function syncThemeUi() {
    const presetKey = getThemePreset();
    document.querySelectorAll('.theme-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.preset === presetKey);
    });
    // Color pickers reflejan el color activo en ese momento.
    const custom = getCustomColors();
    const preset = THEME_PRESETS[presetKey];
    document.querySelectorAll('.color-picker input[type="color"]').forEach(inp => {
        const v = inp.dataset.var;
        const cur = custom[v] || preset.vars[v];
        if (cur && inp.value.toLowerCase() !== cur.toLowerCase()) inp.value = cur;
    });
}

function setupAppearance() {
    // Aplica preset + custom colors antes de que se vea nada.
    applyThemePreset(getThemePreset());

    // Render presets.
    const presetsEl = document.getElementById('theme-presets');
    if (presetsEl) {
        presetsEl.innerHTML = '';
        for (const [key, p] of Object.entries(THEME_PRESETS)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'theme-preset-btn';
            btn.dataset.preset = key;
            const swatches = ['--bg', '--bg-elev', '--accent', '--fg']
                .map(v => `<span style="background:${p.vars[v]}"></span>`).join('');
            btn.innerHTML = `<span>${p.label}</span><span class="theme-preset-swatches">${swatches}</span>`;
            btn.addEventListener('click', () => applyThemePreset(key, { keepCustom: false }));
            presetsEl.appendChild(btn);
        }
    }

    // Render color pickers.
    const pickersEl = document.getElementById('color-pickers');
    if (pickersEl) {
        pickersEl.innerHTML = '';
        for (const [v, label] of COLOR_VARS) {
            const wrap = document.createElement('div');
            wrap.className = 'color-picker';
            wrap.innerHTML = `
                <label for="cp-${v.replace(/--/, '')}">${label}</label>
                <input type="color" id="cp-${v.replace(/--/, '')}" data-var="${v}">
            `;
            const input = wrap.querySelector('input');
            input.addEventListener('input', () => applyCustomColor(v, input.value));
            pickersEl.appendChild(wrap);
        }
    }

    document.getElementById('theme-reset')?.addEventListener('click', () => {
        if (!confirm('¿Restablecer los colores al preset?')) return;
        applyThemePreset(getThemePreset(), { keepCustom: false });
    });

    syncThemeUi();
}

