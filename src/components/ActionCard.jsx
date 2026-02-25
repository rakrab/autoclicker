import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { toIntervalMs, fromIntervalMs } from "../utils/interval";

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  surface:     "#0f0f1c",
  surface2:    "#161628",
  surfaceStep: "#13132200",
  border:      "rgba(255,255,255,0.07)",
  borderFocus: "rgba(124,58,237,0.55)",
  accent:      "#7c3aed",
  accentMid:   "#8b5cf6",
  accentLight: "#a78bfa",
  text:        "#ededfa",
  text2:       "rgba(237,237,250,0.45)",
  text3:       "rgba(237,237,250,0.22)",
  mono:        "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  sans:        "'Outfit', system-ui, sans-serif",
};

// ─── Key formatting helpers ───────────────────────────────────────────────────
const KEY_LABELS = {
  ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt",
  meta: "Win", win: "Win", super: "Win", cmd: "Cmd",
  return: "Enter", enter: "Enter", backspace: "⌫", delete: "Del",
  tab: "Tab", escape: "Esc", esc: "Esc", space: "Space",
  up: "↑", down: "↓", left: "←", right: "→",
  home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
  insert: "Ins", capslock: "Caps",
};

function formatKey(key) {
  const lo = key.toLowerCase();
  return KEY_LABELS[lo] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
}

function formatKeyCombo(keys) {
  return keys.map(formatKey).join(" + ");
}

// ─── Shared key/combo normalisation ──────────────────────────────────────────
function normalizeKeyEvent(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  if (e.key === "Escape") return null;
  const parts = [];
  if (e.ctrlKey)  parts.push("ctrl");
  if (e.altKey)   parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const MAP = {
    " ": "Space", Enter: "Return",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  };
  const k = MAP[e.key] ?? (/^F\d+$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(k);
  return parts.join("+");
}

function normalizeKeyEventForExec(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  if (e.key === "Escape") return null;
  const parts = [];
  if (e.ctrlKey)  parts.push("ctrl");
  if (e.altKey)   parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey)  parts.push("meta");
  const MAP = {
    " ": "space", Enter: "return",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Backspace: "backspace", Delete: "delete", Tab: "tab",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
    Insert: "insert", CapsLock: "capslock",
  };
  const k = MAP[e.key] ?? (/^F\d+$/.test(e.key) ? e.key.toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  parts.push(k);
  return parts;
}

function normalizeSingleKey(e) {
  const MODIFIER_MAP = { Control: "ctrl", Shift: "shift", Alt: "alt", Meta: "meta" };
  if (MODIFIER_MAP[e.key]) return MODIFIER_MAP[e.key];
  const MAP = {
    " ": "space", Enter: "return",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Backspace: "backspace", Delete: "delete", Tab: "tab",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
    Insert: "insert", CapsLock: "capslock",
  };
  return MAP[e.key] ?? (/^F\d+$/.test(e.key) ? e.key.toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
}

// ─── Position capture countdown helper ───────────────────────────────────────
// Returns a thunk that does the capture with a 3-2-1 countdown.
// `setCountdown` receives null | 3 | 2 | 1 during the countdown.
// `setCapturing` is set true while the Tauri call is in flight.
async function runCaptureWithCountdown(setCountdown, setCapturing, onSuccess) {
  setCountdown(3);
  await new Promise(r => setTimeout(r, 1000));
  setCountdown(2);
  await new Promise(r => setTimeout(r, 1000));
  setCountdown(1);
  await new Promise(r => setTimeout(r, 1000));
  setCountdown(null);
  setCapturing(true);
  try {
    const [x, y] = await invoke("capture_cursor_position");
    onSuccess(x, y);
  } catch (err) {
    console.error("capture_cursor_position:", err);
  } finally {
    setCapturing(false);
  }
}

// ─── Reusable primitives ──────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <p style={{
      fontSize: 11, fontWeight: 600, letterSpacing: "0.1em",
      textTransform: "uppercase", color: T.text3,
      marginBottom: 12, fontFamily: T.sans,
    }}>
      {children}
    </p>
  );
}

