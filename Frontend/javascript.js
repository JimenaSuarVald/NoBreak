let usuariosDB = JSON.parse(localStorage.getItem('usuarios-db')) || [];
let captchaActual = "";
let datosTemporales = null;

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

// --- INTERFAZ DE USUARIO (UI) ---
function cambiarTab(tipo) {
    document.getElementById('form-login').classList.toggle('oculto', tipo !== 'login');
    document.getElementById('form-registro').classList.toggle('oculto', tipo === 'login');
    document.querySelectorAll('.tab-link').forEach((t, i) => {
        t.classList.toggle('activo', (i === 0 && tipo === 'login') || (i === 1 && tipo === 'registro'));
    });
}

function togglePassword(id) {
    const input = document.getElementById(id);
    input.type = input.type === 'password' ? 'text' : 'password';
}

const mostrarError = (id, msj) => {
    const el = document.getElementById(id);
    if (el) {
        el.innerText = msj;
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 3000);
    }
};

// --- MODAL CAPTCHA ---
const modal = document.getElementById('modal-captcha');

function abrirModal(datos, tipo) {
    datosTemporales = { ...datos, tipo };
    captchaActual = Math.floor(100000 + Math.random() * 900000).toString();
    document.getElementById('captcha-num-modal').innerText = captchaActual;
    document.getElementById('captcha-input-modal').value = "";
    modal.classList.remove('oculto');
}

function cerrarModal() { 
    modal.classList.add('oculto'); 
}

// --- MANEJO DE FORMULARIOS ---
document.getElementById('form-login')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = document.getElementById('login-correo'), p = document.getElementById('login-pass');
    if(!c.value || !p.value) return mostrarError('error-login', 'Completa los campos');
    abrirModal({ correo: c.value, pass: p.value }, 'login');
});

document.getElementById('form-registro')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = document.getElementById('reg-nombre'), 
          c = document.getElementById('reg-correo'), 
          p = document.getElementById('reg-pass');

    if(!n.value || !c.value || !p.value) return mostrarError('error-registro', 'Completa los campos');
    if(!/^[^\s@]+@[^\s@]+\.(com|es)$/.test(c.value)) return mostrarError('error-registro', 'Correo inválido');
    
    abrirModal({ nombre: n.value, correo: c.value, pass: p.value }, 'registro');
});

// --- LÓGICA DE CONFIRMACIÓN (CAPTCHA + GUARDADO) ---
document.getElementById('btn-confirmar-captcha').addEventListener('click', () => {
    const input = document.getElementById('captcha-input-modal').value;
    
    if(input !== captchaActual) {
        return mostrarError('error-captcha-modal', 'Código incorrecto');
    }

    if(datosTemporales.tipo === 'login') {
        // Lógica de Login
        const u = usuariosDB.find(u => u.correo === datosTemporales.correo && u.pass === datosTemporales.pass);
        if(u) {
            loguear(u.nombre);
        } else {
            cerrarModal();
            mostrarError('error-login', 'No existe el usuario');
        }
    } else {
        // Lógica de Registro
        if(usuariosDB.some(u => u.correo === datosTemporales.correo)) {
            cerrarModal();
            mostrarError('error-registro', 'Email ya registrado');
        } else {
            // 1. Guardar localmente
            usuariosDB.push(datosTemporales);
            localStorage.setItem('usuarios-db', JSON.stringify(usuariosDB));

            // 2. CAMBIO AQUÍ: Sincronización con Servidor Java (SQLite)
            fetch('http://localhost:8080/api/registro', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(datosTemporales)
            })
            .then(response => {
                if(response.ok) console.log("Usuario sincronizado con la App de Escritorio");
                else console.error("Error en la respuesta del servidor");
            })
            .catch(err => console.error("El servidor Java no está respondiendo:", err));

            // 3. Iniciar sesión en la web
            loguear(datosTemporales.nombre);
        }
    }
});

// --- MANEJO DE SESIÓN ---
function loguear(nombre) {
    localStorage.setItem('session-user', nombre);
    location.reload();
}

const sesion = localStorage.getItem('session-user');
if(sesion) {
    document.getElementById('auth-tabs')?.classList.add('oculto');
    document.getElementById('usuario-logueado')?.classList.remove('oculto');
    const nombreUserEl = document.getElementById('nombre-user');
    const btnUserEl = document.getElementById('btn-usuario');
    
    if(nombreUserEl) nombreUserEl.innerText = sesion;
    if(btnUserEl) btnUserEl.innerText = `Hola, ${sesion} 👤`;
}

document.getElementById('btn-logout')?.addEventListener('click', () => {
    localStorage.removeItem('session-user');
    location.reload();
});