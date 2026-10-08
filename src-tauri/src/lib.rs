// ── Overlay window commands ────────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};
static OVERLAY_POSITIONED: AtomicBool = AtomicBool::new(false);

/// Set when the user explicitly quits via Cmd+Q / Quit menu (RunEvent::ExitRequested).
/// While false, the main window's red close button only hides the window so the user can
/// reopen it from the Dock — matching the standard macOS app lifecycle (ChatGPT, Linear, etc.).
/// While true, CloseRequested is allowed to proceed so the app shuts down normally.
static APP_QUITTING: AtomicBool = AtomicBool::new(false);

const OVERLAY_W: f64 = 600.0;
const OVERLAY_H: f64 = 118.0;
const OVERLAY_W_COMPACT: f64 = 260.0;
const OVERLAY_H_COMPACT: f64 = 56.0;

/// Make the overlay a real macOS floating companion (NSPanel-style HUD):
///   1. Class-swap the underlying NSWindow → NSPanel via `object_setClass`.
///      tao creates a `TaoWindow` subclass of NSWindow; we swap it to NSPanel
///      so AppKit treats the window as a panel for all the cross-Space and
///      activation-policy purposes. Standard pattern used by Codex Pet,
///      Itsycal, Magnet, and every floating-companion app on macOS.
///   2. Add `NonactivatingPanel` style-mask bit so showing/clicking the panel
///      does NOT activate the Youmi Lens app — the user's current app
///      (Chrome, WPS, PPT) keeps focus.
///   3. `setHidesOnDeactivate(false)` — explicitly stays visible when the host
///      app is no longer frontmost.
///   4. `setLevel(NSPopUpMenuWindowLevel)` (101) — high enough to float over
///      fullscreen Chrome / WPS content. Previous round used
///      NSStatusWindowLevel (25) which proved insufficient.
///   5. Collection behavior = `CanJoinAllSpaces | FullScreenAuxiliary
///      | Stationary | IgnoresCycle` (unchanged from previous round).
///   6. `orderFrontRegardless()` to bring the panel to the front of its level
///      WITHOUT calling `makeKeyAndOrderFront:` (which would activate the
///      app and could yank the user back to the Youmi Lens Space).
///
/// All AppKit work is dispatched onto the main thread via
/// `run_on_main_thread`; the `ns_window()` getter is called inside the
/// closure so it resolves on the main thread too.
///
/// Logs every before/after value with the `[OverlaySpaces]` prefix via
/// `eprintln!` (visible in `Console.app` / `log stream` even in release
/// builds, because the `tauri_plugin_log` plugin is only registered in debug
/// builds).
#[cfg(target_os = "macos")]
fn apply_overlay_workspace_behavior<R: tauri::Runtime>(
  window: &tauri::WebviewWindow<R>,
  phase: &'static str,
) {
  let win = window.clone();
  let dispatch = window.run_on_main_thread(move || {
    let ptr = match win.ns_window() {
      Ok(p) => p,
      Err(e) => {
        eprintln!("[OverlaySpaces] {phase}: ns_window() error: {e}");
        return;
      }
    };
    if ptr.is_null() {
      eprintln!("[OverlaySpaces] {phase}: ns_window pointer is NULL");
      return;
    }
    unsafe {
      use objc2::runtime::AnyObject;
      use objc2::ClassType;
      use objc2_app_kit::{
        NSPanel, NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
      };

      let ns_window: &NSWindow = &*(ptr as *const NSWindow);
      let any_obj: &AnyObject = &*(ptr as *const AnyObject);

      let before_behavior = ns_window.collectionBehavior();
      let before_level = ns_window.level();
      let before_style = ns_window.styleMask();
      let before_class_name = std::ffi::CStr::from_ptr(
        objc2::ffi::object_getClassName(ptr.cast::<AnyObject>()),
      )
      .to_string_lossy()
      .into_owned();
      let visible = ns_window.isVisible();

      // 1. Class-swap → NSPanel. Use raw `object_setClass` so we bypass the
      //    debug-only `instance_size` assert in `AnyObject::set_class`
      //    (TaoWindow has a 1-byte `focusable` ivar that NSPanel lacks; the
      //    extra byte just stays unused, which is sound).
      let panel_class = NSPanel::class();
      let panel_class_ptr: *const objc2::runtime::AnyClass = panel_class;
      let _prev_class = objc2::ffi::object_setClass(
        any_obj as *const AnyObject as *mut AnyObject,
        panel_class_ptr,
      );

      // 2. Non-activating panel style mask. Keep all the existing bits
      //    (Borderless was already there because decorations: false).
      let new_style = before_style | NSWindowStyleMask::NonactivatingPanel;
      ns_window.setStyleMask(new_style);

      // 3. Stay visible when the host app is no longer frontmost.
      ns_window.setHidesOnDeactivate(false);

      // 4. Raise level above NSStatusWindowLevel — popup-menu level (101)
      //    floats above fullscreen apps' content on macOS in our testing.
      ns_window.setLevel(NSPopUpMenuWindowLevel);

      // 5. CollectionBehavior — every cross-Space bit we have access to.
      let target_behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle;
      ns_window.setCollectionBehavior(target_behavior);

      // (Step 6 — orderFrontRegardless — is intentionally NOT here.
      //  Setup-time should only configure flags without making the panel
      //  visible. show_overlay() calls order_overlay_front() separately
      //  after applying flags.)

      let after_behavior = ns_window.collectionBehavior();
      let after_level = ns_window.level();
      let after_style = ns_window.styleMask();
      let after_class_name = std::ffi::CStr::from_ptr(
        objc2::ffi::object_getClassName(ptr.cast::<AnyObject>()),
      )
      .to_string_lossy()
      .into_owned();
      let visible_after = ns_window.isVisible();
      let hides_on_deactivate = ns_window.hidesOnDeactivate();

      eprintln!(
        "[OverlaySpaces] {phase}: ns_window=0x{:x} \
         class {before_class_name} -> {after_class_name} \
         visible {visible} -> {visible_after} \
         level {before_level} -> {after_level} (popup={NSPopUpMenuWindowLevel}) \
         styleMask 0x{:x} -> 0x{:x} (NonactivatingPanel? {}) \
         behavior 0x{:x} -> 0x{:x} \
         [CanJoinAllSpaces={} FullScreenAuxiliary={} Stationary={} IgnoresCycle={}] \
         hidesOnDeactivate={hides_on_deactivate}",
        ptr as usize,
        before_style.0,
        after_style.0,
        after_style.contains(NSWindowStyleMask::NonactivatingPanel),
        before_behavior.0,
        after_behavior.0,
        after_behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces),
        after_behavior.contains(NSWindowCollectionBehavior::FullScreenAuxiliary),
        after_behavior.contains(NSWindowCollectionBehavior::Stationary),
        after_behavior.contains(NSWindowCollectionBehavior::IgnoresCycle),
      );
    }
  });
  if let Err(e) = dispatch {
    eprintln!("[OverlaySpaces] {phase}: run_on_main_thread dispatch error: {e}");
  }
}

