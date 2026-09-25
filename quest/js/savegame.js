/* 34i-Quest – Spielstand über die File System Access API
 * Genau eine Datei: smartadm_34i.json. Kein localStorage.
 * Der Dateihandle wird in IndexedDB gemerkt, damit „Weiterspielen“ ohne Dateidialog klappt
 * (der Fortschritt selbst liegt ausschließlich in der JSON-Datei).
 */

export const SAVE_NAME = 'smartadm_34i.json';
export const SAVE_VERSION = 2;

export const SaveError = {
  UNSUPPORTED: 'UNSUPPORTED',
  ABORTED: 'ABORTED',
  WRONG_NAME: 'WRONG_NAME',
  INVALID: 'INVALID',
  PERMISSION: 'PERMISSION',
  WRITE: 'WRITE',
  NO_HANDLE: 'NO_HANDLE',
};

class SaveGameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function isSupported() {
  return window.isSecureContext && typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';
}

/* ---------- Datenmodell ---------- */

export function createChapterProgress() {
  return {
    learnCompleted: [], storyWins: 0, versusWins: 0, bossWins: 0,
    bestStory: 0, bestVersus: 0, bestBoss: 0,
    stars: { story: 0, versus: 0, boss: 0 },
    checksDone: [], learnXp: [], mistakes: {}, levelCompleted: false, coinFirst: [],
  };
}

export function createDefaultState() {
  const now = new Date().toISOString();
  return {
    app: '34i-Quest', saveVersion: SAVE_VERSION, createdAt: now, updatedAt: now,
    player: {
      xp: 0, answered: 0, correct: 0, bestCombo: 0, achievements: [], lastDay: null, dayStreak: 0,
      hp: 100, maxHp: 100, coins: 0, inventory: { small: 0, medium: 0, large: 0, spark: 0 },
    },
    settings: { sound: true, shuffleAnswers: true },
    progress: {},
    lastQuestions: {},
  };
}

const num = (v, d = 0) => (Number.isFinite(v) && v >= 0 ? v : d);
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** Prüft und repariert einen geladenen Spielstand. Unbekanntes wird verworfen, Fehlendes ergänzt. */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== '34i-Quest') {
    throw new SaveGameError(SaveError.INVALID, 'Die Datei ist kein 34i-Quest-Spielstand.');
  }
  if (num(raw.saveVersion) > SAVE_VERSION) {
    throw new SaveGameError(SaveError.INVALID, 'Der Spielstand stammt aus einer neueren App-Version. Bitte App aktualisieren.');
  }
  const s = createDefaultState();
  s.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : s.createdAt;
  const p = raw.player || {};
  const inv = p.inventory || {};
  const maxHp = Math.max(1, num(p.maxHp, 100));
  s.player = {
    xp: num(p.xp), answered: num(p.answered), correct: num(p.correct), bestCombo: num(p.bestCombo),
    achievements: strArr(p.achievements), lastDay: typeof p.lastDay === 'string' ? p.lastDay : null, dayStreak: num(p.dayStreak),
    hp: Math.min(maxHp, num(p.hp, maxHp)), maxHp, coins: Math.floor(num(p.coins)),
    inventory: { small: num(inv.small), medium: num(inv.medium), large: num(inv.large), spark: num(inv.spark) },
  };
  const st = raw.settings || {};
  s.settings = { sound: st.sound !== false, shuffleAnswers: st.shuffleAnswers !== false };
  for (const [id, cp] of Object.entries(raw.progress || {})) {
    if (!cp || typeof cp !== 'object') continue;
    const base = createChapterProgress();
    const stars = cp.stars || {};
    const mistakes = {};
    for (const [qid, n] of Object.entries(cp.mistakes || {})) if (num(n) > 0) mistakes[qid] = Math.min(9, num(n));
    s.progress[id] = {
      ...base,
      learnCompleted: strArr(cp.learnCompleted), checksDone: strArr(cp.checksDone), learnXp: strArr(cp.learnXp),
      storyWins: num(cp.storyWins), versusWins: num(cp.versusWins), bossWins: num(cp.bossWins),
      bestStory: num(cp.bestStory), bestVersus: num(cp.bestVersus), bestBoss: num(cp.bestBoss),
      stars: { story: num(stars.story), versus: num(stars.versus), boss: num(stars.boss) },
      mistakes, levelCompleted: cp.levelCompleted === true, coinFirst: strArr(cp.coinFirst),
    };
  }
  for (const [id, lq] of Object.entries(raw.lastQuestions || {})) {
    if (!lq || typeof lq !== 'object') continue;
    s.lastQuestions[id] = { story: strArr(lq.story), versus: strArr(lq.versus), boss: strArr(lq.boss) };
  }
  return s;
}

/* ---------- Handle in IndexedDB merken ---------- */

const IDB_NAME = '34i-quest';
const IDB_STORE = 'handles';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const rememberHandle = (h) => idb('readwrite', (s) => s.put(h, 'save')).catch(() => {});
const recallHandle = () => idb('readonly', (s) => s.get('save')).catch(() => null);
export const forgetHandle = () => idb('readwrite', (s) => s.delete('save')).catch(() => {});

/* ---------- SaveGame ---------- */

const PICKER_TYPES = [{ description: '34i-Quest Spielstand', accept: { 'application/json': ['.json'] } }];

export class SaveGame {
  constructor() {
    this.handle = null;
    this.state = null;
    this.guest = false;          // Demo-Modus ohne Datei
    this.canWrite = false;
    this.dirty = false;
    this.writing = null;         // laufender Schreibvorgang (Promise)
    this.listeners = new Set();
  }

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(status, detail = '') { this.listeners.forEach((fn) => fn(status, detail)); }

