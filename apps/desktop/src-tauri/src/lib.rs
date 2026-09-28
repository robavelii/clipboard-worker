//! ClipSync tray app.
//!
//! The Rust side is deliberately thin: a tray icon, a panel that shows and
//! hides, and commands to read the agent's config and keep the panel's own. Everything else --
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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// `~/.config/clipsync`, where `clipsync login` writes `config.json`.
fn config_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("clipsync"))
}

fn config_path() -> Option<PathBuf> {
    Some(config_dir()?.join("config.json"))
}

/// The panel's own device credentials, beside the agent's.
fn tray_config_path() -> Option<PathBuf> {
    Some(config_dir()?.join("tray.json"))
}

/// Append a line to a debug log.
///
/// The webview has no console anyone can see once the app is packaged, and a
/// failed `fetch` surfaces in WebKit as the uninformative "Load failed". This
/// gives the panel somewhere to record what actually went wrong.
///
/// Under `$XDG_STATE_HOME/clipsync` (`~/.local/state/clipsync`), readable by
/// this user only: the log names devices and servers, and `/tmp`, where it
/// used to live, is shared with every other account on the machine.
#[tauri::command]
fn log_debug(line: String) {
    let Some(dir) = state_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut f) = options.open(dir.join("desktop.log")) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

/// `$XDG_STATE_HOME/clipsync`, where the panel's debug log goes.
fn state_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(base.join("clipsync"))
}

/// Hand the agent's credentials to the webview.
///
/// The panel uses them for the vault key and to enrol itself as a device on
/// first run, so there is nothing to set up: if `clipsync` works on this
/// machine, so does the tray.
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

/// Open the panel with the global shortcut unless tray.json names another.
///
/// Not Ctrl+Shift+V, the usual choice for a clipboard picker: that is paste
/// in every Linux terminal, and a global grab would take it from all of them.
/// Super+V is GNOME's notification list.
const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+V";

/// The shortcut from tray.json's optional `"shortcut"` field.
fn configured_shortcut() -> String {
    tray_config_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("shortcut")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_owned())
}

/// Move the panel to the pointer, kept inside the monitor it is on.
///
/// Where the panel opens matters for a keyboard picker: it should appear
/// where you are looking, not wherever it was last put away.
fn place_at_cursor(window: &WebviewWindow) {
    let Ok(cursor) = window.cursor_position() else { return };
    let Ok(size) = window.outer_size() else { return };
    let (w, h) = (size.width as f64, size.height as f64);
    let (mut x, mut y) = (cursor.x - w / 2.0, cursor.y + 12.0);

    if let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) {
        let (mx, my) = (monitor.position().x as f64, monitor.position().y as f64);
        let (mw, mh) = (monitor.size().width as f64, monitor.size().height as f64);
        x = x.clamp(mx, (mx + mw - w).max(mx));
        // No room below the pointer: open above it instead.
        if y + h > my + mh {
            y = cursor.y - h - 12.0;
        }
        y = y.clamp(my, (my + mh - h).max(my));
    }
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

fn show(window: &WebviewWindow) {
    place_at_cursor(window);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Show the panel at the pointer, or hide it if it is already in use.
///
/// "In use" is visible *and* focused: a panel left open behind other windows
/// should come forward on the shortcut, not vanish.
fn toggle(window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        show(window);
    }
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        toggle(&w);
    }
}

/// The panel's own credentials, or `None` before it has enrolled.
#[tauri::command]
fn load_tray_config() -> Result<Option<String>, String> {
    let path = tray_config_path().ok_or("cannot locate the config directory")?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {} ({e})", path.display())),
    }
}

/// Store the panel's credentials, readable by this user only -- the file
/// holds a bearer token, like the agent's config.
#[tauri::command]
fn save_tray_config(json: String) -> Result<(), String> {
    let path = tray_config_path().ok_or("cannot locate the config directory")?;
    let fail = |e: std::io::Error| format!("cannot write {} ({e})", path.display());

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(fail)?;
    use std::io::Write;
    file.write_all(json.as_bytes()).map_err(fail)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first. Launching the app again toggles the running panel
        // instead of starting a second tray icon -- which also makes
        // `clipsync-desktop` itself bindable to any key, the route on Wayland,
        // where global shortcuts cannot be grabbed.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            toggle_main(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        // Requests go through Rust rather than the webview.
        //
        // The panel is served from tauri://localhost, so every call to the
        // Worker is cross-origin, and the Worker deliberately sends no CORS
        // headers -- the web UI shares its origin, so there was never a reason
        // to. Rather than open the API up for one client, the desktop app
        // makes its requests natively, where CORS does not apply.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            load_agent_config,
            load_tray_config,
            save_tray_config,
            log_debug
        ])
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
                            show(&w);
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
                        toggle_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // A shortcut another app already holds is not worth failing over:
            // the tray menu still opens the panel.
            let shortcut = configured_shortcut();
            if let Err(e) = app.global_shortcut().register(shortcut.as_str()) {
                log_debug(format!("shortcut {shortcut} not registered: {e}"));
            }

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