/// Bring the overlay panel to the front of its level WITHOUT activating the
/// Youmi Lens app. Replaces Tauri's `show()` (which calls
/// `makeKeyAndOrderFront:` and can drag the user back to Youmi Lens's Space).
/// Must run on the main thread.
#[cfg(target_os = "macos")]
fn order_overlay_front<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
  let win = window.clone();
  let dispatch = window.run_on_main_thread(move || {
    let ptr = match win.ns_window() {
      Ok(p) if !p.is_null() => p,
      _ => {
        eprintln!("[OverlaySpaces] order: ns_window unavailable");
        return;
      }
    };
    unsafe {
      use objc2_app_kit::NSWindow;
      let ns_window: &NSWindow = &*(ptr as *const NSWindow);
      let was_visible = ns_window.isVisible();
      ns_window.orderFrontRegardless();
      eprintln!(
        "[OverlaySpaces] order: ns_window=0x{:x} visible {was_visible} -> {}",
        ptr as usize,
        ns_window.isVisible()
      );
    }
  });
  if let Err(e) = dispatch {
    eprintln!("[OverlaySpaces] order: run_on_main_thread dispatch error: {e}");
  }
}

#[tauri::command]
fn show_overlay(app: tauri::AppHandle) {
  use tauri::Manager;
  let Some(w) = app.get_webview_window("overlay") else {
    eprintln!("[OverlaySpaces] show_overlay: overlay window NOT FOUND");
    return;
  };
  eprintln!("[OverlaySpaces] show_overlay: entered, label={}", w.label());

  // Ensure expanded size is restored (in case it was left compact)
  let _ = w.set_size(tauri::LogicalSize::new(OVERLAY_W, OVERLAY_H));
  // On first show, position at bottom-center of primary monitor above the Dock.
  if !OVERLAY_POSITIONED.swap(true, Ordering::SeqCst) {
    if let Ok(Some(monitor)) = w.primary_monitor() {
      let scale = monitor.scale_factor();
      let sw = monitor.size().width as f64 / scale;
      let sh = monitor.size().height as f64 / scale;
      let dock_margin = 92.0_f64;
      let x = (sw - OVERLAY_W) / 2.0;
      let y = sh - OVERLAY_H - dock_margin;
      let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
  }
  // Re-assert transparency on every show. With `macOSPrivateApi: true` + the
  // `macos-private-api` feature on the `tauri` crate, wry actually wires
  // `drawsBackground=false` on the WKWebView config and `NSWindow.opaque=NO`.
  let _ = w.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
  // Disable the native NSWindow shadow.
  let _ = w.set_shadow(false);

  // Workspace behavior. macOS: configure NSPanel-style flags first, then
  // bring to front via orderFrontRegardless (NOT makeKeyAndOrderFront, which
  // would activate Youmi Lens and could yank the user back to its Space).
  #[cfg(target_os = "macos")]
  {
    apply_overlay_workspace_behavior(&w, "show");
    order_overlay_front(&w);
  }

  #[cfg(not(target_os = "macos"))]
  {
    // Windows / Linux: there is no NSPanel equivalent, so surface the frameless,
    // transparent, always-on-top overlay with the standard Tauri WebviewWindow
    // APIs. `set_visible_on_all_workspaces` is unsupported on Windows (no-op,
    // safely ignored — it stays for Linux). We re-assert always-on-top (the
    // window config already sets it, but re-asserting guards against it being
    // cleared), then show and bring it to the foreground so it reliably appears
    // above the user's other windows. Unlike the macOS non-activating panel, a
    // brief focus here is acceptable — the main window is minimized at the same
    // time, and `alwaysOnTop` keeps the overlay above the focused app afterward.
    let _ = w.set_visible_on_all_workspaces(true);
    let _ = w.set_always_on_top(true);
    let _ = w.show();
    let _ = w.set_focus();
  }

  // Intentionally NOT calling set_focus(): the overlay is a passive caption HUD
  // and must not steal keyboard focus from Chrome/WPS/PPT/Notes. Buttons and
  // dragging still work because the panel accepts mouse events at its high
  // level, and clicks routed through performWindowDragWithEvent: from
  // OverlayWindow.tsx do not require key-window status.
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) {
  use tauri::Manager;
  if let Some(w) = app.get_webview_window("overlay") {
    let _ = w.hide();
  }
}

#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
  use tauri::Manager;
  #[cfg(target_os = "macos")]
  {
    let _ = app.show();
  }
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
  }
}

