// renderer-profile.js — vista de perfil del usuario, widgets y editor.

// --- Edit profile view ---------------------------------------------------
async function renderEditProfileView() {
    const view = $('profile-view');
    if (!view) return;
    applyProfileBackground(view, null);  // sin fondo en el editor
    view.innerHTML = '<div class="empty-state">Cargando editor…</div>';
    let me;
    try { me = await apiJson('/auth/me'); }
    catch (e) {
        view.innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
        return;
    }
    const layout = (me.profileWidgets && Array.isArray(me.profileWidgets.widgets))
        ? me.profileWidgets.widgets.slice()
        : DEFAULT_PROFILE_WIDGETS.slice();

    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'edit-profile';
    wrap.innerHTML = `
        <header class="edit-profile-head">
            <div>
                <div class="edit-eyebrow">Editor</div>
                <h1 class="edit-title">Perfil</h1>
            </div>
            <div class="edit-actions">
                <button id="edit-cancel" type="button" class="login-card-btn-secondary">Cancelar</button>
                <button id="edit-save"   type="button" class="edit-save">Guardar cambios</button>
            </div>
        </header>

        <section class="edit-section">
            <h2 class="edit-section-title">Datos básicos</h2>
            <div class="edit-grid-2">
                <label class="edit-field">
                    <span class="edit-label">Nombre visible</span>
                    <input id="edit-display-name" type="text" maxlength="80">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Correo</span>
                    <input id="edit-email" type="email" maxlength="200">
                </label>
            </div>
            <label class="edit-field">
                <span class="edit-label">Descripción</span>
                <textarea id="edit-description" rows="4"></textarea>
            </label>
            <div class="edit-photo-row">
                <div id="edit-photo-preview" class="edit-photo-preview"></div>
                <div>
                    <input id="edit-photo-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
                    <button id="edit-photo-pick"   type="button" class="login-card-btn-secondary">Cambiar foto…</button>
                    <button id="edit-photo-clear"  type="button" class="login-card-btn-secondary">Quitar foto</button>
                </div>
            </div>
        </section>

        <section class="edit-section">
            <h2 class="edit-section-title">Fondo del perfil</h2>
            <p class="muted small">Imagen que se muestra detrás de tus widgets en tu perfil público. Aspecto recomendado: panorámico (ej. 1920×1080).</p>
            <div class="edit-bg-row">
                <div id="edit-bg-preview" class="edit-bg-preview"></div>
                <div>
                    <input id="edit-bg-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
                    <button id="edit-bg-pick"  type="button" class="login-card-btn-secondary">Cambiar fondo…</button>
                    <button id="edit-bg-clear" type="button" class="login-card-btn-secondary">Quitar fondo</button>
                </div>
            </div>

            <h3 class="edit-subsection-title">Velo de legibilidad</h3>
            <p class="muted small">Capa de color que cubre el fondo para que los widgets se lean bien. Llega siempre hasta abajo del todo. Su ancho es independiente del de las ventanas.</p>
            <div class="edit-veil-grid">
                <label class="edit-field">
                    <span class="edit-label">Color del relleno</span>
                    <input id="edit-veil-color" type="color" value="#000000">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Opacidad del relleno <span id="edit-veil-opacity-val">65%</span></span>
                    <input id="edit-veil-opacity" type="range" min="0" max="100" value="65">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Ancho del velo <span id="edit-veil-width-val">1200&nbsp;px</span></span>
                    <input id="edit-veil-width" type="range" min="200" max="1920" step="20" value="1200">
                </label>
            </div>
            <div class="edit-veil-grid">
                <label class="edit-field">
                    <span class="edit-label">Color del borde</span>
                    <input id="edit-veil-border-color" type="color" value="#000000">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Opacidad del borde <span id="edit-veil-border-opacity-val">0%</span></span>
                    <input id="edit-veil-border-opacity" type="range" min="0" max="100" value="0">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Grosor del borde <span id="edit-veil-border-width-val">0&nbsp;px</span></span>
                    <input id="edit-veil-border-width" type="range" min="0" max="20" value="0">
                </label>
            </div>
            <div class="edit-veil-preview" id="edit-veil-preview">
                <div class="edit-veil-preview-veil" id="edit-veil-preview-veil"></div>
                <span class="edit-veil-preview-label">Vista previa del velo</span>
            </div>
        </section>

        <section class="edit-section">
            <h2 class="edit-section-title">Estilo del perfil</h2>
            <p class="muted small">Define cómo se ve tu hero (foto + nombre + correo) y las ventanas de los widgets.</p>

            <h3 class="edit-subsection-title">Foto de perfil</h3>
            <div class="edit-grid-2">
                <label class="edit-field">
                    <span class="edit-label">Forma</span>
                    <select id="edit-photo-shape">
                        <option value="circle">Círculo</option>
                        <option value="square">Cuadrado</option>
                        <option value="rounded">Cuadrado redondeado</option>
                        <option value="oval">Óvalo</option>
                        <option value="star">Estrella</option>
                    </select>
                </label>
                <label class="edit-field">
                    <span class="edit-label">Posición (relativa al nombre)</span>
                    <select id="edit-photo-position">
                        <option value="top">Encima del nombre</option>
                        <option value="bottom">Debajo del nombre</option>
                        <option value="left">A la izquierda</option>
                        <option value="right">A la derecha</option>
                    </select>
                </label>
            </div>

            <h3 class="edit-subsection-title">Marco PNG sobre la foto</h3>
            <p class="muted small">Sube un PNG con transparencia que se superpondrá a tu foto. Ajusta la posición y la escala para centrarlo a tu gusto.</p>
            <div class="edit-frame-row">
                <div class="edit-frame-preview" id="edit-frame-preview-photo">
                    <img id="edit-frame-preview-img" alt="">
                </div>
                <div class="edit-frame-controls">
                    <input id="edit-frame-input" type="file" accept="image/png,image/webp,image/gif,image/apng" hidden>
                    <button id="edit-frame-pick"  type="button" class="login-card-btn-secondary">Subir marco…</button>
                    <button id="edit-frame-clear" type="button" class="login-card-btn-secondary">Quitar marco</button>
                </div>
            </div>
            <div class="edit-grid-2">
                <label class="edit-field">
                    <span class="edit-label">Desplazamiento horizontal <span id="edit-frame-x-val">0%</span></span>
                    <input id="edit-frame-x" type="range" min="-50" max="50" value="0">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Desplazamiento vertical <span id="edit-frame-y-val">0%</span></span>
                    <input id="edit-frame-y" type="range" min="-50" max="50" value="0">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Escala <span id="edit-frame-scale-val">100%</span></span>
                    <input id="edit-frame-scale" type="range" min="50" max="200" value="100">
                </label>
                <div class="edit-field" style="display:flex;align-items:flex-end;">
                    <button id="edit-frame-center" type="button" class="login-card-btn-secondary" style="width:100%;">Centrar marco</button>
                </div>
            </div>

            <h3 class="edit-subsection-title">Nombre y correo</h3>
            <div class="edit-grid-2">
                <label class="edit-field">
                    <span class="edit-label">Color del nombre</span>
                    <input id="edit-name-color" type="color">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color del correo</span>
                    <input id="edit-email-color" type="color">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color de "Perfil de @…" y "Cuenta creada el…"</span>
                    <input id="edit-subtitle-color" type="color">
                </label>
            </div>
            <label class="edit-field">
                <span class="edit-label">Marco propio</span>
                <label class="edit-toggle">
                    <input id="edit-header-frame" type="checkbox">
                    <span>Mostrar foto + nombre dentro de una ventana, igual que la descripción.</span>
                </label>
            </label>

            <h3 class="edit-subsection-title">Ventanas y tipografía</h3>
            <p class="muted small">Una sola fuente para todo el perfil y colores comunes para todas las ventanas.</p>
            <div class="edit-grid-2">
                <label class="edit-field">
                    <span class="edit-label">Fuente del perfil</span>
                    <select id="edit-profile-font"></select>
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color de fondo de ventanas</span>
                    <input id="edit-window-bg" type="color">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color del título de las ventanas</span>
                    <input id="edit-window-title-color" type="color">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color del texto dentro de las ventanas</span>
                    <input id="edit-window-text-color" type="color">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color del texto secundario en ventanas</span>
                    <input id="edit-window-muted-color" type="color">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Forma de las ventanas</span>
                    <select id="edit-window-shape">
                        <option value="square">Cuadradas</option>
                        <option value="rounded">Redondeadas</option>
                        <option value="extra-rounded">Muy redondeadas</option>
                        <option value="pill">Píldora</option>
                    </select>
                </label>
                <label class="edit-field">
                    <span class="edit-label">Opacidad de las ventanas <span id="edit-window-opacity-val">100%</span></span>
                    <input id="edit-window-opacity" type="range" min="0" max="100" value="100">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Grosor del borde <span id="edit-window-border-val">1&nbsp;px</span></span>
                    <input id="edit-window-border-width" type="range" min="0" max="6" value="1">
                </label>
                <label class="edit-field">
                    <span class="edit-label">Color del borde</span>
                    <input id="edit-window-border-color" type="color">
                </label>
            </div>
            <label class="edit-field">
                <span class="edit-label">Ancho máximo de las ventanas <span id="edit-window-width-val">1200&nbsp;px</span></span>
                <input id="edit-window-width" type="range" min="600" max="1920" step="20" value="1200">
                <span class="muted small">Define el ancho máximo del bloque de widgets (y del hero). El velo se reescala con este valor.</span>
            </label>
        </section>

        <section class="edit-section">
            <h2 class="edit-section-title">Widgets del perfil</h2>
            <p class="muted small">Activa, ordena y elige el tamaño de cada sección. El orden aquí es el orden de aparición en tu perfil.</p>
            <ul id="edit-widgets-list" class="edit-widgets-list"></ul>
        </section>

        <section class="edit-section">
            <h2 class="edit-section-title">
                Amigos
            </h2>
            <div class="edit-friends">
                <div class="edit-friend-add">
                    <input id="friend-username" type="text" placeholder="Nombre de usuario">
                    <button id="friend-add-btn" type="button" class="login-card-btn-secondary">Añadir amigo</button>
                </div>
                <ul id="edit-friends-list" class="edit-friends-list"></ul>
            </div>
        </section>

        <section class="edit-section">
            <h2 class="edit-section-title">
                <label class="edit-toggle">
                    <input id="edit-advanced-mode" type="checkbox">
                    <span>Configuración avanzada (HTML)</span>
                </label>
            </h2>
            <p class="muted small">Cuando está activa, tu perfil público se renderiza con el HTML de abajo en lugar de los widgets. Funciona en un iframe sin scripts (sólo HTML/CSS estático).</p>
            <textarea id="edit-html" rows="14" placeholder="<h1>Hola</h1>\n<p>Mi perfil personalizado…</p>"></textarea>
        </section>

        <div id="edit-error" class="error"></div>
    `;
    view.appendChild(wrap);

    // Rellenar datos
    $('edit-display-name').value = me.displayName || '';
    $('edit-email').value        = me.email || '';
    $('edit-description').value  = me.description || '';
    $('edit-html').value         = me.profileHtml || '';
    $('edit-advanced-mode').checked = !!me.advancedMode;
    if (me.photoUrl) {
        $('edit-photo-preview').style.backgroundImage =
            `url('${API_BASE + me.photoUrl}?t=${encodeURIComponent(token)}&v=${Date.now()}')`;
        $('edit-photo-preview').classList.add('has-image');
    }
    if (me.backgroundUrl) {
        const bgUrl = `url('${API_BASE + me.backgroundUrl}?t=${encodeURIComponent(token)}&v=${Date.now()}')`;
        $('edit-bg-preview').style.backgroundImage = bgUrl;
        $('edit-bg-preview').classList.add('has-image');
        $('edit-veil-preview').style.backgroundImage = bgUrl;
    }
    // Estilo: poblar select de fuente y rellenar valores.
    const fontSel = $('edit-profile-font');
    fontSel.innerHTML = '';
    for (const [k, label] of Object.entries(FONT_LABELS)) {
        const o = document.createElement('option');
        o.value = k; o.textContent = label;
        fontSel.appendChild(o);
    }
    const rawStyle = (me.profileWidgets && me.profileWidgets.style) || {};
    const style = { ...DEFAULT_STYLE, ...rawStyle };
    // El campo `font` puede venir vacío en perfiles antiguos; cae a las claves
    // viejas (headerFont/windowFont) si existen.
    const fontKey = (FONT_STACKS[style.font] && style.font)
                  || (FONT_STACKS[rawStyle.headerFont] && rawStyle.headerFont)
                  || (FONT_STACKS[rawStyle.windowFont] && rawStyle.windowFont)
                  || 'system';
    $('edit-photo-shape').value     = PHOTO_SHAPES.includes(style.photoShape) ? style.photoShape : 'circle';
    $('edit-photo-position').value  = PHOTO_POSITIONS.includes(style.photoPosition) ? style.photoPosition : 'top';
    // Marco PNG: posicion/escala
    $('edit-frame-x').value     = String(Math.max(-50, Math.min(50, Number(style.frameX ?? 0))));
    $('edit-frame-y').value     = String(Math.max(-50, Math.min(50, Number(style.frameY ?? 0))));
    $('edit-frame-scale').value = String(Math.round(Math.max(0.5, Math.min(2, Number(style.frameScale ?? 1))) * 100));
    const updateFrameLabels = () => {
        $('edit-frame-x-val').textContent     = $('edit-frame-x').value + '%';
        $('edit-frame-y-val').textContent     = $('edit-frame-y').value + '%';
        $('edit-frame-scale-val').textContent = $('edit-frame-scale').value + '%';
        const previewImg = $('edit-frame-preview-img');
        if (previewImg) {
            previewImg.style.transform = `translate(${$('edit-frame-x').value}%, ${$('edit-frame-y').value}%) scale(${Number($('edit-frame-scale').value) / 100})`;
        }
    };
    updateFrameLabels();
    ['edit-frame-x', 'edit-frame-y', 'edit-frame-scale'].forEach(id =>
        $(id).addEventListener('input', updateFrameLabels));
    $('edit-frame-center').addEventListener('click', () => {
        $('edit-frame-x').value = '0';
        $('edit-frame-y').value = '0';
        $('edit-frame-scale').value = '100';
        updateFrameLabels();
    });
    if (me.frameUrl) {
        $('edit-frame-preview-img').src = API_BASE + me.frameUrl + '?t=' + encodeURIComponent(token) + '&v=' + Date.now();
        $('edit-frame-preview-photo').classList.add('has-frame');
    }
    if (me.photoUrl) {
        $('edit-frame-preview-photo').style.backgroundImage =
            `url('${API_BASE + me.photoUrl}?t=${encodeURIComponent(token)}&v=${Date.now()}')`;
    }
    let pendingFrameDataUrl = null;
    $('edit-frame-pick').addEventListener('click', () => $('edit-frame-input').click());
    $('edit-frame-input').addEventListener('change', () => {
        const f = $('edit-frame-input').files?.[0];
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) {
            $('edit-error').textContent = 'El marco no puede superar 4 MB.';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            pendingFrameDataUrl = reader.result;
            $('edit-frame-preview-img').src = pendingFrameDataUrl;
            $('edit-frame-preview-photo').classList.add('has-frame');
        };
        reader.readAsDataURL(f);
    });
    $('edit-frame-clear').addEventListener('click', () => {
        pendingFrameDataUrl = '';
        $('edit-frame-preview-img').src = '';
        $('edit-frame-preview-photo').classList.remove('has-frame');
    });
    const hexOr = (v, fb) => /^#[0-9a-f]{6}$/i.test(v) ? v : fb;
    $('edit-name-color').value         = hexOr(style.nameColor,         '#ffffff');
    $('edit-email-color').value        = hexOr(style.emailColor,        '#a0a0a0');
    $('edit-subtitle-color').value     = hexOr(style.subtitleColor,     '#a0a0a0');
    $('edit-header-frame').checked     = !!style.headerFrame;
    $('edit-window-bg').value          = hexOr(style.windowBg,          '#181818');
    $('edit-window-title-color').value = hexOr(style.windowTitleColor,  '#a0a0a0');
    $('edit-window-text-color').value  = hexOr(style.windowTextColor,   '#ffffff');
    $('edit-window-muted-color').value = hexOr(style.windowMutedColor,  '#a0a0a0');
    $('edit-window-shape').value       = WINDOW_SHAPES.includes(style.windowShape) ? style.windowShape : 'rounded';
    $('edit-window-opacity').value     = String(Math.round((style.windowOpacity ?? 1) * 100));
    $('edit-window-border-width').value = String(Math.max(0, Math.min(6, Number(style.windowBorderWidth ?? 1))));
    $('edit-window-border-color').value = hexOr(style.windowBorderColor, '#282828');
    const updateWindowOpacityLabel = () => {
        $('edit-window-opacity-val').textContent = $('edit-window-opacity').value + '%';
    };
    const updateWindowBorderLabel = () => {
        $('edit-window-border-val').textContent = $('edit-window-border-width').value + ' px';
    };
    updateWindowOpacityLabel();
    updateWindowBorderLabel();
    $('edit-window-opacity').addEventListener('input', updateWindowOpacityLabel);
    $('edit-window-border-width').addEventListener('input', updateWindowBorderLabel);
    $('edit-profile-font').value       = fontKey;
    // El ancho viene en píxeles; si encontramos un valor antiguo en %  lo
    // mapeamos a un valor sensato.
    let widthPx = Number(style.windowMaxWidth) || WINDOW_WIDTH_DEFAULT_PX;
    if (widthPx <= 100) widthPx = WINDOW_WIDTH_DEFAULT_PX;
    widthPx = Math.max(WINDOW_WIDTH_MIN_PX, Math.min(WINDOW_WIDTH_MAX_PX, widthPx));
    $('edit-window-width').value    = String(widthPx);
    const updateWindowWidthLabel = () => {
        $('edit-window-width-val').textContent = $('edit-window-width').value + ' px';
    };
    updateWindowWidthLabel();
    $('edit-window-width').addEventListener('input', updateWindowWidthLabel);

    // Velo: leer la config existente o defaults (incluyendo borde).
    const veil = { ...DEFAULT_VEIL, ...((me.profileWidgets && me.profileWidgets.veil) || {}) };
    $('edit-veil-color').value          = /^#[0-9a-f]{6}$/i.test(veil.color) ? veil.color : DEFAULT_VEIL.color;
    $('edit-veil-opacity').value        = String(Math.round((veil.opacity ?? 0.65) * 100));
    // Ancho en px; valores antiguos en % (≤100) se mapean al default.
    let veilWidthInit = Number(veil.width);
    if (!isFinite(veilWidthInit) || veilWidthInit <= 100) veilWidthInit = VEIL_WIDTH_DEFAULT_PX;
    veilWidthInit = Math.max(VEIL_WIDTH_MIN_PX, Math.min(VEIL_WIDTH_MAX_PX, veilWidthInit));
    $('edit-veil-width').value          = String(veilWidthInit);
    $('edit-veil-border-color').value   = /^#[0-9a-f]{6}$/i.test(veil.borderColor) ? veil.borderColor : DEFAULT_VEIL.borderColor;
    $('edit-veil-border-opacity').value = String(Math.round((veil.borderOpacity ?? 0) * 100));
    $('edit-veil-border-width').value   = String(veil.borderWidth ?? 0);
    function paintVeilPreview() {
        const c   = $('edit-veil-color').value;
        const o   = Number($('edit-veil-opacity').value) / 100;
        const w   = Number($('edit-veil-width').value);
        const bc  = $('edit-veil-border-color').value;
        const bo  = Number($('edit-veil-border-opacity').value) / 100;
        const bw  = Number($('edit-veil-border-width').value);
        $('edit-veil-opacity-val').textContent        = Math.round(o * 100) + '%';
        $('edit-veil-width-val').textContent          = w + ' px';
        $('edit-veil-border-opacity-val').textContent = Math.round(bo * 100) + '%';
        $('edit-veil-border-width-val').textContent   = bw + ' px';
        const veilEl = $('edit-veil-preview-veil');
        veilEl.style.backgroundColor = hexWithAlpha(c, o);
        veilEl.style.borderLeft      = bw + 'px solid ' + hexWithAlpha(bc, bo);
        veilEl.style.borderRight     = bw + 'px solid ' + hexWithAlpha(bc, bo);
        veilEl.style.boxSizing       = 'border-box';
        veilEl.style.opacity         = '1';
        // Preview escalado al contenedor; capado al 100% para imitar el
        // comportamiento real (min(px,100%)).
        const previewW = $('edit-veil-preview').clientWidth || 600;
        veilEl.style.width = Math.min(w, previewW) + 'px';
    }
    paintVeilPreview();
    [
        'edit-veil-color', 'edit-veil-opacity', 'edit-veil-width',
        'edit-veil-border-color', 'edit-veil-border-opacity', 'edit-veil-border-width',
    ].forEach(id => $(id).addEventListener('input', paintVeilPreview));

    // Lista de widgets
    let workingLayout = layout.slice();
    function repaintWidgetList() {
        const list = $('edit-widgets-list');
        list.innerHTML = '';
        const used = new Set(workingLayout.map(w => w.type));
        // Items configurados (en su orden actual)
        workingLayout.forEach((w, i) => list.appendChild(buildWidgetEditorRow(w, i, true)));
        // Items disponibles (no en uso)
        for (const [type, def] of Object.entries(WIDGET_CATALOG)) {
            if (used.has(type)) continue;
            list.appendChild(buildWidgetEditorRow({ type, size: def.defaultSize }, -1, false));
        }
    }
    function buildWidgetEditorRow(w, idx, active) {
        const def = WIDGET_CATALOG[w.type];
        const li = document.createElement('li');
        li.className = 'edit-widget-row' + (active ? ' active' : '');
        li.innerHTML = `
            <div class="edit-widget-main">
                <input type="checkbox" ${active ? 'checked' : ''}>
                <span class="edit-widget-name">${escapeHtml(def?.label || w.type)}</span>
            </div>
            <div class="edit-widget-controls">
                <select class="edit-widget-size">
                    ${WIDGET_SIZES.map(s => `<option value="${s}" ${w.size === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <button type="button" class="edit-widget-up"   ${active && idx > 0 ? '' : 'disabled'} title="Subir">↑</button>
                <button type="button" class="edit-widget-down" ${active && idx >= 0 && idx < workingLayout.length - 1 ? '' : 'disabled'} title="Bajar">↓</button>
            </div>
        `;
        // Toggle activo / inactivo
        li.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
            if (e.target.checked && !active) {
                workingLayout.push({ type: w.type, size: w.size });
            } else if (!e.target.checked && active) {
                workingLayout.splice(idx, 1);
            }
            repaintWidgetList();
        });
        // Cambio de tamaño
        li.querySelector('.edit-widget-size').addEventListener('change', (e) => {
            const size = e.target.value;
            if (active) {
                workingLayout[idx].size = size;
            } else {
                w.size = size;  // sólo afecta al "default" si lo activas después
            }
        });
        // Reordenar
        li.querySelector('.edit-widget-up').addEventListener('click', () => {
            if (idx > 0) {
                const tmp = workingLayout[idx - 1];
                workingLayout[idx - 1] = workingLayout[idx];
                workingLayout[idx] = tmp;
                repaintWidgetList();
            }
        });
        li.querySelector('.edit-widget-down').addEventListener('click', () => {
            if (idx >= 0 && idx < workingLayout.length - 1) {
                const tmp = workingLayout[idx + 1];
                workingLayout[idx + 1] = workingLayout[idx];
                workingLayout[idx] = tmp;
                repaintWidgetList();
            }
        });
        return li;
    }
    repaintWidgetList();

    // Lista de amigos
    async function repaintFriendsList() {
        try {
            const fs = await apiJson('/api/friends');
            const list = $('edit-friends-list');
            list.innerHTML = '';
            if (!fs.length) {
                list.innerHTML = '<li class="muted">Aún no tienes amigos añadidos.</li>';
                return;
            }
            for (const f of fs) {
                const li = document.createElement('li');
                li.innerHTML = `
                    <span class="edit-friend-name">@${escapeHtml(f.username)}</span>
                    <button type="button" class="edit-friend-remove" data-id="${f.id}">Quitar</button>
                `;
                li.querySelector('.edit-friend-remove').addEventListener('click', async () => {
                    try { await apiCall('/api/friends/' + f.id, { method: 'DELETE' }); } catch {}
                    repaintFriendsList();
                });
                list.appendChild(li);
            }
        } catch {}
    }
    repaintFriendsList();
    $('friend-add-btn').addEventListener('click', async () => {
        const u = $('friend-username').value.trim();
        if (!u) return;
        try {
            await apiJson('/api/friends', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u }),
            });
            $('friend-username').value = '';
            repaintFriendsList();
        } catch (e) {
            $('edit-error').textContent = e.message;
        }
    });

    // Foto: cambiar / quitar
    let pendingPhotoDataUrl = null;
    $('edit-photo-pick').addEventListener('click', () => $('edit-photo-input').click());
    $('edit-photo-input').addEventListener('change', () => {
        const f = $('edit-photo-input').files?.[0];
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) {
            $('edit-error').textContent = 'La imagen no puede superar 5 MB.';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            pendingPhotoDataUrl = reader.result;
            $('edit-photo-preview').style.backgroundImage = `url('${pendingPhotoDataUrl}')`;
            $('edit-photo-preview').classList.add('has-image');
        };
        reader.readAsDataURL(f);
    });
    $('edit-photo-clear').addEventListener('click', () => {
        pendingPhotoDataUrl = '';
        $('edit-photo-preview').style.backgroundImage = '';
        $('edit-photo-preview').classList.remove('has-image');
    });

    // Fondo: cambiar / quitar (mismo patrón pero con saveProfileBackground)
    let pendingBgDataUrl = null;          // null=sin cambio, ''=quitar, dataUrl=nuevo
    $('edit-bg-pick').addEventListener('click', () => $('edit-bg-input').click());
    $('edit-bg-input').addEventListener('change', () => {
        const f = $('edit-bg-input').files?.[0];
        if (!f) return;
        if (f.size > 8 * 1024 * 1024) {
            $('edit-error').textContent = 'El fondo no puede superar 8 MB.';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            pendingBgDataUrl = reader.result;
            $('edit-bg-preview').style.backgroundImage = `url('${pendingBgDataUrl}')`;
            $('edit-bg-preview').classList.add('has-image');
        };
        reader.readAsDataURL(f);
    });
    $('edit-bg-clear').addEventListener('click', () => {
        pendingBgDataUrl = '';
        $('edit-bg-preview').style.backgroundImage = '';
        $('edit-bg-preview').classList.remove('has-image');
    });

    // Cancelar / Guardar
    $('edit-cancel').addEventListener('click', () => {
        // Vuelve a la pestaña pública del propio usuario.
        openOrFocusTab('profile', { name: username });
    });
    $('edit-save').addEventListener('click', async () => {
        const errEl = $('edit-error');
        errEl.textContent = '';
        const saveBtn = $('edit-save');
        saveBtn.disabled = true;
        try {
            const veilToSave = {
                color:         $('edit-veil-color').value,
                opacity:       Number($('edit-veil-opacity').value) / 100,
                width:         Number($('edit-veil-width').value),
                borderColor:   $('edit-veil-border-color').value,
                borderOpacity: Number($('edit-veil-border-opacity').value) / 100,
                borderWidth:   Number($('edit-veil-border-width').value),
            };
            const styleToSave = {
                photoShape:    $('edit-photo-shape').value,
                photoPosition: $('edit-photo-position').value,
                nameColor:        $('edit-name-color').value,
                emailColor:       $('edit-email-color').value,
                subtitleColor:    $('edit-subtitle-color').value,
                headerFrame:      $('edit-header-frame').checked,
                windowBg:         $('edit-window-bg').value,
                windowTitleColor: $('edit-window-title-color').value,
                windowTextColor:  $('edit-window-text-color').value,
                windowMutedColor: $('edit-window-muted-color').value,
                windowShape:       $('edit-window-shape').value,
                windowOpacity:     Number($('edit-window-opacity').value) / 100,
                windowBorderWidth: Number($('edit-window-border-width').value),
                windowBorderColor: $('edit-window-border-color').value,
                font:             $('edit-profile-font').value,
                windowMaxWidth:   Number($('edit-window-width').value),
                frameX:           Number($('edit-frame-x').value),
                frameY:           Number($('edit-frame-y').value),
                frameScale:       Number($('edit-frame-scale').value) / 100,
            };
            const patch = {
                displayName:    $('edit-display-name').value.trim(),
                email:          $('edit-email').value.trim(),
                description:    $('edit-description').value.trim(),
                profileWidgets: { widgets: workingLayout, veil: veilToSave, style: styleToSave },
                profileHtml:    $('edit-html').value,
                advancedMode:   $('edit-advanced-mode').checked,
            };
            await apiJson('/auth/me', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (pendingPhotoDataUrl) {
                await window.api.saveProfilePhoto(token, pendingPhotoDataUrl);
            }
            // pendingBgDataUrl: null=no tocar, ''=quitar (lo manejamos como null
            // explícito al main), string=nueva imagen.
            if (pendingBgDataUrl !== null) {
                await window.api.saveProfileBackground(token, pendingBgDataUrl || null);
            }
            if (pendingFrameDataUrl !== null) {
                await window.api.saveProfileFrame(token, pendingFrameDataUrl || null);
            }
            // Tras guardar, refresca foto del header y vuelve a la vista pública.
            await refreshHeaderPhoto();
            openOrFocusTab('profile', { name: username });
        } catch (e) {
            errEl.textContent = e.message || String(e);
            saveBtn.disabled = false;
        }
    });
}

function activeTab() { return tabs.find(t => t.id === activeTabId) || null; }
function currentTabType() { return activeTab()?.type || 'albums'; }

function nextTabId() { return 'tab-' + (++tabSeq) + '-' + Date.now().toString(36); }

function makeTab(type, data) {
    if (type === 'artist') {
        return { id: nextTabId(), type, label: data?.name || 'Artista', data: { name: data?.name || '' } };
    }
    if (type === 'profile') {
        // Pestaña pública (lectura) — label = username del perfil.
        return { id: nextTabId(), type, label: data?.name || 'Perfil', data: { name: data?.name || '' } };
    }
    if (type === 'editProfile') {
        // Pestaña del propio editor — label fijo "Perfil".
        return { id: nextTabId(), type, label: 'Perfil', data: {} };
    }
    if (type === 'album') {
        return {
            id: nextTabId(),
            type,
            label: data?.title || 'Álbum',
            data: { albumId: data?.albumId, title: data?.title || '' },
        };
    }
    const def = TAB_TYPES[type];
    if (!def) throw new Error('tab type desconocido: ' + type);
    return { id: nextTabId(), type, label: def.label };
}

function loadTabsState() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem('nobreak-renderer-tabs-v1') || 'null'); } catch {}
    if (raw && Array.isArray(raw.tabs) && raw.tabs.length) {
        tabs = raw.tabs.map(t => ({ ...t, id: t.id || nextTabId() }));
        activeTabId = raw.activeId && tabs.find(t => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
    } else {
        tabs = [
            makeTab('settings'),
            makeTab('albums'),
            makeTab('artists'),
            makeTab('genres'),
            makeTab('playlists'),
        ];
        activeTabId = tabs[1].id;
        saveTabsState();
    }
}
function saveTabsState() {
    try { localStorage.setItem('nobreak-renderer-tabs-v1', JSON.stringify({ tabs, activeId: activeTabId })); } catch {}
}

function setupTabsBar() {
    $('tab-add')?.addEventListener('click', openTabAddMenu);
}

function renderTabsBar() {
    const bar = $('tabs-bar');
    if (!bar) return;
    bar.innerHTML = '';
    for (const t of tabs) bar.appendChild(buildTabEl(t));
}

function buildTabEl(t) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '') + (t.type === 'settings' ? ' tab-icon' : '');
    el.draggable = true;
    el.dataset.tabId = t.id;
    el.role = 'tab';
    el.title = t.label;
    if (t.type === 'settings') {
        el.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <button class="tab-close" title="Cerrar" aria-label="Cerrar pestaña">×</button>
        `;
    } else {
        el.innerHTML = `
            <span class="tab-label">${escapeHtml(t.label)}</span>
            <button class="tab-close" title="Cerrar" aria-label="Cerrar pestaña">×</button>
        `;
    }

    el.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) {
            e.stopPropagation();
            closeTab(t.id);
            return;
        }
        activateTab(t.id);
    });

    el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-tab-id', t.id);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        document.querySelectorAll('.tab.drop-before, .tab.drop-after')
            .forEach(n => n.classList.remove('drop-before', 'drop-after'));
    });
    el.addEventListener('dragover', (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        el.classList.toggle('drop-before', !after);
        el.classList.toggle('drop-after', after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/x-tab-id');
        if (!draggedId || draggedId === t.id) return;
        const rect = el.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        reorderTab(draggedId, t.id, after);
        el.classList.remove('drop-before', 'drop-after');
    });

    return el;
}

