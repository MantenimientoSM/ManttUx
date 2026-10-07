// Constante obligatoria con la URL de despliegue de Apps Script
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx9bOhLwEys51JdSYCdnSgdGkymzzJQzLx6wygaJ7VUWeUqMzScCr2TevMm2XpDjmwcuA/exec";

/**
 * Función central unificada para enviar peticiones POST al backend doPost(e)
 */
async function callBackend(action, params = {}) {
  // Si estamos en entorno Google Web App puro
  if (typeof google !== 'undefined' && google.script && google.script.run) {
    return new Promise((resolve, reject) => {
      var runner = google.script.run
        .withSuccessHandler(function(res) { resolve(res); })
        .withFailureHandler(function(err) { reject(err); });
      
      if (typeof runner[action] === 'function') {
        var args = Object.values(params);
        runner[action](...args);
      } else {
        reject(new Error("Función no definida en google.script.run: " + action));
      }
    });
  }

  // Si estamos en entorno Móvil (Capacitor / WebView / Web estándar)
  try {
    const payload = {
      action: action,
      ...params
    };

    console.log("--> Enviando a Apps Script:", payload);

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload),
      redirect: "follow"
    });

    const textResult = await response.text();
    console.log("<-- Respuesta recibida (raw):", textResult);

    if (textResult.trim().startsWith("<")) {
      console.error("Respuesta HTML de error recibida de Google");
      throw new Error("El servidor devolvió una página HTML.");
    }

    let jsonResult = JSON.parse(textResult);
    if (typeof jsonResult === "string") {
      jsonResult = JSON.parse(jsonResult);
    }

    return jsonResult;

  } catch (error) {
    console.error(`Error en la acción '${action}':`, error);
    return {
      exito: false,
      mensaje: "Error de conexión: " + error.message
    };
  }
}

/* ==========================================================================
   SINCRONIZACIÓN CONTINUA CADA 5 SEGUNDOS (GOOGLE SHEETS)
   ========================================================================== */

let syncInterval = null;
let lastSheetsTimestamp = localStorage.getItem("last_sheets_timestamp") || "0";

/**
 * Consulta la marca de tiempo en Apps Script para verificar si la hoja cambió
 */
async function verificarActualizacionesServidor() {
  const email = localStorage.getItem("usuario_email");
  if (!email) return;

  try {
    const res = await callBackend("verificarUltimoCambio");
    if (res && res.exito && res.timestamp) {
      if (res.timestamp !== lastSheetsTimestamp) {
        console.log("🔄 Cambio detectado en Google Sheets. Refrescando datos...");
        lastSheetsTimestamp = res.timestamp;
        localStorage.setItem("last_sheets_timestamp", lastSheetsTimestamp);

        // Si existe la función de carga/renderizado en la ventana global, se ejecuta silenciosamente
        if (typeof cargarMantenimientos === 'function') {
          cargarMantenimientos(false);
        } else if (typeof cargarDatosGrid === 'function') {
          cargarDatosGrid(false);
        }
      }
    }
  } catch (err) {
    console.warn("Sincronización continua suspendida temporalmente:", err);
  }
}

/**
 * Inicia la verificación continua cada 5 segundos
 */
function iniciarSincronizacionContinua() {
  if (syncInterval) clearInterval(syncInterval);
  verificarActualizacionesServidor(); // Primera ejecución inmediata
  syncInterval = setInterval(verificarActualizacionesServidor, 5000);
}

/**
 * Detiene la verificación continua cuando la app pasa a segundo plano
 */
function detenerSincronizacionContinua() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

/* ==========================================================================
   INTEGRACIÓN NATIVA DE CAPACITOR & NOTIFICACIONES PUSH
   ========================================================================== */

function getCapacitorPlugin(pluginName) {
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[pluginName]) {
    return window.Capacitor.Plugins[pluginName];
  }
  if (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins[pluginName]) {
    return Capacitor.Plugins[pluginName];
  }
  if (window[pluginName]) {
    return window[pluginName];
  }
  return null;
}

/**
 * Muestra notificación local si la app está en primer plano
 */
async function mostrarNotificacionLocal(titulo, cuerpo) {
  try {
    const localNotif = getCapacitorPlugin('LocalNotifications');
    if (localNotif) {
      await localNotif.schedule({
        notifications: [
          {
            title: titulo,
            body: cuerpo,
            id: new Date().getTime() & 0xFFFFFFFF,
            schedule: { at: new Date(Date.now() + 100) },
            sound: null,
            attachments: null,
            actionTypeId: "",
            extra: null
          }
        ]
      });
    }
  } catch (e) {
    console.warn("No se pudo mostrar la notificación local:", e);
  }
}

