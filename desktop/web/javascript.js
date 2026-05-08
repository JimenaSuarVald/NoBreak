/**
 * Lógica de la pantalla de inicio (menu.html): tema oscuro/claro + login
 * contra el servidor del NoBreak desktop con usuario/contraseña.
 *
 * El usuario se crea desde la app de escritorio al primer arranque; la
 * web solo inicia sesión.
 */

// --- TEMA (DARK/LIGHT) ---
const aplicarTema = (tema) => {
    document.documentElement.setAttribute('data-theme', tema);
    localStorage.setItem('tema-preferido', tema);
};
aplicarTema(localStorage.getItem('tema-preferido') || 'dark');

document.getElementById('btn-toggle-tema')?.addEventListener('click', () => {
    const nuevo = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    aplicarTema(nuevo);
});

// --- UTILIDADES UI ---
const mostrarError = (id, msj) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = msj;
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.style.display = 'none', 4000);
};

// --- ESTADO DE SESIÓN VISIBLE EN EL DROPDOWN ---
function refrescarEstadoSesion() {
    const logged = window.NoBreak && window.NoBreak.isLoggedIn();
    document.getElementById('auth-tabs')?.classList.toggle('oculto', logged);
    document.getElementById('usuario-emparejado')?.classList.toggle('oculto', !logged);
    const btnUser = document.getElementById('btn-usuario');
    if (btnUser) btnUser.innerText = logged
        ? (window.NoBreak.currentUser() || 'Conectado')
        : 'Cuenta';
}

// --- FORMULARIO DE LOGIN ---
document.getElementById('form-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (document.getElementById('login-user')?.value || '').trim();
    const password = (document.getElementById('login-pass')?.value || '');

    if (!username || !password) {
        return mostrarError('error-login', 'Introduce usuario y contraseña.');
    }

    const btn = e.submitter || document.querySelector('#form-login button[type=submit]');
    if (btn) { btn.disabled = true; btn.innerText = 'Entrando…'; }

    try {
        await window.NoBreak.login(username, password);
        mostrarError('error-login', 'Sesión iniciada, cargando…');
        setTimeout(() => { window.location.href = 'reproductor.html'; }, 350);
    } catch (err) {
        mostrarError('error-login', err.message || 'No se pudo iniciar sesión');
        if (btn) { btn.disabled = false; btn.innerText = 'Entrar'; }
    }
});

// --- LOGOUT ---
document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await window.NoBreak.logout();
    refrescarEstadoSesion();
});

refrescarEstadoSesion();
