import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import "./App.css";
import ActionCard from "./components/ActionCard";

export default function App() {
  const [actions, setActions] = useState([]);
  const [activeMap, setActiveMap] = useState({});
  const [hotkeyErrors, setHotkeyErrors] = useState({});

  // Load actions once on mount
  useEffect(() => {
    invoke("get_actions").then(setActions).catch(console.error);
  }, []);

  // Poll status (active flags + hotkey errors) every 200 ms — one IPC call
  // for the whole app rather than one per action.
  useEffect(() => {
    if (!actions.length) return;
    const poll = async () => {
      try {
        const status = await invoke("get_status");
        setActiveMap(status.active ?? {});
        setHotkeyErrors(status.hotkey_errors ?? {});
      } catch (err) {
        console.error("get_status:", err);
      }
    };
    poll();
    const id = setInterval(poll, 200);
    return () => clearInterval(id);
  }, [actions]);

  const handleActiveChange = useCallback((id, active) => {
    setActiveMap((prev) => ({ ...prev, [id]: active }));
  }, []);

  // Add a new custom action
  const handleAddAction = async () => {
    try {
      const newAction = await invoke("add_action");
      setActions((prev) => [...prev, newAction]);
      setActiveMap((prev) => ({ ...prev, [newAction.id]: false }));
    } catch (err) {
      console.error("add_action:", err);
    }
  };

  // Remove a custom action
  const handleRemoveAction = async (id) => {
    try {
      await invoke("remove_action", { id });
      setActions((prev) => prev.filter((a) => a.id !== id));
      setActiveMap((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      console.error("remove_action:", err);
    }
  };

  const anyActive = Object.values(activeMap).some(Boolean);

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "#08080f",
      overflow: "hidden",
    }}>

      {/* ── Header ── */}
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 20px 15px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        flexShrink: 0,
      }}>
        <div>
          <div style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#ededfa",
            letterSpacing: "-0.03em",
            lineHeight: 1,
            fontFamily: "'Outfit', system-ui, sans-serif",
          }}>
            Bob's Better Autoclicker
          </div>
          <div style={{
            fontSize: 10,
            fontWeight: 500,
            color: "rgba(237,237,250,0.22)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            marginTop: 4,
            fontFamily: "'Outfit', system-ui, sans-serif",
          }}>
            Windows
          </div>
        </div>

        {/* Status pill */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "5px 12px",
          borderRadius: 20,
          background: anyActive ? "rgba(124,58,237,0.13)" : "rgba(255,255,255,0.04)",
          border: `1px solid ${anyActive ? "rgba(124,58,237,0.28)" : "rgba(255,255,255,0.07)"}`,
          transition: "all 0.3s",
        }}>
          <span style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: anyActive ? "#8b5cf6" : "rgba(255,255,255,0.2)",
            boxShadow: anyActive ? "0 0 8px rgba(139,92,246,0.7)" : "none",
            transition: "all 0.3s",
            flexShrink: 0,
          }} />
          <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: anyActive ? "rgba(167,139,250,0.9)" : "rgba(237,237,250,0.3)",
            transition: "color 0.3s",
            fontFamily: "'Outfit', system-ui, sans-serif",
          }}>
            {anyActive ? "Running" : "Idle"}
          </span>
        </div>
      </header>

      {/* ── Panic key bar ── */}
      <PanicBar />

      {/* ── Cards ── */}
      <main style={{
        flex: 1,
        overflowY: "auto",
        padding: "16px 16px 80px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}>
        {actions.length === 0 ? (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            fontSize: 13,
            color: "rgba(237,237,250,0.18)",
          }}>
            Loading…
          </div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            {actions.map((action) => (
              <motion.div
                key={action.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                layout
              >
                <ActionCard
                  action={action}
                  isActive={activeMap[action.id] ?? false}
                  hotkeyError={hotkeyErrors[action.id] ?? null}
                  onActiveChange={(active) => handleActiveChange(action.id, active)}
                  onRemove={handleRemoveAction}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </main>

      {/* ── Footer ── */}
      <footer style={{
        flexShrink: 0,
        padding: "10px 20px",
        borderTop: "1px solid rgba(255,255,255,0.04)",
        textAlign: "center",
      }}>
        <span style={{
          fontSize: 11,
          color: "rgba(237,237,250,0.13)",
          fontWeight: 400,
          letterSpacing: "0.01em",
          fontFamily: "'Outfit', system-ui, sans-serif",
        }}>
          Expand a card to configure · Hotkeys are global
        </span>
      </footer>

      {/* ── Floating action button ── */}
      <FAB onClick={handleAddAction} />
    </div>
  );
}

// Format a KeyboardEvent.code (physical key) into a friendly label.
function formatCode(code) {
  if (!code) return null;
  const SPECIAL = {
    ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
    AltLeft: "Left Alt", AltRight: "Right Alt",
    MetaLeft: "Left Win", MetaRight: "Right Win",
    Escape: "Esc", Space: "Space", Enter: "Enter", NumpadEnter: "Enter",
    Tab: "Tab", Backspace: "⌫", Delete: "Del", Insert: "Ins",
    Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    CapsLock: "Caps",
  };
  if (SPECIAL[code]) return SPECIAL[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  return code;
}

// ── Panic / Stop-All hotkey bar ───────────────────────────────────────────────
function PanicBar() {
  const [panicKey, setPanicKey] = useState(null);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    invoke("get_panic_hotkey").then(setPanicKey).catch(console.error);
  }, []);

  // Capture the next physical key press (uses e.code so lone modifiers like
  // Right Shift, which global shortcuts can't bind, are supported).
  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = e.code;
      setCapturing(false);
      setPanicKey(code);
      invoke("set_panic_hotkey", { hotkey: code }).catch((err) =>
        console.error("set_panic_hotkey:", err)
      );
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [capturing]);

  const clearPanic = () => {
    setPanicKey(null);
    invoke("set_panic_hotkey", { hotkey: null }).catch((err) =>
      console.error("set_panic_hotkey:", err)
    );
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "9px 20px",
      background: "rgba(239,68,68,0.05)",
      borderBottom: "1px solid rgba(255,255,255,0.05)",
      flexShrink: 0,
      fontFamily: "'Outfit', system-ui, sans-serif",
    }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
        <path d="M7 1L13 12H1L7 1Z" stroke="rgba(248,113,113,0.85)" strokeWidth="1.4" strokeLinejoin="round" />
        <line x1="7" y1="5.5" x2="7" y2="8.5" stroke="rgba(248,113,113,0.85)" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="7" cy="10.3" r="0.75" fill="rgba(248,113,113,0.85)" />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(248,113,113,0.9)", flexShrink: 0 }}>
        Panic — Stop All
      </span>
      <div style={{
        flex: 1, height: 30, display: "flex", alignItems: "center",
        padding: "0 12px", borderRadius: 8,
        background: "rgba(255,255,255,0.05)",
        border: `1px solid ${capturing ? "rgba(250,204,21,0.45)" : "rgba(255,255,255,0.08)"}`,
        fontFamily: "'JetBrains Mono', Consolas, monospace",
        fontSize: 13, letterSpacing: "0.03em",
        color: capturing
          ? "rgba(250,204,21,0.85)"
          : panicKey ? "rgba(237,237,250,0.85)" : "rgba(237,237,250,0.3)",
        minWidth: 0,
      }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {capturing ? "Press any key…" : (formatCode(panicKey) ?? "None — you can be locked in!")}
        </span>
      </div>
      <PanicBtn onClick={() => setCapturing((c) => !c)} warn={capturing}>
        {capturing ? "Cancel" : "Set"}
      </PanicBtn>
      {panicKey && !capturing && (
        <PanicBtn onClick={clearPanic} danger>Clear</PanicBtn>
      )}
    </div>
  );
}

function PanicBtn({ children, onClick, warn = false, danger = false }) {
  const [hovered, setHovered] = useState(false);
  let bg, border, color;
  if (warn) {
    bg = "rgba(250,204,21,0.14)"; border = "rgba(250,204,21,0.4)"; color = "rgba(250,204,21,0.95)";
  } else if (danger) {
    bg = hovered ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.05)";
    border = hovered ? "rgba(239,68,68,0.4)" : "rgba(255,255,255,0.08)";
    color = hovered ? "rgba(248,113,113,0.95)" : "rgba(237,237,250,0.4)";
  } else {
    bg = hovered ? "rgba(124,58,237,0.3)" : "rgba(124,58,237,0.18)";
    border = hovered ? "rgba(124,58,237,0.52)" : "rgba(124,58,237,0.32)";
    color = hovered ? "#fff" : "#a78bfa";
  }
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flexShrink: 0, height: 30, padding: "0 14px", borderRadius: 8,
        background: bg, border: `1px solid ${border}`, color,
        cursor: "pointer", fontSize: 12, fontWeight: 600,
        fontFamily: "'Outfit', system-ui, sans-serif",
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function FAB({ onClick }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      title="Add custom action"
      style={{
        position: "fixed",
        bottom: 50,
        right: 18,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 42,
        padding: "0 18px",
        borderRadius: 21,
        background: hovered
          ? "rgba(124,58,237,0.85)"
          : "rgba(124,58,237,0.72)",
        border: "1px solid rgba(167,139,250,0.35)",
        boxShadow: hovered
          ? "0 4px 24px rgba(124,58,237,0.55), 0 0 0 1px rgba(124,58,237,0.3)"
          : "0 2px 12px rgba(124,58,237,0.30), 0 0 0 1px rgba(124,58,237,0.15)",
        color: "#fff",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "'Outfit', system-ui, sans-serif",
        letterSpacing: "0.01em",
        transition: "background 0.15s, box-shadow 0.15s, transform 0.1s",
        transform: pressed ? "scale(0.95)" : "scale(1)",
        zIndex: 100,
        userSelect: "none",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <line x1="6.5" y1="1" x2="6.5" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="1" y1="6.5" x2="12" y2="6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      New Action
    </button>
  );
}