function reorderTab(fromId, toId, after) {
    const fromIdx = tabs.findIndex(t => t.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = tabs.splice(fromIdx, 1);
    const toIdx = tabs.findIndex(t => t.id === toId);
    const insertAt = toIdx < 0 ? tabs.length : (after ? toIdx + 1 : toIdx);
    tabs.splice(insertAt, 0, moved);
    renderTabsBar();
    saveTabsState();
}

function activateTab(id, opts = {}) {
    if (!id) return;
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    if (!opts.force && id === activeTabId) return;
    activeTabId = id;
    document.querySelectorAll('#tabs-bar .tab').forEach(n =>
        n.classList.toggle('active', n.dataset.tabId === id));
    $('search').value = '';
    lastQuery = '';
    showAreaForType(tab.type);
    saveTabsState();
    renderCurrentTab();
}

function showAreaForType(type) {
    const isSettings = type === 'settings';
    const isArtistView = type === 'artist';
    const isAlbumView = type === 'album';
    const isProfile = type === 'profile';
    const isEditProfile = type === 'editProfile';
    const isSpecial = isSettings || isArtistView || isAlbumView || isProfile || isEditProfile;
    $('main-grid').classList.toggle('hidden', isSpecial);
    $('settings-panel').classList.toggle('hidden', !isSettings);
    $('artist-view').classList.toggle('hidden', !isArtistView);
    $('album-view')?.classList.toggle('hidden', !isAlbumView);
    $('profile-view')?.classList.toggle('hidden', !isProfile && !isEditProfile);
    $('search').classList.toggle('hidden', isSpecial);
    $('status-bar').classList.toggle('hidden', isSpecial);
    syncToolbarFor(type);
}

async function renderCurrentTab() {
    closeDrawer();
    const tab = activeTab();
    if (!tab) return;
    if (tab.type === 'settings')  return;
    if (tab.type === 'artist')      return renderArtistView(tab.data?.name || '');
    if (tab.type === 'album')       return renderAlbumView(tab.data?.albumId);
    if (tab.type === 'profile')     return renderProfileView(tab.data?.name || username);
    if (tab.type === 'editProfile') return renderEditProfileView();
    if (tab.type === 'albums')    return renderAlbumsTab();
    if (tab.type === 'artists')   return renderArtistsTab();
    if (tab.type === 'genres')    return renderGenresTab();
    if (tab.type === 'playlists') return renderPlaylistsTab();
}

function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    if (tabs.length === 1) return;
    tabs.splice(idx, 1);
    if (activeTabId === id) {
        const fallback = tabs[Math.min(idx, tabs.length - 1)];
        activeTabId = fallback.id;
    }
    renderTabsBar();
    showAreaForType(activeTab().type);
    renderCurrentTab();
    saveTabsState();
}