#[tauri::command]
fn minimize_main_window(app: tauri::AppHandle) {
  use tauri::Manager;
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.minimize();
  }
}

#[tauri::command]
fn resize_overlay_compact(app: tauri::AppHandle) {
  use tauri::Manager;
  if let Some(w) = app.get_webview_window("overlay") {
    let _ = w.set_size(tauri::LogicalSize::new(OVERLAY_W_COMPACT, OVERLAY_H_COMPACT));
  }
}

#[tauri::command]
fn resize_overlay_expanded(app: tauri::AppHandle) {
  use tauri::Manager;
  if let Some(w) = app.get_webview_window("overlay") {
    let _ = w.set_size(tauri::LogicalSize::new(OVERLAY_W, OVERLAY_H));
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

#[cfg(all(
  not(target_os = "android"),
  not(target_os = "ios"),
))]
use tauri::Runtime;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri::{Listener, Manager};

  let mut builder = tauri::Builder::default();

  // Deep-link plugin must register before single-instance so the latter can call
  // `deep_link.handle_cli_arguments` on the primary app when a second instance
  // is opened with lecturecompanion://… (see tauri-plugin-single-instance `deep-link` feature).
  //
  // macOS caveat: `handle_cli_arguments` only parses argv on Windows/Linux. URL opens on macOS
  // normally use `RunEvent::Opened` on the process that receives the event. A secondary
  // process killed by single-instance exits in `setup` before that event runs, so the URL is
  // only available via forwarded argv — we re-emit `deep-link://new-url` in the callback below.
  builder = builder.plugin(tauri_plugin_deep_link::init());
  builder = builder.plugin(tauri_plugin_shell::init());

  // In-app auto update (Phase 2E): official Tauri v2 updater + process (relaunch).
  // Desktop only. The frontend drives check/download/install via the JS plugin;
  // install/restart is gated by the recording-safety rule in the UI layer.
  #[cfg(all(not(target_os = "android"), not(target_os = "ios")))]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder = builder.plugin(tauri_plugin_process::init());
  }

  #[cfg(all(not(target_os = "android"), not(target_os = "ios")))]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      #[cfg(target_os = "macos")]
      emit_forwarded_deep_link_urls(&app, &args);

      // Close stray/auth-callback webviews on a second-instance launch, but NEVER
      // the persistent "overlay" window. The overlay is created once from
      // tauri.conf.json; `close()` destroys it permanently, after which
      // get_webview_window("overlay") returns None and show_overlay silently
      // no-ops. On Windows this is hit by relaunching (e.g. from the desktop
      // shortcut) while an instance is already running, which broke the Lecture
      // Overlay. macOS is unaffected in normal use (no second instance).
      for (label, w) in app.webview_windows() {
        if label != "main" && label != "overlay" {
          log::info!("[single-instance] closing non-main webview: {}", label);
          let _ = w.close();
        }
      }

      activate_main_for_auth_callback(&app);
      if !args.is_empty() {
        log::info!("[single-instance] secondary launch args: {:?}", args);
      }
    }));
  }

  builder
    .invoke_handler(tauri::generate_handler![
      show_overlay,
      hide_overlay,
      focus_main_window,
      minimize_main_window,
      resize_overlay_compact,
      resize_overlay_expanded,
      auth_callback_scheme
    ])
    .setup(|app| {
      #[cfg(all(not(target_os = "android"), not(target_os = "ios")))]
      {
        let handle = app.handle().clone();
        let _ = app.listen("deep-link://new-url", move |_event| {
          activate_main_for_auth_callback(&handle);
        });
      }

      // Re-assert transparent overlay at startup, and pre-apply macOS
      // collection behavior + level so the overlay is wired for all-Spaces
      // floating before its first show.
      {
        use tauri::Manager;
        if let Some(overlay) = app.get_webview_window("overlay") {
          let _ = overlay.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
          #[cfg(target_os = "macos")]
          apply_overlay_workspace_behavior(&overlay, "setup");
        } else {
          eprintln!("[OverlaySpaces] setup: overlay window NOT FOUND");
        }
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // macOS-style close behavior for the main window. The red close button hides the window
      // (the Tauri app keeps running, dock icon stays visible, reopen works). Cmd+Q / Quit menu
      // sets APP_QUITTING via RunEvent::ExitRequested below and is allowed through.
      //
      // Fullscreen caveat: calling `hide()` on a window that owns its own macOS fullscreen Space
      // leaves the Space alive with no visible content — the user is left staring at a black
      // fullscreen Space they can't escape. We must exit fullscreen FIRST, wait for the AppKit
      // exit-fullscreen animation to complete, then hide on the main thread.
      //
      // Overlay window is not affected: it has `decorations: false` (no close button) and is
      // hidden via the existing hide_overlay command from the overlay UI.
      if let Some(main) = app.get_webview_window("main") {
        let main_for_handler = main.clone();
        main.on_window_event(move |event| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if APP_QUITTING.load(Ordering::SeqCst) {
              // Real quit in progress — allow the window to close.
              return;
            }
            api.prevent_close();
            let win = main_for_handler.clone();
            let was_fullscreen = win.is_fullscreen().unwrap_or(false);
            if was_fullscreen {
              // Step 1: tell AppKit to leave fullscreen. This kicks off the ~500 ms exit
              // animation; the window's NSWindow.styleMask drops .fullScreen when done.
              let _ = win.set_fullscreen(false);
              // Step 2: wait for the animation to finish, then hide on the main thread.
              // Hiding mid-animation reproduces the original black-Space bug. 700 ms is a
              // safe margin above the ~500 ms animation and is unnoticeable in practice.
              let win_for_thread = win.clone();
              std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(700));
                let win_for_main_thread = win_for_thread.clone();
                let _ = win_for_thread.run_on_main_thread(move || {
                  let _ = win_for_main_thread.hide();
                });
              });
            } else {
              let _ = win.hide();
            }
          }
        });
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| match event {
      // Cmd+Q / Quit menu. Flag the close handler so the next CloseRequested isn't intercepted.
      tauri::RunEvent::ExitRequested { .. } => {
        APP_QUITTING.store(true, Ordering::SeqCst);
      }
      // macOS Dock icon click (applicationShouldHandleReopen). Always attempt to restore so
      // the user never has to Force Quit — works whether the window is hidden, minimized, in
      // a separate Space, or already visible. `has_visible_windows` can be unreliable after a
      // fullscreen-exit-then-hide flow, so we don't gate on it.
      //
      // `RunEvent::Reopen` only exists on macOS (it maps to AppKit's
      // applicationShouldHandleReopen), so the whole arm is gated to macOS —
      // on Windows/Linux the variant isn't present and would fail to compile.
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen { .. } => {
        let _ = app_handle.show();
        if let Some(w) = app_handle.get_webview_window("main") {
          // Defensive: only force-exit fullscreen if the window is currently hidden — that
          // means a prior CloseRequested left it in an inconsistent state. Don't disturb an
          // intentionally fullscreen window the user is reactivating.
          let visible = w.is_visible().unwrap_or(false);
          if !visible && w.is_fullscreen().unwrap_or(false) {
            let _ = w.set_fullscreen(false);
          }
          let _ = w.show();
          let _ = w.unminimize();
          let _ = w.set_focus();
        }
      }
      _ => {}
    });
}

