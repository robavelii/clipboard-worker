// Windows would otherwise open a console alongside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    clipsync_desktop_lib::run()
}
