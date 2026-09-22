//! ClipSync tray app.
//!
//! The Rust side is deliberately thin: a tray icon, a panel that shows and
//! hides, and one command to read the agent's config. Everything else --
//! fetching history, decrypting it, the live socket -- happens in the webview
//! using the same TypeScript packages the CLI and web UI use, so there is no
//! second implementation of the crypto to keep in step.

use std::fs;
use std::path::PathBuf;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

/// `~/.config/clipsync/config.json`, written by `clipsync login`.
fn config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("clipsync").join("config.json"))
}

/// Append a line to a debug log.
///
/// The webview has no console anyone can see once the app is packaged, and a
/// failed `fetch` surfaces in WebKit as the uninformative "Load failed". This
/// gives the panel somewhere to record what actually went wrong.
#[tauri::command]
fn log_debug(line: String) {
    let path = std::env::temp_dir().join("clipsync-desktop.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

/// Hand the agent's credentials to the webview.
///
/// Reusing the CLI's config is what makes this app need no enrolment of its
/// own: if `clipsync` works on this machine, so does the tray.
#[tauri::command]
fn load_agent_config() -> Result<String, String> {
    let path = config_path().ok_or("cannot locate the config directory")?;
    fs::read_to_string(&path).map_err(|e| {
        format!(
            "cannot read {} ({e}) -- run `clipsync login` first",
            path.display()
        )
    })
}

/// Show the panel near the pointer, or hide it if it is already up.
fn toggle(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Requests go through Rust rather than the webview.
        //
        // The panel is served from tauri://localhost, so every call to the
        // Worker is cross-origin, and the Worker deliberately sends no CORS
        // headers -- the web UI shares its origin, so there was never a reason
        // to. Rather than open the API up for one client, the desktop app
        // makes its requests natively, where CORS does not apply.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![load_agent_config, log_debug])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open ClipSync", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("clipsync")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ClipSync")
                .menu(&menu)
                // The menu is for the right button only; a left click should
                // open the panel rather than a menu.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            toggle(&w);
                        }
                    }
                })
                .build(app)?;

            // Closing the panel should put it away, not end the session --
            // the whole point is that it keeps running in the background.
            if let Some(window) = app.get_webview_window("main") {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ClipSync");
}
