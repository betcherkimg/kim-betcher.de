const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const html = readFileSync(require('node:path').join(__dirname, '../smartadm/office/index.html'), 'utf8');
const monday = html.match(/  function mondayOfWeek\(date\) \{[\s\S]*?\n  \}/)[0];
const start = html.indexOf('  const WEEK_RESULT_LABELS = {');
const end = html.indexOf('  /* --- Mitarbeiter: Einsatzplan im Dashboard --- */', start);
const context = vm.createContext({ CONTRACT_WEEKLY_HOURS: 6, CONTRACT_MAX_WORKDAYS_PER_WEEK: 3 });
vm.runInContext(`${monday}\n${html.slice(start, end)}\nglobalThis.subject = {
  normalizeWeekReview, weekReviewPayload, computeWeekAccount, WEEK_REVIEW_STORAGE
};`, context);
const { normalizeWeekReview, weekReviewPayload, computeWeekAccount, WEEK_REVIEW_STORAGE } = context.subject;
const week = '2026-10-12';
const account = (reviews, extra = {}) => computeWeekAccount({
  start: week, end: '2026-10-25', today: '2026-10-26',
  entries: [{ date: week, minutes: 305 }], reviews, ...extra
});
const review = (result, note = '') => ({ id: 7, ...weekReviewPayload(week, result, note) });

test('both agreements survive the existing API format, including empty and personal notes', () => {
  for (const result of ['approved', 'makeup']) {
    for (const note of ['', 'Gute Woche, am Freitag früher Schluss.']) {
      const saved = review(result, note);
      assert.ok(['unexcused', 'excused', 'employer'].includes(saved.result));
      const reopened = normalizeWeekReview(JSON.parse(JSON.stringify(saved)));
      assert.equal(reopened.id, 7);
      assert.equal(reopened.result, result);
      assert.equal(reopened.note, note);
      assert.equal(account([saved]).weeks[0].review.result, result);
    }
  }
});

test('approved short weeks retain actual hours and create no make-up obligation', () => {
  const result = account([review('approved')]);
  assert.equal(result.weeks[0].soll, 360);
  assert.equal(result.weeks[0].ist, 305);
  assert.equal(result.weeks[0].missing, 55);
  assert.equal(result.owed, 0);
});

test('agreed make-up carries 55 minutes forward and offsets only later surplus hours', () => {
  const reviews = [review('makeup')];
  assert.equal(account(reviews).owed, 55);
  const entries = [{ date: week, minutes: 305 }, { date: '2026-10-19', minutes: 385 }];
  assert.equal(account(reviews, { entries }).owed, 30);
  entries[1].minutes = 415;
  assert.equal(account(reviews, { entries }).owed, 0);
  entries[1].minutes = 360;
  assert.equal(account(reviews, { entries }).owed, 55);
});

test('changing the same review between make-up and approval recalculates the balance', () => {
  const old = review('makeup', 'So vereinbart');
  assert.equal(account([old]).owed, 55);
  const changed = { ...old, ...weekReviewPayload(week, 'approved', normalizeWeekReview(old).note) };
  assert.equal(changed.id, old.id);
  assert.equal(account([changed]).owed, 0);
  assert.equal(normalizeWeekReview(changed).note, 'So vereinbart');
  assert.equal(account([{ ...changed, ...weekReviewPayload(week, 'makeup', 'Nächste Woche') }]).owed, 55);
});

test('existing classifications and unrelated notes keep their original meaning', () => {
  for (const result of ['excused', 'unexcused', 'employer']) {
    const saved = review(result, 'Notiz mit [Genehmigt] mitten im Text');
    assert.equal(normalizeWeekReview(saved).result, result);
    assert.equal(normalizeWeekReview(saved).note, saved.note);
    assert.equal(account([saved]).owed, result === 'unexcused' ? 55 : 0);
  }
  // Approval in another short week does not waive an earlier obligation.
  assert.equal(account([review('unexcused'), {
    ...weekReviewPayload('2026-10-19', 'approved', '')
  }]).owed, 55);
});

test('the wire note respects the API length limit without silently losing text', () => {
  for (const result of ['approved', 'makeup', 'excused']) {
    const limit = 500 - (WEEK_REVIEW_STORAGE[result]?.prefix.length || 0);
    const note = 'x'.repeat(limit);
    assert.equal(weekReviewPayload(week, result, note).note.length, 500);
    assert.equal(normalizeWeekReview(review(result, note)).note, note);
    assert.throws(() => weekReviewPayload(week, result, note + 'x'), /Notiz/);
  }
});