/**
 * Registra las Notificaciones Push de Firebase (FCM) y sincroniza el token con Apps Script.
 */
async function registrarNotificacionesPush(emailUsuario) {
  try {
    const esNativo = window.Capacitor && 
                     typeof window.Capacitor.isNativePlatform === 'function' && 
                     window.Capacitor.isNativePlatform();

    if (!esNativo) {
      console.log("FCM: Entorno web/localhost detectado. Omitiendo notificaciones nativas.");
      return;
    }

    if (!emailUsuario) {
      console.warn("FCM: No se proporcionó un email válido para asociar el token.");
      return;
    }

    const pushPlugin = getCapacitorPlugin('PushNotifications');
    if (!pushPlugin) {
      console.warn("FCM: Plugin PushNotifications no disponible en Capacitor.");
      return;
    }

    let permStatus = await pushPlugin.checkPermissions();

    if (permStatus.receive === 'prompt') {
      permStatus = await pushPlugin.requestPermissions();
    }

    if (permStatus.receive !== 'granted') {
      console.warn("FCM: Permiso de notificaciones push denegado por el usuario.");
      return;
    }

    try {
      await pushPlugin.createChannel({
        id: 'default',
        name: 'Notificaciones Generales',
        description: 'Alertas de mantenimientos y actualizaciones',
        importance: 5,
        visibility: 1,
        sound: 'default',
        vibration: true
      });
      console.log("🔥 Canal de notificación 'default' asegurado.");
    } catch (errChannel) {
      console.warn("No se pudo crear el canal de notificación:", errChannel);
    }

    await pushPlugin.removeAllListeners();

    pushPlugin.addListener('registration', async (token) => {
      console.log("🔥 Token FCM obtenido exitosamente:", token.value);
      localStorage.setItem("fcm_token", token.value);

      try {
        const respuesta = await callBackend("registrarTokenFCM", {
          email: emailUsuario,
          usuarioEmail: emailUsuario,
          tokenFCM: token.value,
          token: token.value,
          dispositivo: navigator.userAgent
        });

        console.log("Respuesta de registro de Token FCM desde Apps Script:", respuesta);
      } catch (errBackend) {
        console.error("Error al enviar token a Apps Script:", errBackend);
      }
    });

    pushPlugin.addListener('registrationError', (error) => {
      console.error("Error al registrarse en FCM:", error);
    });

    pushPlugin.addListener('pushNotificationReceived', (notification) => {
      console.log("Notificación recibida en primer plano:", notification);
      if (typeof mostrarNotificacionLocal === 'function') {
        mostrarNotificacionLocal(
          notification.title || "ManttUx", 
          notification.body || "Tienes un nuevo radicado asignado o una actualización."
        );
      }
    });

    pushPlugin.addListener('pushNotificationActionPerformed', (notification) => {
      console.log("Usuario abrió la notificación:", notification);
    });

    await pushPlugin.register();

    const tokenGuardado = localStorage.getItem("fcm_token");
    if (tokenGuardado) {
      console.log("FCM: Re-sincronizando token local existente...");
      callBackend("registrarTokenFCM", {
        email: emailUsuario,
        usuarioEmail: emailUsuario,
        tokenFCM: tokenGuardado,
        token: tokenGuardado,
        dispositivo: navigator.userAgent
      }).then(res => console.log("FCM: Respuesta de re-sincronización:", res))
        .catch(err => console.error("FCM: Error al re-sincronizar token local:", err));
    }

  } catch (error) {
    console.error("Error al inicializar Notificaciones Push FCM:", error);
  }
}

/**
 * Función para invocar manualmente tras completar el Login
 */
function alIniciarSesionExitosa(datosUsuario) {
  const email = typeof datosUsuario === 'string' ? datosUsuario : (datosUsuario.email || datosUsuario.usuarioEmail || datosUsuario.correo);
  if (email) {
    localStorage.setItem("usuario_email", email);
    console.log("FCM: Registrando notificaciones tras login para:", email);
    registrarNotificacionesPush(email);
    iniciarSincronizacionContinua();
  }
}

/* ==========================================================================
   CONTROL DE NAVEGACIÓN, BOTÓN ATRÁS Y CICLO DE VIDA (INTEGRADO)
   ========================================================================== */

/**
 * Configura el comportamiento del botón Atrás nativo de Android
 */
