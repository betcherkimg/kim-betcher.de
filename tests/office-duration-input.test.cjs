const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c=vm.createContext({});vm.runInContext(fs.readFileSync('smartadm/office/regular-week.js','utf8'),c);const {parseDuration,formatDuration}=c.OfficeRegularWeek;
test('hours and minutes preserve exact minutes including the existing 80-minute record',()=>{
 for(const [input,minutes] of [['1:20',80],['1:20h',80],['0:05',5],['1:59',119],['2',120],['24:00',1440],['',0]])assert.equal(parseDuration(input),minutes,input);
 assert.equal(formatDuration(80),'1:20');assert.equal(formatDuration(125),'2:05');assert.equal(formatDuration(0),'0:00');
});
test('decimal hours, invalid minutes and excessive durations are rejected',()=>{
 for(const input of ['1,33','1.33','1:60','1:2','-1:20','24:01','25:00','abc'])assert.equal(parseDuration(input),null,input);
});