function openOrFocusTab(type, data) {
    const dynamic = type === 'artist' || type === 'profile' || type === 'album';
    const matchKey = type === 'album'
        ? String(data?.albumId || '')
        : (data?.name || '').toLowerCase();
    const existing = tabs.find(t => {
        if (t.type !== type) return false;
        if (type === 'album') return String(t.data?.albumId || '') === matchKey;
        if (dynamic) return (t.data?.name || '').toLowerCase() === matchKey;
        return true;  // editProfile y demás: una sola instancia
    });
    if (existing) { activateTab(existing.id); return existing; }
    const tab = makeTab(type, data);
    tabs.push(tab);
    activeTabId = tab.id;
    renderTabsBar();
    showAreaForType(tab.type);
    renderCurrentTab();
    saveTabsState();
    return tab;
}

function openTabAddMenu() {
    const popover = $('tab-add-menu');
    popover.innerHTML = '';
    for (const [type, def] of Object.entries(TAB_TYPES)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'popover-item';
        b.textContent = def.label;
        b.addEventListener('click', () => { openOrFocusTab(type); hideTabAddMenu(); });
        popover.appendChild(b);
    }
    const anchor = $('tab-add');
    const rect = anchor.getBoundingClientRect();
    popover.style.top = (rect.bottom + 4) + 'px';
    popover.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 220)) + 'px';
    popover.classList.remove('hidden');
    setTimeout(() => {
        document.addEventListener('click', dismissTabAddOnOutside, { capture: true });
        document.addEventListener('keydown', dismissTabAddOnEsc);
    }, 0);
}
function dismissTabAddOnOutside(e) {
    const popover = $('tab-add-menu');
    if (!popover.contains(e.target) && e.target !== $('tab-add')) hideTabAddMenu();
}
function dismissTabAddOnEsc(e) { if (e.key === 'Escape') hideTabAddMenu(); }
function hideTabAddMenu() {
    $('tab-add-menu').classList.add('hidden');
    document.removeEventListener('click', dismissTabAddOnOutside, { capture: true });
    document.removeEventListener('keydown', dismissTabAddOnEsc);
}