/// This build's deep-link scheme: the single scheme in `plugins.deep-link.desktop.schemes` of the config it
/// was packaged with (the same value the plugin registers in CFBundleURLSchemes). `None` unless exactly one.
fn configured_auth_scheme<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
  let schemes = app
    .config()
    .plugins
    .0
    .get("deep-link")?
    .get("desktop")?
    .get("schemes")?
    .as_array()?;
  match schemes.as_slice() {
    [only] => only.as_str().map(str::to_string),
    _ => None,
  }
}

/// Lets the frontend build its callback URL from the same source Rust uses (no duplicated constant).
#[tauri::command]
fn auth_callback_scheme<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
  configured_auth_scheme(&app).ok_or_else(|| "auth_scheme_not_configured".to_string())
}

/// Bring the main webview to the foreground after a deep link or second-instance handoff.
///
/// On macOS, `RunEvent::Opened` delivers URLs to the **already-running** app without going through
/// `single-instance`; we rely on a global listener for `deep-link://new-url` for that path.
/// `AppHandle::show` maps to `show_application()` and helps the app steal focus from the mail client.
#[cfg(all(not(target_os = "android"), not(target_os = "ios")))]
fn activate_main_for_auth_callback<R: Runtime>(app: &tauri::AppHandle<R>) {
  use tauri::Manager;
  #[cfg(target_os = "macos")]
  {
    let _ = app.show();
  }
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
  }
}

