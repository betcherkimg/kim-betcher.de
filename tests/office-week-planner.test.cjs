const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../smartadm/office/week-planner.js');
const day = (date, minutes = 120, note = '', id = 1) => ({
  id, plan_date: date, start_time: '18:00', status: 'planned', note: P.encodeNote(minutes, note)
});

test('hours accept German decimals and hour/minute notation without losing minutes', () => {
  for (const [value, minutes] of [['2',120],['3',180],['2,5',150],['2.25',135],['1:55',115],['0,5',30]]) {
    assert.equal(P.parseHours(value), minutes);
    assert.equal(P.parseHours(P.hoursValue(minutes)), minutes);
  }
  for (const invalid of ['', '0', '-1', '25', '2:99', 'NaN', '1e2', '2,555']) assert.equal(P.parseHours(invalid), null);
});

test('planned duration and notes survive existing plan API storage, including trimming', () => {
  for (const minutes of [30,115,120,180,360]) {
    for (const note of ['', 'Nur bis 20 Uhr', 'Erste Zeile\nZweite Zeile']) {
      const saved = { note: P.encodeNote(minutes, note).trim() };
      assert.deepEqual(P.details(saved), { minutes, note });
    }
  }
  assert.deepEqual(P.details({ note: 'Bestehende Notiz' }), { minutes:120, note:'Bestehende Notiz' });
  assert.throws(() => P.encodeNote(120, 'x'.repeat(200)), /Notiz/);
  assert.throws(() => P.encodeNote(0, ''), /Stunden/);
});

test('three two-hour days and two three-hour days both total six hours', () => {
  for (const plans of [
    [day('2026-10-26'), day('2026-10-28',120,'',2), day('2026-10-30',120,'',3)],
    [day('2026-10-26',180), day('2026-10-29',180,'',2)]
  ]) {
    assert.equal(P.activeWeek(plans,'2026-10-26').reduce((sum,p)=>sum+P.details(p).minutes,0),360);
    assert.equal(P.activeWeek(plans,'2026-11-02').length,0);
  }
});

test('editing days keeps existing IDs; removing the third day and redistributing hours is explicit', () => {
  const base = [day('2026-10-26'),day('2026-10-28',120,'',2),day('2026-10-30',120,'',3)];
  const desired = [day('2026-10-26',180),day('2026-10-28',180,'',2)];
  const diff = P.changesFor(base,base,desired);
  assert.deepEqual(diff.remove.map(p=>p.id),[3]);
  assert.deepEqual(diff.update.map(p=>p.id),[1,2]);
  assert.equal(diff.add.length,0);
  assert.deepEqual(P.changesFor(base,base,base),{remove:[],update:[],add:[]});
});

test('a retry after a partial save or lost response does not duplicate already saved days', () => {
  const desired = [day('2026-10-26'),day('2026-10-28',120,'',2),day('2026-10-30',120,'',3)];
  const diff = P.changesFor([], [desired[0]], desired);
  assert.equal(diff.update.length,0);
  assert.deepEqual(diff.add.map(p=>p.plan_date),['2026-10-28','2026-10-30']);
  assert.equal(P.changesFor([],desired,desired).add.length,0);
});

test('concurrent edits, deletions, new days and newly started shifts are not overwritten', () => {
  const base=[day('2026-10-26')];
  for (const fresh of [[],[day('2026-10-26',120,'Anderes Gerät')],[{...base[0],status:'started'}],
    [...base,day('2026-10-29',120,'',9)]]) {
    assert.throws(()=>P.changesFor(base,fresh,base),/inzwischen geändert/);
  }
});

test('planning task starts Friday, remains due across the weekend and is overdue Monday', () => {
  assert.equal(P.reminderWeek('2026-10-21'),null);
  assert.equal(P.reminderWeek('2026-10-22'),null);
  for (const date of ['2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-29']) {
    assert.equal(P.reminderWeek(date),'2026-10-26');
  }
  assert.equal(P.reminderWeek('2026-10-30'),'2026-11-02');
  assert.equal(P.reminderWeek('2027-01-01'),'2027-01-04');
});

test('Friday and Saturday each permit postponement only until the next day; Sunday cannot be deferred', () => {
  const fri=P.reminderPolicy('2026-10-23',{});
  assert.equal(fri.canSnooze,true);assert.equal(fri.until,'2026-10-24');
  assert.equal(P.reminderPolicy('2026-10-23',{until:fri.until,count:1}).deferred,true);
  const sat=P.reminderPolicy('2026-10-24',{until:fri.until,count:1});
  assert.equal(sat.canSnooze,true);assert.equal(sat.deferred,false);assert.equal(sat.until,'2026-10-25');
  const sun=P.reminderPolicy('2026-10-25',{until:sat.until,count:2});
  assert.equal(sun.canSnooze,false);assert.equal(sun.deferred,false);
  assert.equal(P.reminderPolicy('2026-10-26',{count:2}).canSnooze,false);
});

test('calendar uses German dates across midnight and the daylight-saving change', () => {
  assert.equal(P.berlinDate(new Date('2026-10-22T22:30:00Z')),'2026-10-23');
  assert.equal(P.berlinDate(new Date('2026-10-24T22:30:00Z')),'2026-10-25');
  assert.equal(P.berlinDate(new Date('2026-10-25T22:30:00Z')),'2026-10-25');
  assert.equal(P.addDays('2026-10-25',1),'2026-10-26');
});

 test('deviating hours and the reason survive storage without becoming a day note',()=>{
  for(const minutes of [60,180,420]){
    const saved={note:P.encodeNote(minutes,'Start später','Nacharbeit aus der Vorwoche')};
    assert.deepEqual(P.details(saved),{minutes,note:'Start später',reason:'Nacharbeit aus der Vorwoche'});
  }
  assert.equal(P.parseHours('7'),420);
 });