function Segments({ options, value, onChange, mono = false, small = false }) {
  return (
    <div style={{
      display: "inline-flex",
      background: "rgba(255,255,255,0.05)",
      border: `1px solid ${T.border}`,
      borderRadius: small ? 8 : 10,
      padding: small ? 2 : 3,
      gap: small ? 2 : 3,
    }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={(e) => { e.stopPropagation(); onChange(opt.value); }}
            style={{
              height: small ? 30 : 38,
              padding: small ? "0 12px" : "0 18px",
              borderRadius: small ? 6 : 8,
              fontSize: small ? 12 : 13,
              fontWeight: active ? 600 : 500,
              fontFamily: mono ? T.mono : T.sans,
              letterSpacing: mono ? "0.03em" : "0",
              background: active ? T.accent : "transparent",
              color: active ? "#fff" : T.text2,
              border: "none", cursor: "pointer",
              transition: "background 0.15s, color 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function TextInput({ value, onChange, style, ...rest }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      value={value} onChange={onChange}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={(e) => e.stopPropagation()}
      style={{
        height: 44, background: "rgba(255,255,255,0.05)",
        border: `1px solid ${focused ? T.borderFocus : T.border}`,
        borderRadius: 9, padding: "0 14px",
        fontSize: 16, fontFamily: T.mono, fontWeight: 500, color: T.text,
        transition: "border-color 0.15s", ...style,
      }}
      {...rest}
    />
  );
}

function HkButton({ children, onClick, variant = "accent", square = false, small = false }) {
  const [hovered, setHovered] = useState(false);
  const styles = {
    accent: {
      base:    { bg: "rgba(124,58,237,0.18)", border: "rgba(124,58,237,0.32)", color: T.accentLight },
      hovered: { bg: "rgba(124,58,237,0.30)", border: "rgba(124,58,237,0.52)", color: "#fff" },
    },
    warn: {
      base:    { bg: "rgba(250,204,21,0.12)", border: "rgba(250,204,21,0.28)", color: "rgba(250,204,21,0.85)" },
      hovered: { bg: "rgba(250,204,21,0.20)", border: "rgba(250,204,21,0.48)", color: "rgba(250,204,21,1)" },
    },
    danger: {
      base:    { bg: "rgba(255,255,255,0.05)", border: T.border,               color: T.text3 },
      hovered: { bg: "rgba(239,68,68,0.15)",   border: "rgba(239,68,68,0.32)", color: "rgba(248,113,113,0.9)" },
    },
  };
  const { bg, border, color } = hovered ? styles[variant].hovered : styles[variant].base;
  const h = small ? 34 : 44;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: h, width: square ? h : undefined,
        padding: square ? 0 : small ? "0 12px" : "0 16px",
        borderRadius: square ? Math.round(h / 2.5) : 9,
        background: bg, border: `1px solid ${border}`, color,
        cursor: "pointer", fontSize: small ? 12 : 13, fontWeight: 500,
        fontFamily: T.sans, display: "flex", alignItems: "center",
        justifyContent: "center",
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
        whiteSpace: "nowrap", flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// ─── CaptureBox ───────────────────────────────────────────────────────────────
function CaptureBox({ capturing, liveDisplay, committed, placeholder, warningText, small = false }) {
  return (
    <div style={{
      flex: 1, height: small ? 34 : 44,
      background: "rgba(255,255,255,0.05)",
      border: `1px solid ${
        capturing
          ? liveDisplay ? "rgba(124,58,237,0.5)" : "rgba(250,204,21,0.45)"
          : T.border
      }`,
      borderRadius: 9, padding: "0 14px",
      display: "flex", alignItems: "center",
      fontFamily: T.mono, fontSize: small ? 13 : 14,
      transition: "border-color 0.15s", letterSpacing: "0.04em",
      userSelect: "none",
    }}>
      {capturing
        ? liveDisplay
          ? <span style={{ color: T.accentLight }}>{liveDisplay}</span>
          : <span style={{ color: "rgba(250,204,21,0.8)" }}>{warningText}</span>
        : committed
          ? <span style={{ color: T.accentLight }}>{committed}</span>
          : <span style={{ color: T.text3 }}>{placeholder}</span>
      }
    </div>
  );
}

// ─── Capture countdown banner ─────────────────────────────────────────────────
function CountdownBanner({ countdown }) {
  if (countdown === null) return null;
  return (
    <div style={{
      marginTop: 10,
      padding: "10px 14px",
      borderRadius: 9,
      background: "rgba(250,204,21,0.08)",
      border: "1px solid rgba(250,204,21,0.25)",
      display: "flex",
      alignItems: "center",
      gap: 10,
    }}>
      <span style={{
        fontSize: 20, fontWeight: 700,
        fontFamily: T.mono, color: "rgba(250,204,21,0.9)",
        lineHeight: 1, minWidth: 16, textAlign: "center",
      }}>
        {countdown}
      </span>
      <span style={{ fontSize: 12, color: "rgba(250,204,21,0.75)", lineHeight: 1.5 }}>
        Window will minimize — move your cursor to your target position, then click to set it.
      </span>
    </div>
  );
}

// ─── Action icon toggle ───────────────────────────────────────────────────────
function ActionIconToggle({ actionType, enabled, isActive, onClick }) {
  const [hovered, setHovered] = useState(false);
  const running  = enabled && isActive;
  const idle     = enabled && !isActive;

  let bg, borderColor, iconColor, iconFill, glow, opacity;
  if (running) {
    bg = "rgba(124,58,237,0.28)"; borderColor = "rgba(124,58,237,0.6)";
    iconColor = "#c4b5fd"; iconFill = "rgba(167,139,250,0.6)";
    glow = "glow-breathe 2s ease-in-out infinite"; opacity = 1;
  } else if (idle) {
    bg = hovered ? "rgba(124,58,237,0.18)" : "rgba(124,58,237,0.10)";
    borderColor = hovered ? "rgba(124,58,237,0.45)" : "rgba(124,58,237,0.28)";
    iconColor = hovered ? T.accentLight : "rgba(167,139,250,0.7)";
    iconFill = hovered ? "rgba(139,92,246,0.4)" : "rgba(139,92,246,0.22)";
    glow = "none"; opacity = 1;
  } else {
    bg = hovered ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.04)";
    borderColor = "rgba(255,255,255,0.09)";
    iconColor = "rgba(237,237,250,0.25)"; iconFill = "rgba(237,237,250,0.08)";
    glow = "none"; opacity = hovered ? 0.65 : 0.45;
  }

  const t = actionType?.type;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={enabled ? (running ? "Running — click to disable" : "Enabled — click to disable") : "Disabled — click to enable"}
      style={{
        flexShrink: 0, width: 52, height: 52, borderRadius: 14,
        background: bg, border: `1px solid ${borderColor}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer",
        transition: "background 0.2s, border-color 0.2s, opacity 0.2s",
        opacity, animation: running ? glow : "none",
      }}
    >
      {t === "mouse_click" ? (
        <svg width="22" height="26" viewBox="0 0 18 22" fill="none">
          <rect x="1.75" y="1.75" width="14.5" height="18.5" rx="7.25" stroke={iconColor} strokeWidth="1.6" />
          <line x1="9" y1="1.75" x2="9" y2="9.5" stroke={iconColor} strokeWidth="1.6" />
          {actionType.button === "left"  && <path d="M2 9.5V5a7 7 0 0 1 7-3.25V9.5H2Z" fill={iconFill} />}
          {actionType.button === "right" && <path d="M16 9.5V5A7 7 0 0 0 9 1.75V9.5h7Z" fill={iconFill} />}
          <circle cx="9" cy="15.5" r="1.4" fill={iconColor} />
        </svg>
      ) : t === "sequence" ? (
        // Sequence: ordered-list icon
        <svg width="22" height="20" viewBox="0 0 22 20" fill="none">
          <circle cx="3"  cy="4"  r="1.5" fill={iconColor} />
          <line x1="7" y1="4"  x2="20" y2="4"  stroke={iconColor} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="3"  cy="10" r="1.5" fill={iconColor} />
          <line x1="7" y1="10" x2="20" y2="10" stroke={iconColor} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="3"  cy="16" r="1.5" fill={iconColor} />
          <line x1="7" y1="16" x2="16" y2="16" stroke={iconColor} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ) : (
        // KeyPress / KeyCombo: keyboard icon
        <svg width="24" height="18" viewBox="0 0 24 18" fill="none">
          <rect x="1" y="1" width="22" height="16" rx="3.5" stroke={iconColor} strokeWidth="1.5" />
          <rect x="4"    y="4.5" width="3"   height="2.5" rx="0.8" fill={iconFill} />
          <rect x="8.5"  y="4.5" width="3"   height="2.5" rx="0.8" fill={iconFill} />
          <rect x="13"   y="4.5" width="3"   height="2.5" rx="0.8" fill={iconFill} />
          <rect x="17.5" y="4.5" width="2.5" height="2.5" rx="0.8" fill={iconFill} />
          <rect x="4"    y="9"   width="2.5" height="2.5" rx="0.8" fill={iconFill} />
          <rect x="8"    y="9"   width="8"   height="2.5" rx="0.8" fill={iconColor} opacity="0.6" />
          <rect x="17.5" y="9"   width="2.5" height="2.5" rx="0.8" fill={iconFill} />
          <rect x="5.5"  y="13.5" width="13" height="2"  rx="0.8" fill={iconFill} />
        </svg>
      )}
    </button>
  );
}

// ─── Active toggle ────────────────────────────────────────────────────────────
function ActiveToggle({ isActive, onClick, disabled }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      title={disabled ? "Hold mode — use the hotkey to activate" : isActive ? "Stop" : "Start"}
      style={{
        position: "relative", flexShrink: 0, width: 56, height: 32, borderRadius: 16,
        background: isActive ? T.accent : "rgba(255,255,255,0.08)",
        border: `1px solid ${isActive ? "rgba(124,58,237,0.6)" : "rgba(255,255,255,0.1)"}`,
        boxShadow: isActive ? "0 0 18px rgba(124,58,237,0.35)" : "none",
        transition: "background 0.2s, box-shadow 0.2s, border-color 0.2s",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.38 : 1,
      }}
    >
      <span style={{
        position: "absolute", top: 4, left: isActive ? 27 : 4,
        width: 22, height: 22, borderRadius: 11, background: "white",
        boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
        transition: "left 0.2s cubic-bezier(0.4,0,0.2,1)",
      }} />
    </button>
  );
}

function Dot() {
  return <span style={{ display: "inline-block", flexShrink: 0, width: 3, height: 3, borderRadius: "50%", background: "rgba(237,237,250,0.18)" }} />;
}

function KeyBadge({ children }) {
  return (
    <span style={{
      background: "rgba(124,58,237,0.18)", color: T.accentLight,
      padding: "2px 8px", borderRadius: 5,
      border: "1px solid rgba(124,58,237,0.28)",
      fontSize: 12, letterSpacing: "0.05em", fontFamily: T.mono,
    }}>
      {children}
    </span>
  );
}

// ─── Interval constants ───────────────────────────────────────────────────────
const UNIT_OPTIONS = [
  { value: "cps", label: "CPS" },
  { value: "ms",  label: "ms"  },
  { value: "s",   label: "s"   },
  { value: "min", label: "min" },
];
const UNIT_LABEL = { cps: "CPS", ms: "ms", s: "s", min: "min" };

// ─── SequenceStepRow ──────────────────────────────────────────────────────────
function SequenceStepRow({ step, index, totalSteps, onChange, onRemove, onMoveUp, onMoveDown }) {
  const [capturingKey,   setCapturingKey]   = useState(false);
  const [capturingCombo, setCapturingCombo] = useState(false);
  const [liveComboKeys,  setLiveComboKeys]  = useState(null);
  const [captureCountdown, setCaptureCountdown] = useState(null);
  const [capturingPos,   setCapturingPos]   = useState(false);

  const stepRef     = useRef(step);
  const onChangeRef = useRef(onChange);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const sa = step.action;

  const setStepAction = (newAction) =>
    onChangeRef.current({ ...stepRef.current, action: newAction });

  const changeStepType = (type) => {
    if (type === "mouse_click")
      setStepAction({ type: "mouse_click", button: "left", position: { type: "current_cursor" } });
    else if (type === "key_press")
      setStepAction({ type: "key_press", key: "a" });
    else
      setStepAction({ type: "key_combo", keys: ["ctrl", "c"] });
  };

  // Key-press capture for this step
  useEffect(() => {
    if (!capturingKey) return;
    const onKeyDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapturingKey(false); return; }
      const key = normalizeSingleKey(e);
      setCapturingKey(false);
      setStepAction({ type: "key_press", key });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingKey]);

  // Key-combo capture for this step
  useEffect(() => {
    if (!capturingCombo) return;
    let pendingKeys = null;
    const onKeyDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapturingCombo(false); setLiveComboKeys(null); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const keys = normalizeKeyEventForExec(e);
      if (keys) { pendingKeys = keys; setLiveComboKeys(keys); }
    };
    const onKeyUp = (e) => {
      if (!["Control", "Shift", "Alt", "Meta"].includes(e.key) && pendingKeys) {
        const keys = pendingKeys;
        pendingKeys = null;
        setCapturingCombo(false);
        setLiveComboKeys(null);
        setStepAction({ type: "key_combo", keys });
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup",   onKeyUp,   { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup",   onKeyUp,   { capture: true });
      setLiveComboKeys(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingCombo]);

  const handleCapturePos = (e) => {
    e.stopPropagation();
    if (capturingPos || captureCountdown !== null) return;
    runCaptureWithCountdown(setCaptureCountdown, setCapturingPos, (x, y) => {
      onChangeRef.current({
        ...stepRef.current,
        action: { ...stepRef.current.action, position: { type: "fixed", x, y } },
      });
    });
  };

  const isFixed = sa.type === "mouse_click" && sa.position?.type === "fixed";

  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 12,
      padding: "14px 14px 14px",
    }}>
      {/* Step header */}
      <div style={{
        display: "flex", alignItems: "center",
        justifyContent: "space-between", marginBottom: 12,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
          textTransform: "uppercase", color: T.text3, fontFamily: T.mono,
        }}>
          Step {index + 1}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {/* Up */}
          <StepCtrlBtn onClick={(e) => { e.stopPropagation(); onMoveUp(); }} disabled={index === 0} title="Move up">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 7l3-4 3 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </StepCtrlBtn>
          {/* Down */}
          <StepCtrlBtn onClick={(e) => { e.stopPropagation(); onMoveDown(); }} disabled={index === totalSteps - 1} title="Move down">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </StepCtrlBtn>
          {/* Remove */}
          <StepCtrlBtn onClick={(e) => { e.stopPropagation(); onRemove(); }} danger title="Remove step">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </StepCtrlBtn>
        </div>
      </div>

      {/* Action type */}
      <Segments
        small
        options={[
          { value: "mouse_click", label: "Mouse Click" },
          { value: "key_press",   label: "Key Press"   },
          { value: "key_combo",   label: "Key Combo"   },
        ]}
        value={sa.type}
        onChange={changeStepType}
      />

      {/* MouseClick config */}
      {sa.type === "mouse_click" && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Segments small
              options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]}
              value={sa.button}
              onChange={(btn) => setStepAction({ ...sa, button: btn })}
            />
            <Segments small
              options={[
                { value: "current_cursor", label: "Current Cursor" },
                { value: "fixed",          label: "Fixed"          },
              ]}
              value={sa.position?.type ?? "current_cursor"}
              onChange={(type) => {
                const pos = type === "current_cursor"
                  ? { type: "current_cursor" }
                  : { type: "fixed", x: sa.position?.x ?? 0, y: sa.position?.y ?? 0 };
                setStepAction({ ...sa, position: pos });
              }}
            />
          </div>
          {isFixed && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {[["x", "X"], ["y", "Y"]].map(([axis, label]) => (
                <div key={axis} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: T.text3, fontFamily: T.mono }}>
                    {label}
                  </span>
                  <input
                    type="number"
                    value={sa.position[axis] ?? 0}
                    onChange={(e) => setStepAction({ ...sa, position: { ...sa.position, [axis]: parseInt(e.target.value) || 0 } })}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: 72, height: 30, background: "rgba(255,255,255,0.05)",
                      border: `1px solid ${T.border}`, borderRadius: 7,
                      padding: "0 10px", fontSize: 13, fontFamily: T.mono,
                      color: T.text, fontWeight: 500,
                    }}
                  />
                </div>
              ))}
              <HkButton small onClick={handleCapturePos} variant={capturingPos ? "warn" : "accent"}>
                {capturingPos ? "Capturing…" : "Capture"}
              </HkButton>
            </div>
          )}
          <CountdownBanner countdown={captureCountdown} />
          {capturingPos && (
            <p style={{ fontSize: 11, color: "rgba(250,204,21,0.65)", lineHeight: 1.6 }}>
              Click anywhere on screen to set the position. (20s timeout)
            </p>
          )}
        </div>
      )}

      {/* KeyPress config */}
      {sa.type === "key_press" && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <CaptureBox
            small capturing={capturingKey}
            liveDisplay={null}
            committed={sa.key ? formatKey(sa.key) : null}
            placeholder="None"
            warningText="Press any key…"
          />
          <HkButton small onClick={(e) => { e.stopPropagation(); setCapturingKey(true); }} variant={capturingKey ? "warn" : "accent"}>
            {capturingKey ? "Cancel" : "Set Key"}
          </HkButton>
        </div>
      )}

      {/* KeyCombo config */}
      {sa.type === "key_combo" && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <CaptureBox
            small capturing={capturingCombo}
            liveDisplay={liveComboKeys ? formatKeyCombo(liveComboKeys) : null}
            committed={sa.keys?.length ? formatKeyCombo(sa.keys) : null}
            placeholder="None"
            warningText="Hold modifiers, press key…"
          />
          <HkButton small onClick={(e) => { e.stopPropagation(); if (capturingCombo) { setCapturingCombo(false); setLiveComboKeys(null); } else { setCapturingCombo(true); } }} variant={capturingCombo ? "warn" : "accent"}>
            {capturingCombo ? "Cancel" : "Record"}
          </HkButton>
        </div>
      )}

      {/* Delay */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
        <span style={{ fontSize: 12, color: T.text3, fontFamily: T.sans, flexShrink: 0 }}>
          Delay after
        </span>
        <input
          type="number" min="0"
          value={step.delay_ms}
          onChange={(e) => onChangeRef.current({ ...stepRef.current, delay_ms: parseInt(e.target.value) || 0 })}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 70, height: 30, background: "rgba(255,255,255,0.05)",
            border: `1px solid ${T.border}`, borderRadius: 7,
            padding: "0 10px", fontSize: 13, fontFamily: T.mono,
            color: T.text, fontWeight: 500,
          }}
        />
        <span style={{ fontSize: 12, color: T.text3, fontFamily: T.mono }}>ms</span>
      </div>
    </div>
  );
}

// ─── Small icon button used in step rows ──────────────────────────────────────
function StepCtrlBtn({ children, onClick, disabled, danger, title }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={disabled}
      title={title}
      style={{
        width: 26, height: 26, borderRadius: 6, border: "1px solid transparent",
        background: hovered && !disabled
          ? danger ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.08)"
          : "transparent",
        borderColor: hovered && !disabled
          ? danger ? "rgba(239,68,68,0.32)" : "rgba(255,255,255,0.12)"
          : "transparent",
        color: hovered && !disabled
          ? danger ? "rgba(248,113,113,0.9)" : T.text2
          : disabled ? "rgba(237,237,250,0.12)" : T.text3,
        cursor: disabled ? "default" : "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.15s",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// ─── Main ActionCard component ────────────────────────────────────────────────
export default function ActionCard({ action: initialAction, isActive, onActiveChange, onRemove }) {
  const [action, setAction] = useState(initialAction);
  const [isOpen, setIsOpen] = useState(false);

  const [unit, setUnit] = useState("cps");
  const [displayValue, setDisplayValue] = useState(() =>
    fromIntervalMs(initialAction.interval_ms, "cps")
  );

  const [capturingPos,      setCapturingPos]      = useState(false);
  const [captureCountdown,  setCaptureCountdown]  = useState(null);
  const [capturing,         setCapturing]         = useState(false);
  const [liveCombo,         setLiveCombo]         = useState(null);
  const [capturingKey,      setCapturingKey]      = useState(false);
  const [capturingCombo,    setCapturingCombo]    = useState(false);
  const [liveComboKeys,     setLiveComboKeys]     = useState(null);

  const actionRef = useRef(action);
  useEffect(() => { actionRef.current = action; }, [action]);
  useEffect(() => { setAction(initialAction); }, [initialAction]);

  const isBuiltin = action.id === "lmb" || action.id === "rmb";
  const at = action.action_type;

  // ── Backend sync ────────────────────────────────────────────────────────────
  const pushUpdate = useCallback(async (updated) => {
    setAction(updated);
    try { await invoke("update_action", { action: updated }); }
    catch (err) { console.error("update_action:", err); }
  }, []);

  // ── Interval ────────────────────────────────────────────────────────────────
  const handleUnitChange = (newUnit) => {
    setDisplayValue(fromIntervalMs(toIntervalMs(displayValue, unit), newUnit));
    setUnit(newUnit);
  };
  const handleIntervalChange = (e) => {
    const raw = e.target.value;
    setDisplayValue(raw);
    pushUpdate({ ...action, interval_ms: toIntervalMs(raw, unit) });
  };

  // ── Mode ────────────────────────────────────────────────────────────────────
  const handleModeChange = (mode) => pushUpdate({ ...action, trigger_mode: mode });

  // ── Action type (custom only) ────────────────────────────────────────────────
  const handleActionTypeChange = (type) => {
    let newActionType;
    if      (type === "mouse_click") newActionType = { type: "mouse_click", button: "left", position: { type: "current_cursor" } };
    else if (type === "key_press")   newActionType = { type: "key_press", key: "a" };
    else if (type === "key_combo")   newActionType = { type: "key_combo", keys: ["ctrl", "c"] };
    else                             newActionType = { type: "sequence", steps: [] };
    pushUpdate({ ...action, action_type: newActionType });
  };

  // ── Mouse position ──────────────────────────────────────────────────────────
  const handlePositionType = (type) => {
    const pos = type === "current_cursor"
      ? { type: "current_cursor" }
      : { type: "fixed", x: at.position?.x ?? 0, y: at.position?.y ?? 0 };
    pushUpdate({ ...action, action_type: { ...at, position: pos } });
  };

  const handleFixedCoord = (axis, val) =>
    pushUpdate({ ...action, action_type: { ...at, position: { ...at.position, [axis]: parseInt(val) || 0 } } });

  // ── Position capture (with countdown) ────────────────────────────────────
  const handleCapturePosition = (e) => {
    e.stopPropagation();
    if (capturingPos || captureCountdown !== null) return;
    runCaptureWithCountdown(setCaptureCountdown, setCapturingPos, (x, y) => {
      pushUpdate({
        ...actionRef.current,
        action_type: { ...actionRef.current.action_type, position: { type: "fixed", x, y } },
      });
    });
  };

  // ── Hotkey capture ──────────────────────────────────────────────────────────
  const startCapture  = (e) => { e.stopPropagation(); setCapturing(true); setLiveCombo(null); };
  const cancelCapture = (e) => { e?.stopPropagation(); setCapturing(false); setLiveCombo(null); };

  useEffect(() => {
    if (!capturing) return;
    let pendingCombo = null;
    const onKeyDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { cancelCapture(); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      pendingCombo = normalizeKeyEvent(e);
      setLiveCombo(pendingCombo);
    };
    const onKeyUp = (e) => {
      if (!["Control", "Shift", "Alt", "Meta"].includes(e.key) && pendingCombo) {
        const combo = pendingCombo;
        pendingCombo = null;
        setCapturing(false);
        setLiveCombo(null);
        pushUpdate({ ...actionRef.current, hotkey: combo });
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup",   onKeyUp,   { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup",   onKeyUp,   { capture: true });
      setLiveCombo(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  // ── KeyPress single-key capture ─────────────────────────────────────────────
  useEffect(() => {
    if (!capturingKey) return;
    const onKeyDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapturingKey(false); return; }
      const key = normalizeSingleKey(e);
      setCapturingKey(false);
      pushUpdate({ ...actionRef.current, action_type: { type: "key_press", key } });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingKey]);

  // ── KeyCombo capture ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!capturingCombo) return;
    let pendingKeys = null;
    const onKeyDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapturingCombo(false); setLiveComboKeys(null); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const keys = normalizeKeyEventForExec(e);
      if (keys) { pendingKeys = keys; setLiveComboKeys(keys); }
    };
    const onKeyUp = (e) => {
      if (!["Control", "Shift", "Alt", "Meta"].includes(e.key) && pendingKeys) {
        const keys = pendingKeys;
        pendingKeys = null;
        setCapturingCombo(false);
        setLiveComboKeys(null);
        pushUpdate({ ...actionRef.current, action_type: { type: "key_combo", keys } });
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup",   onKeyUp,   { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup",   onKeyUp,   { capture: true });
      setLiveComboKeys(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingCombo]);

  // ── Active toggle ───────────────────────────────────────────────────────────
  const handleManualToggle = async () => {
    if (action.trigger_mode === "hold") return;
    const next = !isActive;
    onActiveChange(next);
    try { await invoke("set_action_active", { id: action.id, active: next }); }
    catch (err) { console.error(err); }
  };

  // ── Sequence step helpers ────────────────────────────────────────────────────
  const updateStep = (idx, updatedStep) => {
    const steps = [...at.steps];
    steps[idx] = updatedStep;
    pushUpdate({ ...action, action_type: { ...at, steps } });
  };
  const removeStep = (idx) => {
    const steps = at.steps.filter((_, i) => i !== idx);
    pushUpdate({ ...action, action_type: { ...at, steps } });
  };
  const moveStep = (idx, dir) => {
    const steps = [...at.steps];
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    [steps[idx], steps[target]] = [steps[target], steps[idx]];
    pushUpdate({ ...action, action_type: { ...at, steps } });
  };
  const addStep = (e) => {
    e.stopPropagation();
    const newStep = {
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      action: { type: "key_press", key: "a" },
      delay_ms: 50,
    };
    pushUpdate({ ...action, action_type: { ...at, steps: [...(at.steps ?? []), newStep] } });
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const isFixed     = at.type === "mouse_click" && at.position?.type === "fixed";
  const intervalStr = `${fromIntervalMs(action.interval_ms, unit)} ${UNIT_LABEL[unit]}`;
  const modeStr     = action.trigger_mode === "toggle" ? "Toggle" : "Hold";

  const summaryBadge = (() => {
    if (at.type === "key_press")  return formatKey(at.key);
    if (at.type === "key_combo")  return at.keys?.length ? formatKeyCombo(at.keys) : "—";
    if (at.type === "sequence") {
      const n = at.steps?.length ?? 0;
      return n === 0 ? "Empty" : `${n} step${n === 1 ? "" : "s"}`;
    }
    return null;
  })();

  return (
    <motion.div layout style={{
      background: T.surface,
      border: `1px solid ${isActive ? "rgba(124,58,237,0.42)" : T.border}`,
      borderRadius: 16, overflow: "hidden",
      boxShadow: isActive ? "0 0 32px rgba(124,58,237,0.10)" : "none",
      transition: "border-color 0.25s, box-shadow 0.25s",
      opacity: action.enabled ? 1 : 0.72,
    }}>
      {/* Running stripe */}
      <div style={{
        height: 2,
        background: isActive ? `linear-gradient(90deg, ${T.accent}, ${T.accentMid}, transparent)` : "transparent",
        transition: "background 0.3s", flexShrink: 0,
      }} />

      {/* ── Card header ── */}
      <div
        onClick={() => setIsOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", cursor: "pointer" }}
      >
        <ActionIconToggle
          actionType={at} enabled={action.enabled} isActive={isActive}
          onClick={() => pushUpdate({ ...action, enabled: !action.enabled })}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: "block", fontSize: 18, fontWeight: 600,
            color: action.enabled ? T.text : T.text2,
            letterSpacing: "-0.02em", lineHeight: 1, marginBottom: 6,
            transition: "color 0.2s",
          }}>
            {action.name}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.mono, fontSize: 13, color: T.text2, flexWrap: "wrap" }}>
            {summaryBadge && (<><KeyBadge>{summaryBadge}</KeyBadge><Dot /></>)}
            <span>{intervalStr}</span>
            <Dot />
            <span>{modeStr}</span>
            {action.hotkey && (<><Dot /><KeyBadge>{action.hotkey.toUpperCase()}</KeyBadge></>)}
          </div>
        </div>

        <ActiveToggle isActive={isActive} onClick={handleManualToggle} disabled={action.trigger_mode === "hold"} />

        {!isBuiltin && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(action.id); }}
            title="Delete action"
            style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: 8,
              background: "transparent", border: "1px solid transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: T.text3,
              transition: "background 0.15s, border-color 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.15)"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.32)"; e.currentTarget.style.color = "rgba(248,113,113,0.9)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = T.text3; }}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}

        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" style={{
          flexShrink: 0, color: T.text3,
          transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s ease",
        }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* ── Expanded body ── */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <div style={{
              borderTop: "1px solid rgba(255,255,255,0.06)",
              padding: "24px 20px 28px",
              display: "flex", flexDirection: "column", gap: 28,
            }}>

              {/* NAME */}
              {!isBuiltin && (
                <div>
                  <SectionLabel>Name</SectionLabel>
                  <TextInput type="text" value={action.name}
                    onChange={(e) => pushUpdate({ ...action, name: e.target.value })}
                    style={{ width: "100%" }} placeholder="Action name"
                  />
                </div>
              )}

              {/* ACTION TYPE */}
              {!isBuiltin && (
                <div>
                  <SectionLabel>Action Type</SectionLabel>
                  <Segments
                    options={[
                      { value: "mouse_click", label: "Mouse Click" },
                      { value: "key_press",   label: "Key Press"   },
                      { value: "key_combo",   label: "Key Combo"   },
                      { value: "sequence",    label: "Sequence"    },
                    ]}
                    value={at.type}
                    onChange={handleActionTypeChange}
                  />
                </div>
              )}

              {/* MOUSE BUTTON */}
              {at.type === "mouse_click" && !isBuiltin && (
                <div>
                  <SectionLabel>Mouse Button</SectionLabel>
                  <Segments
                    options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]}
                    value={at.button}
                    onChange={(btn) => pushUpdate({ ...action, action_type: { ...at, button: btn } })}
                  />
                </div>
              )}

              {/* KEY PRESS */}
              {at.type === "key_press" && (
                <div>
                  <SectionLabel>Key</SectionLabel>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <CaptureBox
                      capturing={capturingKey} liveDisplay={null}
                      committed={at.key ? formatKey(at.key) : null}
                      placeholder="None" warningText="Press any key…"
                    />
                    <HkButton onClick={capturingKey ? (e) => { e.stopPropagation(); setCapturingKey(false); } : (e) => { e.stopPropagation(); setCapturingKey(true); }} variant={capturingKey ? "warn" : "accent"}>
                      {capturingKey ? "Cancel" : "Set Key"}
                    </HkButton>
                  </div>
                  {capturingKey && (
                    <p style={{ marginTop: 9, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                      Press any key to set it. Esc cancels.
                    </p>
                  )}
                </div>
              )}

              {/* KEY COMBO */}
              {at.type === "key_combo" && (
                <div>
                  <SectionLabel>Key Combination</SectionLabel>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <CaptureBox
                      capturing={capturingCombo}
                      liveDisplay={liveComboKeys ? formatKeyCombo(liveComboKeys) : null}
                      committed={at.keys?.length ? formatKeyCombo(at.keys) : null}
                      placeholder="None" warningText="Hold modifiers, press key, release…"
                    />
                    <HkButton onClick={capturingCombo ? (e) => { e.stopPropagation(); setCapturingCombo(false); setLiveComboKeys(null); } : (e) => { e.stopPropagation(); setCapturingCombo(true); }} variant={capturingCombo ? "warn" : "accent"}>
                      {capturingCombo ? "Cancel" : "Record"}
                    </HkButton>
                  </div>
                  {capturingCombo && (
                    <p style={{ marginTop: 9, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                      Hold modifiers (Ctrl, Shift, Alt) then press the main key. Release to confirm. Esc cancels.
                    </p>
                  )}
                  {!capturingCombo && at.keys?.length > 0 && (
                    <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                      {at.keys.map((k, i) => (
                        <span key={i} style={{
                          background: i === at.keys.length - 1 ? "rgba(124,58,237,0.22)" : "rgba(255,255,255,0.06)",
                          border: `1px solid ${i === at.keys.length - 1 ? "rgba(124,58,237,0.4)" : "rgba(255,255,255,0.1)"}`,
                          color: i === at.keys.length - 1 ? T.accentLight : T.text2,
                          padding: "4px 12px", borderRadius: 6,
                          fontSize: 13, fontFamily: T.mono, fontWeight: 500,
                        }}>
                          {formatKey(k)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* SEQUENCE STEPS */}
              {at.type === "sequence" && (
                <div>
                  <SectionLabel>Steps</SectionLabel>
                  {(!at.steps || at.steps.length === 0) ? (
                    <p style={{ fontSize: 13, color: T.text3, marginBottom: 14, lineHeight: 1.6 }}>
                      No steps yet. Add a step to get started — steps run in order when the action fires.
                    </p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                      {at.steps.map((step, idx) => (
                        <SequenceStepRow
                          key={step.id}
                          step={step}
                          index={idx}
                          totalSteps={at.steps.length}
                          onChange={(updated) => updateStep(idx, updated)}
                          onRemove={() => removeStep(idx)}
                          onMoveUp={() => moveStep(idx, -1)}
                          onMoveDown={() => moveStep(idx, 1)}
                        />
                      ))}
                    </div>
                  )}
                  <button
                    onClick={addStep}
                    style={{
                      width: "100%", height: 36,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px dashed rgba(255,255,255,0.14)",
                      borderRadius: 9, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      gap: 7, fontSize: 12, fontWeight: 600,
                      color: T.text3, fontFamily: T.sans,
                      transition: "background 0.15s, border-color 0.15s, color 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(124,58,237,0.08)"; e.currentTarget.style.borderColor = "rgba(124,58,237,0.3)"; e.currentTarget.style.color = T.accentLight; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.14)"; e.currentTarget.style.color = T.text3; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                      <line x1="5.5" y1="1" x2="5.5" y2="10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      <line x1="1" y1="5.5" x2="10" y2="5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    Add Step
                  </button>
                  <p style={{ marginTop: 10, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                    Each step fires in order, then waits its delay before the next. After the last step, the action waits the <em style={{ color: T.text2 }}>repeat delay</em> below before repeating.
                  </p>
                </div>
              )}

              {/* POSITION (mouse_click only) */}
              {at.type === "mouse_click" && (
                <div>
                  <SectionLabel>Click Position</SectionLabel>
                  <Segments
                    options={[
                      { value: "current_cursor", label: "Current Cursor" },
                      { value: "fixed",          label: "Fixed Position" },
                    ]}
                    value={at.position?.type ?? "current_cursor"}
                    onChange={handlePositionType}
                  />
                  {isFixed && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        {[["x", "X"], ["y", "Y"]].map(([axis, label]) => (
                          <div key={axis} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: T.text3, letterSpacing: "0.06em", fontFamily: T.mono }}>
                              {label}
                            </span>
                            <TextInput
                              type="number"
                              value={at.position[axis] ?? 0}
                              onChange={(e) => handleFixedCoord(axis, e.target.value)}
                              style={{ width: 84, height: 38, fontSize: 14 }}
                            />
                          </div>
                        ))}
                        <HkButton onClick={handleCapturePosition} variant={capturingPos ? "warn" : "accent"}>
                          {capturingPos ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "currentColor", animation: "pulse 1s ease-in-out infinite" }} />
                              Waiting for click…
                            </span>
                          ) : captureCountdown !== null ? (
                            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              <span style={{ fontFamily: T.mono, fontWeight: 700 }}>{captureCountdown}</span>
                              Minimizing…
                            </span>
                          ) : (
                            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <circle cx="6" cy="6" r="2" fill="currentColor" />
                                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
                                <line x1="6" y1="0" x2="6" y2="2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                <line x1="6" y1="10" x2="6" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                <line x1="0" y1="6" x2="2" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                                <line x1="10" y1="6" x2="12" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                              </svg>
                              Capture
                            </span>
                          )}
                        </HkButton>
                      </div>
                      <CountdownBanner countdown={captureCountdown} />
                      {capturingPos && (
                        <p style={{ marginTop: 10, fontSize: 12, color: "rgba(250,204,21,0.7)", lineHeight: 1.6 }}>
                          Click anywhere on screen to set the position. (20s timeout)
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* INTERVAL / REPEAT DELAY */}
              <div>
                <SectionLabel>{at.type === "sequence" ? "Repeat Delay" : "Interval"}</SectionLabel>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <TextInput
                    type="number" min="0" step="any"
                    value={displayValue} onChange={handleIntervalChange}
                    style={{ width: 96 }}
                  />
                  <Segments options={UNIT_OPTIONS} value={unit} onChange={handleUnitChange} mono />
                </div>
                {at.type === "sequence" && (
                  <p style={{ marginTop: 10, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                    Time to wait after the sequence finishes before running it again.
                  </p>
                )}
              </div>

              {/* MODE */}
              <div>
                <SectionLabel>Mode</SectionLabel>
                <Segments
                  options={[{ value: "toggle", label: "Toggle" }, { value: "hold", label: "Hold" }]}
                  value={action.trigger_mode} onChange={handleModeChange}
                />
                {action.trigger_mode === "hold" && (
                  <p style={{ marginTop: 10, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                    Action fires while the hotkey is held down.
                  </p>
                )}
              </div>

              {/* HOTKEY */}
              <div>
                <SectionLabel>Hotkey</SectionLabel>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <CaptureBox
                    capturing={capturing} liveDisplay={liveCombo}
                    committed={action.hotkey ? action.hotkey.toUpperCase() : null}
                    placeholder="None" warningText="Hold keys, then release…"
                  />
                  <HkButton onClick={capturing ? cancelCapture : startCapture} variant={capturing ? "warn" : "accent"}>
                    {capturing ? "Cancel" : "Set"}
                  </HkButton>
                  {action.hotkey && !capturing && (
                    <HkButton onClick={(e) => { e.stopPropagation(); pushUpdate({ ...action, hotkey: null }); }} variant="danger" square>
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                        <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </HkButton>
                  )}
                </div>
                {capturing && (
                  <p style={{ marginTop: 9, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                    Hold modifiers (Ctrl, Shift, Alt) then press a key. Release to confirm. Esc cancels.
                  </p>
                )}
              </div>

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