/// macOS: single-instance forwards `std::env::args()` from the secondary process. If the custom
/// scheme appears there, emit the same event the deep-link plugin uses so the main webview runs
/// `onOpenUrl` and updates Supabase session on the existing window.
#[cfg(target_os = "macos")]
fn emit_forwarded_deep_link_urls<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String]) {
  use tauri::Emitter;
  let Some(scheme) = configured_auth_scheme(app) else {
    return;
  };
  let urls = collect_scheme_urls_from_args(args, &scheme);
  if urls.is_empty() {
    return;
  }
  log::info!(
    "[single-instance] forwarding {} deep link URL(s) to main webview",
    urls.len()
  );
  let _ = app.emit("deep-link://new-url", urls);
}

/// Collect only URLs of this build's own scheme (`<scheme>://`). Another build's scheme is never collected.
#[cfg(target_os = "macos")]
fn collect_scheme_urls_from_args(args: &[String], scheme: &str) -> Vec<String> {
  let marker = format!("{scheme}://");
  let mut out = Vec::new();
  for arg in args {
    let arg = arg.trim();
    if arg.starts_with(&marker) {
      out.push(arg.to_string());
      continue;
    }
    if let Some(i) = arg.find(&marker) {
      let rest = arg[i..].trim_end();
      if !rest.is_empty() {
        out.push(rest.to_string());
      }
    }
  }
  out
}

