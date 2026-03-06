use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// ---------------------------------------------------------------------------
// Windows API — used for cursor position capture only
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win_api {
    #[repr(C)]
    pub struct POINT {
        pub x: i32,
        pub y: i32,
    }

    extern "system" {
        pub fn GetCursorPos(lpPoint: *mut POINT) -> i32;
        pub fn GetAsyncKeyState(vKey: i32) -> i16;
    }

    pub const VK_LBUTTON: i32 = 0x01;

    pub fn wait_for_left_click(timeout_ms: u64) -> Option<(i32, i32)> {
        let start = std::time::Instant::now();

        unsafe {
            while (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 {
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        loop {
            if start.elapsed().as_millis() as u64 > timeout_ms {
                return None;
            }
            unsafe {
                if (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 {
                    let mut pt = POINT { x: 0, y: 0 };
                    GetCursorPos(&mut pt);
                    while (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    return Some((pt.x, pt.y));
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    use std::time::Duration;
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClickPosition {
    CurrentCursor,
    Fixed { x: i32, y: i32 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TriggerMode {
    Toggle,
    Hold,
}

/// Action performed by a single step inside a Sequence.
/// Mirrors ActionType but without the Sequence variant (no recursion).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SequenceStepAction {
    MouseClick {
        button: MouseButton,
        position: ClickPosition,
    },
    KeyPress { key: String },
    KeyCombo { keys: Vec<String> },
}

/// One step in a Sequence: an action to perform + how long to pause afterward.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SequenceStep {
    /// Stable ID used by the frontend as a React key.
    pub id: String,
    pub action: SequenceStepAction,
    /// Milliseconds to sleep after this step before executing the next one.
    pub delay_ms: u64,
}

/// What the action actually does when fired.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionType {
    MouseClick {
        button: MouseButton,
        position: ClickPosition,
    },
    KeyPress { key: String },
    KeyCombo { keys: Vec<String> },
    /// Run each step in order, sleeping `delay_ms` after each one.
    /// After the last step the scheduler waits `interval_ms` before repeating.
    Sequence { steps: Vec<SequenceStep> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub name: String,
    pub hotkey: Option<String>,
    pub trigger_mode: TriggerMode,
    pub action_type: ActionType,
    pub interval_ms: u64,
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Runtime state per action
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ActionRuntimeState {
    active: bool,
    last_execution: Option<Instant>,
    /// True while a Sequence is running in a background thread.
    /// Prevents re-firing until the previous run completes.
    executing: bool,
}

impl Default for ActionRuntimeState {
    fn default() -> Self {
        Self {
            active: false,
            last_execution: None,
            executing: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Shared app state
// ---------------------------------------------------------------------------

pub struct AppState {
    actions: Vec<Action>,
    runtime: HashMap<String, ActionRuntimeState>,
}

impl Default for AppState {
    fn default() -> Self {
        let lmb = Action {
            id: "lmb".into(),
            name: "Left Click".into(),
            hotkey: None,
            trigger_mode: TriggerMode::Toggle,
            action_type: ActionType::MouseClick {
                button: MouseButton::Left,
                position: ClickPosition::CurrentCursor,
            },
            interval_ms: 100,
            enabled: true,
        };
        let rmb = Action {
            id: "rmb".into(),
            name: "Right Click".into(),
            hotkey: None,
            trigger_mode: TriggerMode::Toggle,
            action_type: ActionType::MouseClick {
                button: MouseButton::Right,
                position: ClickPosition::CurrentCursor,
            },
            interval_ms: 100,
            enabled: true,
        };
        let mut runtime = HashMap::new();
        runtime.insert("lmb".into(), ActionRuntimeState::default());
        runtime.insert("rmb".into(), ActionRuntimeState::default());
        AppState {
            actions: vec![lmb, rmb],
            runtime,
        }
    }
}

pub type SharedState = Arc<Mutex<AppState>>;

// ---------------------------------------------------------------------------
// Key string → enigo Key mapping
// ---------------------------------------------------------------------------

fn str_to_key(s: &str) -> Option<Key> {
    match s.to_lowercase().as_str() {
        "ctrl" | "control" => Some(Key::Control),
        "alt" => Some(Key::Alt),
        "shift" => Some(Key::Shift),
        "meta" | "win" | "super" | "cmd" => Some(Key::Meta),
        "return" | "enter" => Some(Key::Return),
        "backspace" => Some(Key::Backspace),
        "delete" => Some(Key::Delete),
        "tab" => Some(Key::Tab),
        "escape" | "esc" => Some(Key::Escape),
        "space" => Some(Key::Space),
        "up" => Some(Key::UpArrow),
        "down" => Some(Key::DownArrow),
        "left" => Some(Key::LeftArrow),
        "right" => Some(Key::RightArrow),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "insert" => Some(Key::Insert),
        "capslock" => Some(Key::CapsLock),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        s if s.len() == 1 => {
            let c = s.chars().next()?;
            Some(Key::Unicode(c))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

fn execute_action(enigo: &mut Enigo, action_type: &ActionType) {
    match action_type {
        ActionType::MouseClick { button, position } => execute_click(enigo, button, position),
        ActionType::KeyPress { key } => execute_key_press(enigo, key),
        ActionType::KeyCombo { keys } => execute_key_combo(enigo, keys),
        ActionType::Sequence { .. } => {} // handled separately via spawn in scheduler
    }
}

fn execute_click(enigo: &mut Enigo, button: &MouseButton, position: &ClickPosition) {
    let enigo_button = match button {
        MouseButton::Left => Button::Left,
        MouseButton::Right => Button::Right,
    };

    match position {
        ClickPosition::CurrentCursor => {
            let _ = enigo.button(enigo_button, Direction::Click);
        }
        ClickPosition::Fixed { x, y } => {
            let current = enigo.location().unwrap_or((0, 0));
            let _ = enigo.move_mouse(*x, *y, Coordinate::Abs);
            let _ = enigo.button(enigo_button, Direction::Click);
            let _ = enigo.move_mouse(current.0, current.1, Coordinate::Abs);
        }
    }
}

fn execute_key_press(enigo: &mut Enigo, key: &str) {
    if let Some(k) = str_to_key(key) {
        let _ = enigo.key(k, Direction::Click);
    }
}

fn execute_key_combo(enigo: &mut Enigo, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let (modifiers, tail) = keys.split_at(keys.len() - 1);
    let main_key = &tail[0];

    let mut pressed: Vec<Key> = Vec::new();
    for m in modifiers {
        if let Some(k) = str_to_key(m) {
            if enigo.key(k, Direction::Press).is_ok() {
                pressed.push(k);
            }
        }
    }
    if let Some(k) = str_to_key(main_key) {
        let _ = enigo.key(k, Direction::Click);
    }
    for k in pressed.into_iter().rev() {
        let _ = enigo.key(k, Direction::Release);
    }
}

fn execute_step_action(enigo: &mut Enigo, action: &SequenceStepAction) {
    match action {
        SequenceStepAction::MouseClick { button, position } => execute_click(enigo, button, position),
        SequenceStepAction::KeyPress { key } => execute_key_press(enigo, key),
        SequenceStepAction::KeyCombo { keys } => execute_key_combo(enigo, keys),
    }
}

/// Run every step in order, sleeping `delay_ms` after each one.
fn execute_sequence(steps: &[SequenceStep]) {
    for step in steps {
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            execute_step_action(&mut enigo, &step.action);
        }
        if step.delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(step.delay_ms));
        }
    }
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

/// Returns the path to the settings JSON file.
/// On Windows: %APPDATA%\BobsBetterAutoclicker\settings.json
fn settings_path() -> std::path::PathBuf {
    let dir = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(dir)
        .join("BobsBetterAutoclicker")
        .join("settings.json")
}

/// Serialize `actions` to the settings file. Errors are silently ignored —
/// the app continues working; settings just won't survive the next restart.
fn persist_actions(actions: &[Action]) {
    if let Ok(json) = serde_json::to_string_pretty(actions) {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, json);
    }
}

/// Try to load saved actions. Returns `None` if the file doesn't exist or
/// can't be parsed (e.g. after a breaking schema change).
fn load_persisted_actions() -> Option<Vec<Action>> {
    let json = std::fs::read_to_string(settings_path()).ok()?;
    serde_json::from_str(&json).ok()
}

// ---------------------------------------------------------------------------
// Scheduler thread
// ---------------------------------------------------------------------------

fn scheduler_loop(state: SharedState) {
    let tick = Duration::from_millis(2);
    loop {
        std::thread::sleep(tick);

        // Collect work without holding the lock during execution.
        let tasks: Vec<(String, ActionType)> = {
            let mut guard = state.lock().unwrap();
            let now = Instant::now();

            let snapshot: Vec<(String, bool, ActionType, u64)> = guard
                .actions
                .iter()
                .map(|a| (a.id.clone(), a.enabled, a.action_type.clone(), a.interval_ms))
                .collect();

            let mut work = Vec::new();
            for (id, enabled, action_type, interval_ms) in snapshot {
                if !enabled {
                    continue;
                }
                let rt = guard
                    .runtime
                    .entry(id.clone())
                    .or_insert_with(ActionRuntimeState::default);
                if !rt.active {
                    continue;
                }
                // Skip if a sequence is still executing.
                if rt.executing {
                    continue;
                }
                let elapsed = rt
                    .last_execution
                    .map(|t| now.duration_since(t).as_millis() as u64)
                    .unwrap_or(u64::MAX);
                if elapsed >= interval_ms {
                    // For sequences: mark executing now; last_execution is set by
                    // the background thread when the sequence FINISHES, so that
                    // interval_ms truly means "pause between runs" not "between starts".
                    if matches!(action_type, ActionType::Sequence { .. }) {
                        rt.executing = true;
                    } else {
                        rt.last_execution = Some(now);
                    }
                    work.push((id, action_type));
                }
            }
            work
        };

        for (id, action_type) in tasks {
            match action_type {
                ActionType::Sequence { steps } => {
                    let state_clone = Arc::clone(&state);
                    std::thread::spawn(move || {
                        execute_sequence(&steps);
                        // Mark done and record completion time so interval_ms
                        // is measured from sequence end, not sequence start.
                        let mut guard = state_clone.lock().unwrap();
                        if let Some(rt) = guard.runtime.get_mut(&id) {
                            rt.executing = false;
                            rt.last_execution = Some(Instant::now());
                        }
                    });
                }
                _ => {
                    if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
                        execute_action(&mut enigo, &action_type);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Hotkey helpers
// ---------------------------------------------------------------------------

fn register_hotkeys(app: &AppHandle, state: &SharedState) {
    let actions: Vec<(String, String, TriggerMode)> = {
        let guard = state.lock().unwrap();
        guard
            .actions
            .iter()
            .filter_map(|a| {
                a.hotkey
                    .as_ref()
                    .filter(|hk| !hk.is_empty())
                    .map(|hk| (a.id.clone(), hk.clone(), a.trigger_mode.clone()))
            })
            .collect()
    };

    let manager = app.global_shortcut();

    for (id, hotkey_str, mode) in actions {
        if let Ok(shortcut) = hotkey_str.parse::<Shortcut>() {
            let state_clone = Arc::clone(state);
            let id_clone = id.clone();
            let _ = manager.on_shortcut(shortcut, move |_app, _shortcut, event| {
                let mut guard = state_clone.lock().unwrap();
                let rt = guard
                    .runtime
                    .entry(id_clone.clone())
                    .or_insert_with(ActionRuntimeState::default);
                match mode {
                    TriggerMode::Toggle => {
                        if event.state == ShortcutState::Pressed {
                            rt.active = !rt.active;
                            if rt.active {
                                rt.last_execution = None;
                            }
                        }
                    }
                    TriggerMode::Hold => match event.state {
                        ShortcutState::Pressed => {
                            rt.active = true;
                            rt.last_execution = None;
                        }
                        ShortcutState::Released => {
                            rt.active = false;
                        }
                    },
                }
            });
        }
    }
}

fn unregister_all_hotkeys(app: &AppHandle, state: &SharedState) {
    let hotkeys: Vec<String> = {
        let guard = state.lock().unwrap();
        guard
            .actions
            .iter()
            .filter_map(|a| a.hotkey.clone())
            .filter(|hk| !hk.is_empty())
            .collect()
    };
    let manager = app.global_shortcut();
    for hk in hotkeys {
        if let Ok(shortcut) = hk.parse::<Shortcut>() {
            let _ = manager.unregister(shortcut);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_actions(state: tauri::State<SharedState>) -> Vec<Action> {
    state.lock().unwrap().actions.clone()
}

#[tauri::command]
fn update_action(
    app: AppHandle,
    state: tauri::State<SharedState>,
    action: Action,
) -> Result<(), String> {
    let arc = Arc::clone(&*state);

    let old_hotkeys: Vec<String> = {
        let guard = state.lock().unwrap();
        guard
            .actions
            .iter()
            .filter_map(|a| a.hotkey.clone())
            .filter(|hk| !hk.is_empty())
            .collect()
    };

    {
        let mut guard = state.lock().unwrap();
        if let Some(existing) = guard.actions.iter_mut().find(|a| a.id == action.id) {
            *existing = action.clone();
        } else {
            return Err(format!("Action '{}' not found", action.id));
        }
        guard
            .runtime
            .entry(action.id.clone())
            .or_insert_with(ActionRuntimeState::default);
    }

    let manager = app.global_shortcut();
    for hk in old_hotkeys {
        if let Ok(shortcut) = hk.parse::<Shortcut>() {
            let _ = manager.unregister(shortcut);
        }
    }

    register_hotkeys(&app, &arc);

    // Persist after hotkeys are re-registered (state is fully settled).
    let snapshot = state.lock().unwrap().actions.clone();
    persist_actions(&snapshot);

    Ok(())
}

#[tauri::command]
fn set_action_active(
    state: tauri::State<SharedState>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    let rt = guard
        .runtime
        .entry(id)
        .or_insert_with(ActionRuntimeState::default);
    rt.active = active;
    if active {
        rt.last_execution = None;
    }
    Ok(())
}

#[tauri::command]
fn get_action_active(state: tauri::State<SharedState>, id: String) -> bool {
    let guard = state.lock().unwrap();
    guard
        .runtime
        .get(&id)
        .map(|rt| rt.active)
        .unwrap_or(false)
}

#[tauri::command]
fn add_action(state: tauri::State<SharedState>) -> Action {
    let mut guard = state.lock().unwrap();
    let id = format!(
        "custom_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let action = Action {
        id: id.clone(),
        name: "New Action".into(),
        hotkey: None,
        trigger_mode: TriggerMode::Toggle,
        action_type: ActionType::KeyPress { key: "a".into() },
        interval_ms: 100,
        enabled: true,
    };
    guard.runtime.insert(id, ActionRuntimeState::default());
    guard.actions.push(action.clone());
    let snapshot = guard.actions.clone();
    drop(guard); // release lock before I/O
    persist_actions(&snapshot);
    action
}

#[tauri::command]
fn remove_action(
    app: AppHandle,
    state: tauri::State<SharedState>,
    id: String,
) -> Result<(), String> {
    if id == "lmb" || id == "rmb" {
        return Err("Cannot remove built-in actions".into());
    }
    let arc = Arc::clone(&*state);

    let old_hotkeys: Vec<String> = {
        let guard = state.lock().unwrap();
        guard
            .actions
            .iter()
            .filter_map(|a| a.hotkey.clone())
            .filter(|hk| !hk.is_empty())
            .collect()
    };

    {
        let mut guard = state.lock().unwrap();
        guard.actions.retain(|a| a.id != id);
        guard.runtime.remove(&id);
    }

    let manager = app.global_shortcut();
    for hk in old_hotkeys {
        if let Ok(shortcut) = hk.parse::<Shortcut>() {
            let _ = manager.unregister(shortcut);
        }
    }
    register_hotkeys(&app, &arc);

    let snapshot = state.lock().unwrap().actions.clone();
    persist_actions(&snapshot);

    Ok(())
}

// ---------------------------------------------------------------------------
// Position capture command
// ---------------------------------------------------------------------------

#[tauri::command]
async fn capture_cursor_position(app: AppHandle) -> Result<(i32, i32), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.minimize().map_err(|e| e.to_string())?;
    }

    let pos = tauri::async_runtime::spawn_blocking(move || -> Result<(i32, i32), String> {
        std::thread::sleep(Duration::from_millis(400));

        #[cfg(target_os = "windows")]
        {
            win_api::wait_for_left_click(20_000)
                .ok_or_else(|| "Capture timed out".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err("Position capture is only supported on Windows".into())
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }

    Ok(pos)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Restore saved settings, or fall back to built-in defaults.
    let initial_state = match load_persisted_actions() {
        Some(actions) => {
            let mut runtime = HashMap::new();
            for a in &actions {
                runtime.insert(a.id.clone(), ActionRuntimeState::default());
            }
            AppState { actions, runtime }
        }
        None => AppState::default(),
    };
    let shared_state: SharedState = Arc::new(Mutex::new(initial_state));

    let scheduler_state = Arc::clone(&shared_state);
    std::thread::spawn(move || scheduler_loop(scheduler_state));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shared_state)
        .invoke_handler(tauri::generate_handler![
            get_actions,
            update_action,
            set_action_active,
            get_action_active,
            capture_cursor_position,
            add_action,
            remove_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
