/* Letzte Schwelle: eigener Durchlauf ohne unmittelbare Antwortwertung. */
export const EXAM = Object.freeze({
  id: 'pruefstein', name: 'Letzte Schwelle', level: 25,
  boss: 'IHK-Präsident Valerian Prüfstein', title: 'Prüfer der letzten Schwelle',
  image: 'assets/world/quest-map-25.webp', x: 850 / 1672 * 100, y: 245 / 941 * 100,
  bossImage: 'assets/bosses/valerian-pruefstein.webp', bossBust: 'assets/bosses/valerian-pruefstein-bust.webp',
  seconds: 45 * 60,
  questionsPerLevel: 4, totalQuestions: 96, maxPoints: 150, passPoints: 75,
});

// Vorübergehend vom Nutzer freigegebener Zugang; normale Levels bleiben gesperrt.
export const EXAM_TEST_ACCESS = true;

export function allLevelsCompleted(manifest, state) {
  return Array.from({length: 24}, (_, i) => i + 1).every(level => {
    const c = manifest?.chapters?.find(c => c.level === level);
    const p = c && state?.progress?.[c.id];
    return !!c?.available && (p?.levelCompleted === true || p?.coinFirst?.includes('level'));
  });
}

export function examAccessible(manifest, state, test = EXAM_TEST_ACCESS) {
  return test || state?.finalExam?.unlocked === true || allLevelsCompleted(manifest, state);
}

// Schwierigkeit vor Taxonomiestufe; Mehrfachauswahl entscheidet nur bei Gleichstand.
export const challengeOf = q => (Number(q.difficulty) || 1) * 100
  + (Number(q.taxonomyLevel) || 1) * 10 + (q.type === 'multi' ? 1 : 0);

export function buildExam(pools, random = Math.random) {
  const questions = [];
  for (let level = 1; level <= 24; level++) {
    const pool = pools.find(p => p.level === level);
    const unique = [...new Map((pool?.questions || []).map(q => [q.id, q])).values()];
    if (unique.length < 4) throw new Error(`Level ${level}: Es fehlen Bossfragen. Bitte die Inhalte mit Internetverbindung laden.`);
    const ranked = unique.map(q => ({q, tie: random()}))
      .sort((a,b) => challengeOf(b.q) - challengeOf(a.q) || a.tie - b.tie);
    questions.push(...ranked.slice(0,4).map(({q}) => ({...q, level, chapter: pool.id, levelTitle: pool.title, points: 1})));
  }
  // 54 × 2 + 42 × 1 = 150. Bei gleicher Schwierigkeit zufällig verteilen.
  questions.map((q,index) => ({index, challenge: challengeOf(q), tie: random()}))
    .sort((a,b) => b.challenge - a.challenge || a.tie - b.tie)
    .slice(0, EXAM.maxPoints - EXAM.totalQuestions).forEach(({index}) => { questions[index].points = 2; });
  return questions;
}

