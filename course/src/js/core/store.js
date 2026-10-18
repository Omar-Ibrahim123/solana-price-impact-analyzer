/* core/store.js: per-viewer state (progress, quiz answers, flashcards, exercise code).
 *
 * Everything lives under one localStorage key ("obz.v1") as JSON. Every access is wrapped
 * in try/catch; if storage is unavailable (private mode, blocked, sandboxed preview) the
 * store silently falls back to memory, so the page still works for this visit.
 *
 *   OBZ.store.get("some.key", fallback) / set(key, value) / remove(key)
 *   OBZ.store.progress.visit(n), .last(), .complete(n), .isComplete(n), .completed()
 *   OBZ.store.quiz.record(quizId, qIndex, choice, correct), .get(quizId), .isSolved(quizId, nQuestions)
 *   OBZ.store.cards.get(deckId) / .set(deckId, state)
 *   OBZ.store.exercises.passed(id) / .setPassed(id) / .code(id, fallback) / .saveCode(id, code)
 *   OBZ.store.onChange(fn)  -> unsubscribe
 */
(function (OBZ) {
  "use strict";

  const KEY = "obz.v1";
  let memory = {};
  let persistent = false;

  function readAll() {
    if (!persistent) return memory;
    try {
      const raw = window.localStorage.getItem(KEY);
      const v = raw ? JSON.parse(raw) : {};
      return v && typeof v === "object" ? v : {};
    } catch (e) { return memory; }
  }
  function writeAll(obj) {
    memory = obj;
    if (!persistent) return;
    try { window.localStorage.setItem(KEY, JSON.stringify(obj)); } catch (e) { /* quota or blocked: keep memory copy */ }
  }
  function probe() {
    try {
      const ls = window.localStorage;
      if (!ls) return false;
      const t = "obz.__probe";
      ls.setItem(t, "1"); ls.removeItem(t);
      return true;
    } catch (e) { return false; }
  }
  persistent = probe();
  if (persistent) memory = readAll();

  const subs = new Set();
  function notify(key) { for (const fn of Array.from(subs)) { try { fn(key); } catch (e) { /* ignore */ } } }

  function get(key, fallback) {
    const all = readAll();
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
  }
  function set(key, value) { const all = readAll(); all[key] = value; writeAll(all); notify(key); }
  function remove(key) { const all = readAll(); delete all[key]; writeAll(all); notify(key); }
  function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
  /** Forget everything (used by the "reset progress" button and tests). */
  function reset() { writeAll({}); notify("*"); }

  const progress = {
    visit(n) { set("progress.last", n); const v = get("progress.visited", []); if (!v.includes(n)) { v.push(n); set("progress.visited", v); } },
    last() { return get("progress.last", null); },
    visited() { return get("progress.visited", []); },
    complete(n) { const c = get("progress.completed", []); if (!c.includes(n)) { c.push(n); c.sort((a, b) => a - b); set("progress.completed", c); } },
    isComplete(n) { return get("progress.completed", []).includes(n); },
    completed() { return get("progress.completed", []); },
  };

  const quiz = {
    /** Record an answer. The first answer to a question is remembered as firstTry. */
    record(quizId, qIndex, choice, correct) {
      const all = get("quiz." + quizId, {});
      const prev = all[qIndex];
      all[qIndex] = { choice, correct, firstTry: prev ? prev.firstTry : correct, solved: (prev && prev.solved) || correct };
      set("quiz." + quizId, all);
      return all[qIndex];
    },
    get(quizId) { return get("quiz." + quizId, {}); },
    isSolved(quizId, nQuestions) {
      const all = quiz.get(quizId);
      for (let i = 0; i < nQuestions; i++) if (!all[i] || !all[i].solved) return false;
      return nQuestions > 0;
    },
    clear(quizId) { remove("quiz." + quizId); },
  };

  const cards = {
    get(deckId) { return get("cards." + deckId, {}); },
    set(deckId, state) { set("cards." + deckId, state); },
  };

  const exercises = {
    passed(id) { return !!get("ex.passed", {})[id]; },
    setPassed(id) { const p = get("ex.passed", {}); p[id] = true; set("ex.passed", p); },
    allPassed() { return Object.keys(get("ex.passed", {})); },
    code(id, fallback) { return get("ex.code." + id, fallback); },
    saveCode(id, code) { set("ex.code." + id, code); },
  };

  OBZ.store = {
    get, set, remove, reset, onChange, progress, quiz, cards, exercises,
    get available() { return persistent; },
    /** Tests only: force the memory fallback (as if localStorage threw). */
    _forceMemory(on) { persistent = on ? false : probe(); if (on) memory = {}; },
  };
})(window.OBZ = window.OBZ || {});
