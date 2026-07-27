use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// ---------------------------------------------------------------------------
// Windows API — used for cursor position capture and panic-key polling
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

    /// Block until a left-click occurs, returning its screen position.
    /// Returns `None` on timeout or if `cancel` is set to `true`.
    pub fn wait_for_left_click(
        timeout_ms: u64,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Option<(i32, i32)> {
        use std::sync::atomic::Ordering;
        let start = std::time::Instant::now();

        // If a button is already held when we start, wait for it to be released
        // so we don't immediately capture a leftover press.
        unsafe {
            while (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 {
                if cancel.load(Ordering::SeqCst) {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        loop {
            if cancel.load(Ordering::SeqCst) {
                return None;
            }
            if start.elapsed().as_millis() as u64 > timeout_ms {
                return None;
            }
            unsafe {
                if (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 {
                    let mut pt = POINT { x: 0, y: 0 };
                    GetCursorPos(&mut pt);
                    while (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) != 0 {
                        if cancel.load(Ordering::SeqCst) {
                            return Some((pt.x, pt.y));
                        }
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
    /// Physical key (`KeyboardEvent.code`, e.g. "ShiftRight") that stops every
    /// running action. Polled directly via the OS so it can never be "claimed"
    /// by another app and works even for lone modifier keys.
    panic_hotkey: Option<String>,
    /// Per-action hotkey registration problems, surfaced in the UI.
    /// Keyed by action id → human-readable message.
    hotkey_errors: HashMap<String, String>,
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
            panic_hotkey: Some(DEFAULT_PANIC_HOTKEY.into()),
            hotkey_errors: HashMap::new(),
        }
    }
}

pub type SharedState = Arc<Mutex<AppState>>;

/// Default panic key: Right Shift (rarely used in games/macros).
const DEFAULT_PANIC_HOTKEY: &str = "ShiftRight";

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

/// Map a `KeyboardEvent.code` value (physical key) to a Windows virtual-key
/// code, for the panic-key polling watcher. Returns `None` for keys we can't
/// map. Supports lone modifiers (e.g. Right Shift) which global shortcuts can't.
#[cfg(target_os = "windows")]
fn code_to_vk(code: &str) -> Option<i32> {
    Some(match code {
        "ShiftRight" => 0xA1,
        "ShiftLeft" => 0xA0,
        "ControlLeft" => 0xA2,
        "ControlRight" => 0xA3,
        "AltLeft" => 0xA4,
        "AltRight" => 0xA5,
        "MetaLeft" => 0x5B,
        "MetaRight" => 0x5C,
        "Escape" => 0x1B,
        "Space" => 0x20,
        "Enter" | "NumpadEnter" => 0x0D,
        "Tab" => 0x09,
        "Backspace" => 0x08,
        "Delete" => 0x2E,
        "Insert" => 0x2D,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "ArrowUp" => 0x26,
        "ArrowDown" => 0x28,
        "ArrowLeft" => 0x25,
        "ArrowRight" => 0x27,
        "CapsLock" => 0x14,
        _ => {
            if let Some(rest) = code.strip_prefix("Key") {
                let c = rest.chars().next()?;
                if c.is_ascii_alphabetic() {
                    return Some(c.to_ascii_uppercase() as i32);
                }
                return None;
            }
            if let Some(rest) = code.strip_prefix("Digit") {
                let c = rest.chars().next()?;
                if c.is_ascii_digit() {
                    return Some(c as i32);
                }
                return None;
            }
            if let Some(rest) = code.strip_prefix('F') {
                if let Ok(n) = rest.parse::<i32>() {
                    if (1..=24).contains(&n) {
                        return Some(0x70 + (n - 1));
                    }
                }
                return None;
            }
            return None;
        }
    })
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

/// Run every step in order, sleeping `delay_ms` after each one. Bails early if
/// the action is deactivated mid-run (panic key pressed or toggled off), so a
/// long sequence can be stopped. Reuses a single Enigo across all steps.
fn execute_sequence(state: &SharedState, id: &str, steps: &[SequenceStep]) {
    let mut enigo = Enigo::new(&Settings::default()).ok();
    for step in steps {
        // Stop immediately if the action is no longer active.
        {
            let guard = state.lock().unwrap();
            match guard.runtime.get(id) {
                Some(rt) if rt.active => {}
                _ => return,
            }
        }
        if let Some(e) = enigo.as_mut() {
            execute_step_action(e, &step.action);
        }
        if step.delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(step.delay_ms));
        }
    }
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

/// On-disk settings shape. Wraps the action list so we can also persist the
/// panic hotkey without a bare top-level array.
#[derive(Serialize, Deserialize)]
struct PersistedSettings {
    actions: Vec<Action>,
    #[serde(default)]
    panic_hotkey: Option<String>,
}

/// Returns the path to the settings JSON file.
/// On Windows: %APPDATA%\BobsBetterAutoclicker\settings.json
fn settings_path() -> std::path::PathBuf {
    let dir = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(dir)
        .join("BobsBetterAutoclicker")
        .join("settings.json")
}

/// Serialize settings to disk. Errors are silently ignored — the app keeps
/// working; settings just won't survive the next restart.
fn persist_settings(actions: &[Action], panic_hotkey: &Option<String>) {
    let data = PersistedSettings {
        actions: actions.to_vec(),
        panic_hotkey: panic_hotkey.clone(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&data) {
        let path = settings_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, json);
    }
}

/// Try to load saved settings. Returns `None` if the file doesn't exist or
/// can't be parsed. Handles the legacy format (a bare `[Action, ...]` array),
/// migrating it to the current shape with the default panic hotkey.
fn load_persisted_settings() -> Option<(Vec<Action>, Option<String>)> {
    let json = std::fs::read_to_string(settings_path()).ok()?;
    // Current format: { "actions": [...], "panic_hotkey": "..." }
    if let Ok(s) = serde_json::from_str::<PersistedSettings>(&json) {
        return Some((s.actions, s.panic_hotkey));
    }
    // Legacy format: bare array of actions (pre panic-hotkey).
    if let Ok(actions) = serde_json::from_str::<Vec<Action>>(&json) {
        return Some((actions, Some(DEFAULT_PANIC_HOTKEY.into())));
    }
    None
}

// ---------------------------------------------------------------------------
// Scheduler thread
// ---------------------------------------------------------------------------

fn scheduler_loop(state: SharedState) {
    let tick = Duration::from_millis(2);
    // Reuse a single Enigo instance across ticks instead of constructing one
    // for every click — far cheaper at high CPS.
    let mut enigo = Enigo::new(&Settings::default()).ok();
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
                        execute_sequence(&state_clone, &id, &steps);
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
                    if enigo.is_none() {
                        enigo = Enigo::new(&Settings::default()).ok();
                    }
                    if let Some(e) = enigo.as_mut() {
                        execute_action(e, &action_type);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Panic-key watcher thread
// ---------------------------------------------------------------------------

/// Polls the configured panic key via the OS and, on a fresh press, stops
/// every running action. Runs independently of the global-shortcut plugin so
/// it works for lone modifier keys and can't be claimed by another app.
#[cfg(target_os = "windows")]
fn panic_watcher_loop(state: SharedState) {
    let mut was_down = false;
    loop {
        std::thread::sleep(Duration::from_millis(15));

        let vk = {
            let guard = state.lock().unwrap();
            guard.panic_hotkey.as_deref().and_then(code_to_vk)
        };

        match vk {
            Some(vk) => {
                let down = unsafe { (win_api::GetAsyncKeyState(vk) as u16 & 0x8000) != 0 };
                // Trigger only on the rising edge (fresh press).
                if down && !was_down {
                    let mut guard = state.lock().unwrap();
                    for rt in guard.runtime.values_mut() {
                        rt.active = false;
                        rt.executing = false;
                    }
                }
                was_down = down;
            }
            None => was_down = false,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn panic_watcher_loop(_state: SharedState) {}

// ---------------------------------------------------------------------------
// Hotkey helpers
// ---------------------------------------------------------------------------

/// Register every action hotkey with the global-shortcut plugin, recording any
/// problems (parse failure, already claimed by another app, or duplicate within
/// this app) into `state.hotkey_errors` for the UI to surface.
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
    let mut errors: HashMap<String, String> = HashMap::new();
    // Normalized hotkey string → id of the action that claimed it first.
    let mut seen: HashMap<String, String> = HashMap::new();

    for (id, hotkey_str, mode) in actions {
        let key_norm = hotkey_str.to_lowercase();

        if seen.contains_key(&key_norm) {
            errors.insert(
                id.clone(),
                "Duplicate — this hotkey is already used by another action".into(),
            );
            continue;
        }

        match hotkey_str.parse::<Shortcut>() {
            Ok(shortcut) => {
                let state_clone = Arc::clone(state);
                let id_clone = id.clone();
                let result = manager.on_shortcut(shortcut, move |_app, _shortcut, event| {
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
                match result {
                    Ok(_) => {
                        seen.insert(key_norm, id.clone());
                    }
                    Err(_) => {
                        errors.insert(id.clone(), "This hotkey is claimed by another app".into());
                    }
                }
            }
            Err(_) => {
                errors.insert(id.clone(), "Failed to parse hotkey".into());
            }
        }
    }

    state.lock().unwrap().hotkey_errors = errors;
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

/// Combined status poll: per-action active flags + hotkey registration errors.
#[derive(Serialize)]
struct StatusReport {
    active: HashMap<String, bool>,
    hotkey_errors: HashMap<String, String>,
}

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

    // Unregister the currently-bound hotkeys BEFORE mutating, so a changed or
    // cleared hotkey doesn't leave its old binding stale.
    unregister_all_hotkeys(&app, &arc);

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

    // Re-register from the updated state, recomputing registration errors.
    register_hotkeys(&app, &arc);

    // Persist after hotkeys are re-registered (state is fully settled).
    let (snapshot, panic) = {
        let g = state.lock().unwrap();
        (g.actions.clone(), g.panic_hotkey.clone())
    };
    persist_settings(&snapshot, &panic);

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
fn get_status(state: tauri::State<SharedState>) -> StatusReport {
    let guard = state.lock().unwrap();
    let active = guard
        .runtime
        .iter()
        .map(|(k, v)| (k.clone(), v.active))
        .collect();
    StatusReport {
        active,
        hotkey_errors: guard.hotkey_errors.clone(),
    }
}

#[tauri::command]
fn get_panic_hotkey(state: tauri::State<SharedState>) -> Option<String> {
    state.lock().unwrap().panic_hotkey.clone()
}

#[tauri::command]
fn set_panic_hotkey(
    state: tauri::State<SharedState>,
    hotkey: Option<String>,
) -> Result<(), String> {
    let (snapshot, panic) = {
        let mut guard = state.lock().unwrap();
        guard.panic_hotkey = hotkey.filter(|h| !h.is_empty());
        (guard.actions.clone(), guard.panic_hotkey.clone())
    };
    persist_settings(&snapshot, &panic);
    Ok(())
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
    let panic = guard.panic_hotkey.clone();
    drop(guard); // release lock before I/O
    persist_settings(&snapshot, &panic);
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

    // Unregister current hotkeys (including the removed action's) before mutating.
    unregister_all_hotkeys(&app, &arc);

    {
        let mut guard = state.lock().unwrap();
        guard.actions.retain(|a| a.id != id);
        guard.runtime.remove(&id);
    }

    register_hotkeys(&app, &arc);

    let (snapshot, panic) = {
        let g = state.lock().unwrap();
        (g.actions.clone(), g.panic_hotkey.clone())
    };
    persist_settings(&snapshot, &panic);

    Ok(())
}

// ---------------------------------------------------------------------------
// Position capture command
// ---------------------------------------------------------------------------

#[tauri::command]
async fn capture_cursor_position(
    app: AppHandle,
    cancel: tauri::State<'_, Arc<AtomicBool>>,
) -> Result<(i32, i32), String> {
    let cancel_flag = Arc::clone(&cancel);
    cancel_flag.store(false, Ordering::SeqCst);

    if let Some(win) = app.get_webview_window("main") {
        win.minimize().map_err(|e| e.to_string())?;
    }

    let capture_flag = Arc::clone(&cancel_flag);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(i32, i32), String> {
        std::thread::sleep(Duration::from_millis(400));

        #[cfg(target_os = "windows")]
        {
            win_api::wait_for_left_click(20_000, &capture_flag)
                .ok_or_else(|| "Capture cancelled or timed out".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = &capture_flag;
            Err("Position capture is only supported on Windows".into())
        }
    })
    .await
    .map_err(|e| e.to_string());

    // Always restore the window, whether capture succeeded, timed out, or was
    // cancelled — otherwise the app is left minimized.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }

    result?
}

/// Abort an in-flight `capture_cursor_position` call.
#[tauri::command]
fn cancel_position_capture(cancel: tauri::State<Arc<AtomicBool>>) {
    cancel.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Restore saved settings, or fall back to built-in defaults.
    let initial_state = match load_persisted_settings() {
        Some((actions, panic_hotkey)) => {
            let mut runtime = HashMap::new();
            for a in &actions {
                runtime.insert(a.id.clone(), ActionRuntimeState::default());
            }
            AppState {
                actions,
                runtime,
                panic_hotkey,
                hotkey_errors: HashMap::new(),
            }
        }
        None => AppState::default(),
    };
    let shared_state: SharedState = Arc::new(Mutex::new(initial_state));
    let capture_cancel: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));

    let scheduler_state = Arc::clone(&shared_state);
    std::thread::spawn(move || scheduler_loop(scheduler_state));

    let watcher_state = Arc::clone(&shared_state);
    std::thread::spawn(move || panic_watcher_loop(watcher_state));

    let setup_state = Arc::clone(&shared_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shared_state)
        .manage(capture_cancel)
        .setup(move |app| {
            // Register saved hotkeys immediately so they work on launch —
            // previously they only became active after being rebound once.
            let handle = app.handle().clone();
            register_hotkeys(&handle, &setup_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_actions,
            update_action,
            set_action_active,
            get_status,
            get_panic_hotkey,
            set_panic_hotkey,
            capture_cursor_position,
            cancel_position_capture,
            add_action,
            remove_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