export function scoreExam(questions, answers) {
  const review = questions.map((q, i) => {
    const selected = [...new Set(answers[i] || [])];
    const correct = selected.length === q.correct.length && q.correct.every(a => selected.includes(a));
    return {q, selected, correct, earned: correct ? q.points : 0};
  });
  const points = review.reduce((sum,r) => sum + r.earned, 0);
  return {points, maxPoints: EXAM.maxPoints, pct: points / EXAM.maxPoints * 100,
    passed: points >= EXAM.passPoints, correct: review.filter(r => r.correct).length, review};
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rich = v => esc(v).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const back = '<button class="btn btn--ghost" data-action="exam-map">Zur Insel</button>';

export function examMapHtml(record) {
  const pct = record.attempts ? Math.round(record.bestScore / EXAM.maxPoints * 100) : 0;
  return `<div class="worldmap-shell" data-world="pruefstein">
    <div class="worldmap-viewport" id="worldmapViewport" tabindex="0" aria-label="Letzte Schwelle – Level 25">
      <div class="worldmap" data-world="pruefstein">
        <img class="worldmap__bg" src="${EXAM.image}" alt="Düstere Insel von Valerian Prüfstein" width="1672" height="941">
        <div class="map-node map-node--25" style="--x:${EXAM.x}%;--y:${EXAM.y}%">
          <button class="map-marker exam-needle" data-action="exam-intro" aria-label="Level 25: IHK-Präsident Valerian Prüfstein – Prüfer der letzten Schwelle"><span>25</span></button>
          <div class="map-pop exam-map-pop" role="group" aria-label="Level 25 Prüfungsmodus">
            <div class="map-pop__head"><span class="map-pop__lvl">LEVEL 25</span><span class="map-pop__pct">${pct}%</span></div>
            <span class="map-pop__bossart" aria-hidden="true"><img class="map-pop__bossimg" src="${EXAM.bossBust}" alt="" width="82" height="82"></span>
            <h2>${EXAM.boss}</h2><p>${EXAM.title}</p>
            <p>96 Bossfragen · 150 Punkte · bestanden ab 75</p>
            <button class="btn btn--primary" data-action="exam-intro">Zur letzten Prüfung</button>
          </div>
        </div>
        <div class="exam-map-title"><span>Die letzte Schwelle</span><p>24 Wege. Eine Prüfung.</p></div>
      </div>
    </div>
  </div>`;
}

export function examIntroHtml(record, test) {
  return `<div class="exam-cine" id="examCine" role="region" aria-labelledby="examBossName">
    <div class="exam-cine__backdrop" aria-hidden="true"><div class="exam-cine__vortex"></div><div class="exam-cine__ring"></div><div class="exam-cine__ring exam-cine__ring--inner"></div>${Array.from({length:12},(_,i)=>`<i class="exam-cine__ember" style="--i:${i}"></i>`).join('')}</div>
    <div class="exam-cine__ticker" aria-hidden="true">${Array(12).fill('DIE LETZTE SCHWELLE').join(' ✦ ')}</div>
    <div class="exam-cine__tools">${back}<button class="btn btn--ghost exam-cine__skip" data-action="exam-cine-skip">Auftritt überspringen</button></div>
    <div class="exam-cine__stage">
      <div class="exam-cine__figure"><span class="exam-cine__seal" aria-hidden="true">XXV</span><img src="${EXAM.bossImage}" alt="IHK-Präsident Valerian Prüfstein" width="640" height="960" decoding="async"></div>
      <div class="exam-cine__text">
        <p class="exam-cine__kicker">Level 25 · Der Endboss${test ? ' · Testzugang' : ''}</p>
        <p class="exam-cine__office">IHK-Präsident</p>
        <h1 id="examBossName" aria-label="${EXAM.boss}"><span>Valerian</span><span>Prüfstein</span></h1>
        <p class="exam-cine__title">${EXAM.title}</p>
        <blockquote>„Komm rein, wenn du dich traust. Du hast 45 Minuten Zeit, danach hat dein letztes Stündchen geschlagen.“</blockquote>
        <div class="exam-cine__rules"><span><b>96</b> Bossfragen</span><span><b>45</b> Minuten</span><span><b>150</b> Punkte</span></div>
        <p class="exam-cine__stakes">75 Punkte öffnen die letzte Schwelle.</p>
        <p class="exam-cine__blind">Keine Hilfe. Keine Rückmeldung. Nur dein Wissen.</p>
        <details class="exam-cine__details"><summary>Prüfungsregeln</summary><p>Vier der schwersten Bossfragen je Level, in der Reihenfolge 1 bis 24. 54 Fragen zählen doppelt, 42 einfach. Start bei 0 Punkten, bestanden ab 75 (50 %). Mehrfachauswahl zählt nur vollständig richtig. Du kannst Antworten ändern. Nach 45 Minuten wird automatisch abgegeben; unbeantwortete Fragen zählen 0 Punkte. Lösungen erscheinen erst am Ende.</p></details>
        ${record.attempts ? `<p class="exam-cine__history">Bestwert ${record.bestScore}/150 · ${record.attempts} Versuch${record.attempts===1?'':'e'}${record.passed?' · bereits bestanden':''}</p>` : ''}
        <button class="exam-cine__start" id="examBegin" data-action="exam-start" disabled><span>Prüfung beginnen</span><small>Überschreite die letzte Schwelle</small><i aria-hidden="true">➜</i></button>
      </div>
    </div>
    <div class="exam-cine__bottom" aria-hidden="true">VALERIAN PRÜFSTEIN · PRÜFER DER LETZTEN SCHWELLE</div>
  </div>`;
}

export function examTimerText(deadline, now = Date.now()) {
  const seconds = Math.max(0,Math.ceil((deadline-now)/1000));
  return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}

export function examQuestionHtml(run) {
  const q = run.questions[run.index];
  const selected = run.answers[run.index];
  const answered = run.answers.filter(a => a.length).length;
  const multi = q.type === 'multi';
  const last = run.index === run.questions.length - 1;
  return `<div class="final-exam final-exam--question">
    <div class="final-exam__top"><p class="final-exam__kicker">Valerian Prüfstein · Level 25</p>
      <span class="final-exam__timer" id="examTimer" role="timer" aria-label="Verbleibende Prüfungszeit">${examTimerText(run.deadline)}</span><button class="linkbtn" data-action="exam-leave">Prüfung verlassen</button></div>
    <div class="final-exam__progress"><span>Frage ${run.index + 1} von 96</span><span>${answered}/96 beantwortet</span></div>
    <div class="bar"><span style="width:${(run.index + 1) / 96 * 100}%"></span></div>
    <p class="final-exam__origin">Level ${q.level} · ${esc(q.levelTitle)} <b>${q.points} Punkt${q.points === 1 ? '' : 'e'}</b></p>
    <h1>${rich(q.question)}</h1>
    <p class="final-exam__hint">${multi ? 'Wähle alle zutreffenden Antworten.' : 'Wähle eine Antwort.'}</p>
    <div class="final-exam__answers" role="group" aria-label="Antworten">
      ${q.answers.map((a,i) => `<button class="exam-answer ${selected.includes(i) ? 'is-selected' : ''}" data-action="exam-answer" data-i="${i}" aria-pressed="${selected.includes(i)}"><span>${String.fromCharCode(65+i)}</span>${rich(a)}</button>`).join('')}
    </div>
    <div class="final-exam__actions"><button class="btn btn--ghost" data-action="exam-prev" ${run.index === 0 ? 'disabled' : ''}>Zurück</button>
      <span>Auswertung erst nach der Abgabe</span>
      <button class="btn btn--primary" data-action="${last ? 'exam-submit' : 'exam-next'}" ${!selected.length || (last && answered !== 96) ? 'disabled' : ''}>${last ? 'Prüfung abgeben' : 'Antwort speichern & weiter'}</button></div>
  </div>`;
}

export function examResultHtml(result) {
  return `<div class="final-exam final-exam--result">
    <p class="final-exam__kicker">Level 25 · Endauswertung</p><h1>${result.passed ? 'Die letzte Schwelle ist überwunden.' : 'Prüfstein hält die Schwelle.'}</h1>
    <p class="final-exam__score ${result.passed ? 'is-passed' : ''}">${result.points}<small>/150 Punkte</small></p>
    <p>${result.pct.toFixed(1).replace('.',',')} % · ${result.correct}/96 Fragen richtig · ${result.passed ? 'Bestanden' : 'Noch nicht bestanden'} (ab 75 Punkten)</p>
    ${result.timeExpired ? `<p class="final-exam__history">Die 45 Minuten sind abgelaufen. ${result.answered}/96 Fragen beantwortet; unbeantwortete Fragen zählen 0 Punkte.</p>` : ''}
    <div class="final-exam__actions"><button class="btn btn--primary" data-action="exam-intro">Erneut antreten</button>${back}</div>
    <h2>Nachbesprechung</h2><div class="exam-review">
      ${result.review.map((r,i) => `<details class="exam-review__item ${r.correct ? 'is-correct' : ''}"><summary><span>${i+1}. Level ${r.q.level} · ${r.correct ? 'Richtig' : 'Falsch'} · ${r.earned}/${r.q.points} Punkten</span>${rich(r.q.question)}</summary>
        <p><b>Deine Antwort:</b> ${r.selected.map(a => esc(r.q.answers[a])).join(' · ') || 'Keine'}</p>
        <p><b>Richtig:</b> ${r.q.correct.map(a => esc(r.q.answers[a])).join(' · ')}</p><p>${rich(r.q.explanation)}</p></details>`).join('')}
    </div></div>`;
}