#[cfg(all(test, target_os = "macos"))]
mod auth_scheme_tests {
  use super::collect_scheme_urls_from_args;

  fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn production_collects_only_its_own_scheme() {
    let a = args(&[
      "/app",
      "lecturecompanion://auth-callback#access_token=x",
      "lecturecompanion-qa1015://auth-callback#access_token=y",
    ]);
    assert_eq!(
      collect_scheme_urls_from_args(&a, "lecturecompanion"),
      vec!["lecturecompanion://auth-callback#access_token=x".to_string()]
    );
  }

  #[test]
  fn qa_collects_only_its_own_scheme() {
    let a = args(&[
      "lecturecompanion://auth-callback",
      "lecturecompanion-qa1015://auth-callback?code=1",
      "lecturecompanion-qa1016://auth-callback?code=2",
      "lecturecompanion-qa10150://auth-callback",
    ]);
    assert_eq!(
      collect_scheme_urls_from_args(&a, "lecturecompanion-qa1015"),
      vec!["lecturecompanion-qa1015://auth-callback?code=1".to_string()]
    );
    assert_eq!(
      collect_scheme_urls_from_args(&a, "lecturecompanion-qa1016"),
      vec!["lecturecompanion-qa1016://auth-callback?code=2".to_string()]
    );
  }

  #[test]
  fn unrelated_and_empty_args_collect_nothing() {
    let a = args(&["--flag", "https://evil.example/x", "evil://auth-callback", ""]);
    assert!(collect_scheme_urls_from_args(&a, "lecturecompanion").is_empty());
    assert!(collect_scheme_urls_from_args(&[], "lecturecompanion-qa1015").is_empty());
  }

  #[test]
  fn embedded_marker_keeps_production_behaviour() {
    let a = args(&["open lecturecompanion://auth-callback?x=1  "]);
    assert_eq!(
      collect_scheme_urls_from_args(&a, "lecturecompanion"),
      vec!["lecturecompanion://auth-callback?x=1".to_string()]
    );
  }
}