  async hasRemembered() {
    if (!isSupported()) return false;
    const h = await recallHandle();
    return !!(h && h.name === SAVE_NAME);
  }

  async ensurePermission(handle) {
    const opts = { mode: 'readwrite' };
    try {
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      return (await handle.requestPermission(opts)) === 'granted';
    } catch {
      return false; // z. B. keine Nutzeraktivierung mehr – Button „Speichern erlauben“ übernimmt
    }
  }

  async newGame() {
    if (!isSupported()) throw new SaveGameError(SaveError.UNSUPPORTED, 'Dieser Browser unterstützt kein Speichern in Dateien. Bitte Chrome oder Edge verwenden.');
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: SAVE_NAME, startIn: 'documents', types: PICKER_TYPES, excludeAcceptAllOption: true });
    } catch (err) {
      throw this.pickerError(err);
    }
    if (handle.name !== SAVE_NAME) {
      throw new SaveGameError(SaveError.WRONG_NAME, `Der Spielstand muss „${SAVE_NAME}“ heißen. Du hast „${handle.name}“ gewählt – diese Datei bitte löschen und erneut starten.`);
    }
    this.handle = handle;
    this.state = createDefaultState();
    this.guest = false;
    this.canWrite = await this.ensurePermission(handle);
    if (!this.canWrite) throw new SaveGameError(SaveError.PERMISSION, 'Ohne Schreibrecht kann der Spielstand nicht angelegt werden.');
    await this.flush(true);
    await rememberHandle(handle);
    return this.state;
  }

  async loadGame() {
    if (!isSupported()) throw new SaveGameError(SaveError.UNSUPPORTED, 'Dieser Browser kann keine Spielstände laden. Bitte Chrome oder Edge verwenden.');
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ startIn: 'documents', multiple: false, types: PICKER_TYPES, excludeAcceptAllOption: true });
    } catch (err) {
      throw this.pickerError(err);
    }
    return this.openHandle(handle);
  }

  async resume() {
    const handle = await recallHandle();
    if (!handle) throw new SaveGameError(SaveError.NO_HANDLE, 'Kein gemerkter Spielstand gefunden. Bitte „Spielstand laden“ wählen.');
    return this.openHandle(handle);
  }

  async openHandle(handle) {
    if (!handle || handle.name !== SAVE_NAME) {
      throw new SaveGameError(SaveError.WRONG_NAME, `Bitte genau die Datei „${SAVE_NAME}“ auswählen.`);
    }
    // Schreibrecht direkt anfragen, solange die Nutzeraktion noch „frisch“ ist
    const writable = await this.ensurePermission(handle);
    let text;
    try {
      text = await (await handle.getFile()).text();
    } catch {
      throw new SaveGameError(SaveError.PERMISSION, 'Die Datei konnte nicht gelesen werden. Wurde sie verschoben oder gelöscht?');
    }
    let raw;
    try { raw = JSON.parse(text); } catch {
      throw new SaveGameError(SaveError.INVALID, 'Die Spielstand-Datei ist beschädigt (kein gültiges JSON).');
    }
    this.state = normalizeState(raw);
    this.handle = handle;
    this.guest = false;
    this.canWrite = writable;
    await rememberHandle(handle);
    this.emit(writable ? 'ready' : 'permission');
    return this.state;
  }

  startGuest() {
    this.handle = null;
    this.guest = true;
    this.canWrite = false;
    this.state = createDefaultState();
    this.emit('guest');
    return this.state;
  }

  /** Vom Nutzer per Button ausgelöst, falls das Schreibrecht beim Laden nicht erteilt wurde. */
  async grantWrite() {
    if (!this.handle) return false;
    this.canWrite = await this.ensurePermission(this.handle);
    if (this.canWrite) { this.emit('ready'); if (this.dirty) this.save(); }
    else this.emit('permission');
    return this.canWrite;
  }

  pickerError(err) {
    if (err && err.name === 'AbortError') return new SaveGameError(SaveError.ABORTED, 'Abgebrochen.');
    if (err && err.name === 'SecurityError') return new SaveGameError(SaveError.PERMISSION, 'Der Browser hat den Dateidialog blockiert. Bitte erneut klicken.');
    return new SaveGameError(SaveError.WRITE, 'Der Dateidialog konnte nicht geöffnet werden.');
  }

  /**
   * Speichern anstoßen. Schreibvorgänge laufen nie parallel:
   * Während geschrieben wird, merkt sich die Klasse nur „dirty“ und schreibt danach genau einmal nach.
   */
  save() {
    if (!this.state) return Promise.resolve();
    this.dirty = true;
    if (this.guest) { this.emit('guest'); return Promise.resolve(); }
    if (!this.canWrite) { this.emit('permission'); return Promise.resolve(); }
    if (!this.writing) {
      this.writing = (async () => {
        try {
          while (this.dirty) {
            this.dirty = false;
            await this.writeOnce();
          }
          this.emit('saved');
        } catch (err) {
          this.dirty = true;
          const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
          if (denied) { this.canWrite = false; this.emit('permission'); }
          else this.emit('error', err && err.message ? err.message : 'Unbekannter Fehler');
        } finally {
          this.writing = null;
        }
      })();
    }
    return this.writing;
  }

  async flush(force = false) {
    if (force) this.dirty = true;
    if (this.writing) await this.writing;
    if (this.dirty) await this.save();
  }

  async writeOnce() {
    this.state.updatedAt = new Date().toISOString();
    const json = JSON.stringify(this.state, null, 2);
    const w = await this.handle.createWritable();
    try {
      await w.write(json);
      await w.close();
    } catch (err) {
      try { await w.abort(); } catch { /* ignorieren */ }
      throw err;
    }
  }
}
