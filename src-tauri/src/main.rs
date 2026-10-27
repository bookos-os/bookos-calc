#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("bookos-calc");
    let _ = fs::create_dir_all(&p);
    p.push("state.json");
    p
}

#[tauri::command]
fn load_state() -> serde_json::Value {
    let p = config_path();
    if let Ok(s) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            return v;
        }
    }
    serde_json::json!({ "history": [], "theme": "auto" })
}

#[tauri::command]
fn save_state(state: serde_json::Value) -> Result<(), String> {
    let p = config_path();
    let s = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

/// El tema del escritorio, preguntado al portal XDG.
///
/// Va **antes** que `kreadconfig6`: esa orden solo sabe de Plasma y lee el
/// `kdeglobals` del usuario, que en una sesión BookOS no lo escribe nadie —el
/// tema se elige en la tarjeta de Apariencia y vive en `panel.conf`—, así que
/// la app se quedaba con el tema con el que se instaló el sistema. El portal
/// lo sirve la sesión que esté corriendo: BookOS desde el propio compositor,
/// y Plasma y GNOME también, de modo que esto funciona en las tres.
///
/// `color-scheme`: 1 oscuro, 2 claro, 0 sin preferencia. `gdbus` viene con
/// GLib, que ya es dependencia de cualquier app Tauri: no añade nada.
fn portal_color_scheme() -> Option<String> {
    let salida = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.portal.Desktop",
            "--object-path",
            "/org/freedesktop/portal/desktop",
            "--method",
            "org.freedesktop.portal.Settings.ReadOne",
            "org.freedesktop.appearance",
            "color-scheme",
        ])
        .output()
        .ok()?;
    // Contesta «(<uint32 1>,)»; el 0 es «sin preferencia» y no es respuesta.
    let texto = String::from_utf8_lossy(&salida.stdout);
    let n = texto.split("uint32").nth(1)?.trim_start().chars().next()?;
    match n {
        '1' => Some("dark".to_string()),
        '2' => Some("light".to_string()),
        _ => None,
    }
}

#[tauri::command]
fn detect_system_theme() -> String {
    if let Some(tema) = portal_color_scheme() {
        return tema;
    }
    let kde_attempts = [
        ("kreadconfig6", &["--group", "General", "--key", "ColorScheme"][..]),
        ("kreadconfig5", &["--group", "General", "--key", "ColorScheme"][..]),
    ];
    for (bin, args) in kde_attempts {
        if let Ok(out) = Command::new(bin).args(args).output() {
            let s = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if s.contains("dark") { return "dark".into(); }
            if s.contains("light") { return "light".into(); }
        }
    }
    if let Ok(out) = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if s.contains("dark") { return "dark".into(); }
        if s.contains("light") { return "light".into(); }
    }
    "auto".into()
}

/// Quita el zoom de página que WebKitGTK hace con el pellizco del touchpad.
///
/// No hay ajuste para eso ni en WebKit ni en Tauri, y la página no se entera:
/// el pellizco lo consume un `GtkGestureZoom` de la propia vista y llega como
/// `setMagnification`, no como `wheel` ni `touch*`, así que ningún
/// `preventDefault` lo frena. Se apaga ese gesto y ningún otro: con fase `None`
/// GTK deja de pasarle eventos (gtkeventcontroller.c, 3.24). Va en
/// `on_page_load` para cubrir también las ventanas que se abran después.
fn desactivar_zoom_por_pellizco<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    _: &tauri::webview::PageLoadPayload<'_>,
) {
    #[cfg(target_os = "linux")]
    let _ = webview.with_webview(|webview| {
        use gtk::glib::translate::from_glib_none;
        use gtk::prelude::*;

        // WebKitGTK guarda ahí el gesto (WebKitWebViewBase.cpp, 2.52.5). No es
        // API pública: si la clave cambia, no se encuentra y el zoom vuelve.
        // Lo guardado es un puntero C a un GObject, no un tipo de Rust.
        let Some(gesto) = (unsafe { webview.inner().data::<gtk::ffi::GtkGesture>("wk-view-zoom-gesture") }) else {
            return;
        };
        let gesto: gtk::Gesture = unsafe { from_glib_none(gesto.as_ptr()) };
        gesto.set_propagation_phase(gtk::PropagationPhase::None);
    });
}

#[tauri::command]
fn bookos_language() -> String {
    let locale = std::env::var("LANG").unwrap_or_else(|_| "en".into());
    let Some(home) = std::env::var_os("HOME") else {
        return if locale.to_lowercase().starts_with("es") { "es" } else { "en" }.into();
    };
    let path = std::path::PathBuf::from(home).join(".config/bookos/settings.json");
    let language = std::fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|settings| settings.get("AppLanguage").and_then(|value| value.as_str()).map(str::to_owned));
    match language.as_deref() {
        Some("es") => "es".into(),
        Some("en") => "en".into(),
        _ if locale.to_lowercase().starts_with("es") => "es".into(),
        _ => "en".into(),
    }
}

/// Ajustes de WebKitGTK que recortan memoria. Van por entorno porque los leen
/// los procesos hijos (web y red) al arrancar y wry no deja tocar la vista
/// antes de crearla. Medido en PSS del árbol entero, mediana de 5 arranques
/// (WebKitGTK 2.54.1, Wayland, Intel LNL): 109,6 MB sin nada, 109,6 → 92,3 con
/// `JSC_useJIT=0`: el intérprete sobra para una calculadora y el JIT reserva
/// memoria ejecutable que crece con el uso.
///
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1` bajaba a 95,6 MB pero con él la ventana
/// salió negra y sin repintar (se veía el texto de la terminal de detrás);
/// no se activa mientras no se demuestre que es inocente. `MALLOC_ARENA_MAX=1` y `WEBKIT_DISABLE_COMPOSITING_MODE` no
/// se notan. Lo que ya venga definido se respeta.
fn ajustar_webkit() {
    if std::env::var_os("JSC_useJIT").is_none() {
        std::env::set_var("JSC_useJIT", "0");
    }
}

fn main() {
    ajustar_webkit();
    tauri::Builder::default()
        .on_page_load(desactivar_zoom_por_pellizco)
        .invoke_handler(tauri::generate_handler![
            bookos_palette_css,
            load_state,
            save_state,
            bookos_language,
            detect_system_theme
        ])
        .setup(|app| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running app");
}

// ── Color dinámico ───────────────────────────────────────────────────────
// La paleta la genera BookOS Settings desde el fondo de pantalla y la deja en
// ~/.config/bookos/palette.css. Aquí solo se lee: quien tiñe es la hoja, que
// el cliente bookos-palette.js inyecta al final de <head>.
#[tauri::command]
fn bookos_palette_css() -> String {
    std::env::var("HOME").ok()
        .map(|h| std::path::Path::new(&h).join(".config/bookos/palette.css"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