function configurarBotonAtrasNativo() {
  const appPlugin = getCapacitorPlugin('App');
  if (!appPlugin) return;

  appPlugin.addListener('backButton', async (data) => {
    // 1. Cierra un modal si está desplegado
    const modalAbierto = document.querySelector('.modal.show, .modal[style*="display: block"]');
    if (modalAbierto) {
      const btnCerrar = modalAbierto.querySelector('.btn-close, [data-bs-dismiss="modal"]');
      if (btnCerrar) {
        btnCerrar.click();
        return;
      }
    }

    // 2. Si la sección de login está activa, evita retrocesos descontrolados
    const loginCard = document.getElementById('loginSection');
    const loginVisible = loginCard && window.getComputedStyle(loginCard).display !== 'none';

    // 3. Permite navegar hacia atrás en el historial si es posible
    if (data && data.canGoBack && !loginVisible && window.history.length > 1) {
      window.history.back();
      return;
    }

    // 4. Solicitud de confirmación antes de cerrar la aplicación
    await confirmarSalidaManttUx(appPlugin);
  });
}

/**
 * Muestra ventana emergente de confirmación de salida
 */
async function confirmarSalidaManttUx(appPlugin) {
  try {
    const dialogPlugin = getCapacitorPlugin('Dialog');

    if (dialogPlugin) {
      const result = await dialogPlugin.confirm({
        title: 'Cerrar ManttUx',
        message: '¿Estás seguro de que deseas salir de la aplicación?',
        okButtonTitle: 'Sí, Salir',
        cancelButtonTitle: 'Cancelar'
      });

      if (result && result.value) {
        detenerSincronizacionContinua();
        appPlugin.exitApp();
      }
    } else {
      const salir = window.confirm("¿Estás seguro de que deseas salir de ManttUx?");
      if (salir) {
        detenerSincronizacionContinua();
        appPlugin.exitApp();
      }
    }
  } catch (error) {
    console.error("Error al mostrar confirmación de salida:", error);
  }
}

/**
 * Escucha los cambios del ciclo de vida de la aplicación (Primer y Segundo plano)
 */
function configurarCicloDeVidaNativo() {
  const appPlugin = getCapacitorPlugin('App');

  if (appPlugin) {
    appPlugin.addListener('appStateChange', ({ isActive }) => {
      gestionarCambioDeEstadoApp(isActive);
    });
  }

  // Respaldo para visibilidad en navegador/WebView web
  document.addEventListener("visibilitychange", () => {
    gestionarCambioDeEstadoApp(!document.hidden);
  });
}

/**
 * Centraliza la lógica de reanudación y pausa de tareas
 */
function gestionarCambioDeEstadoApp(isActive) {
  if (isActive) {
    console.log("🟢 App en primer plano: Reanudando sincronización y verficiación...");
    
    // Restauración de sesión si existe en el entorno global
    if (typeof verificarYRestaurarSesion === 'function') {
      verificarYRestaurarSesion();
    }

    const email = localStorage.getItem("usuario_email");
    const tokenGuardado = localStorage.getItem("fcm_token");

    if (email && !tokenGuardado) {
      registrarNotificacionesPush(email);
    }
    iniciarSincronizacionContinua();
  } else {
    console.log("🟠 App en segundo plano: Pausando temporizadores...");
    detenerSincronizacionContinua();
  }
}

async function capturarEvidenciaFotografica() {
  try {
    const cameraPlugin = getCapacitorPlugin('Camera');

    if (cameraPlugin) {
      const image = await cameraPlugin.getPhoto({
        quality: 75,
        allowEditing: false,
        resultType: "base64",
        source: "CAMERA"
      });

      const base64Data = image.base64String || image.base64;
      return `data:image/jpeg;base64,${base64Data}`;
    } else {
      alert("La cámara nativa requiere ejecución dentro de la APK Android.");
      return null;
    }
  } catch (error) {
    console.error("Error al capturar imagen con la cámara:", error);
    return null;
  }
}

async function solicitarPermisosNotificaciones() {
  try {
    const notifPlugin = getCapacitorPlugin('LocalNotifications');
    if (notifPlugin) {
      await notifPlugin.requestPermissions();
    }
  } catch (error) {
    console.error("Error al solicitar permisos de notificación:", error);
  }
}

// Inicialización general al cargar el DOM
document.addEventListener("DOMContentLoaded", async () => {
  await solicitarPermisosNotificaciones();
  configurarBotonAtrasNativo();
  configurarCicloDeVidaNativo();

  try {
    const sesionGuardada = localStorage.getItem("usuario_manttux") || localStorage.getItem("user");
    let email = localStorage.getItem("usuario_email");

    if (sesionGuardada && !email) {
      const datosUsuario = JSON.parse(sesionGuardada);
      email = datosUsuario.email || datosUsuario.usuarioEmail || datosUsuario.correo;
    }

    if (email) {
      localStorage.setItem("usuario_email", email);
      console.log("Sesión activa detectada en inicio. Registrando FCM para:", email);
      await registrarNotificacionesPush(email);
      iniciarSincronizacionContinua();
    }
  } catch (e) {
    console.error("Error leyendo sesión guardada al iniciar:", e);
  }
});

