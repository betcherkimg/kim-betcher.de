const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c=vm.createContext({});vm.runInContext(fs.readFileSync('smartadm/office/regular-week.js','utf8'),c);const standing=(e,a)=>JSON.parse(JSON.stringify(c.OfficeRegularWeek.appointmentStanding(e,a)));
test('current total includes drafts once; submission confirms the same total and new drafts mark it provisional again',()=>{
 const confirmed={appointments:10,entryState:'final'},draft={appointments:4,entryState:'draft'};
 assert.deepEqual(standing([confirmed,draft]),{total:14,official:10,provisional:4,hasDrafts:true});
 assert.deepEqual(standing([confirmed,{...draft,entryState:'final'}]),{total:14,official:14,provisional:0,hasDrafts:false});
 assert.deepEqual(standing([confirmed,{...draft,entryState:'final'},{appointments:2,entryState:'draft'}]),{total:16,official:14,provisional:2,hasDrafts:true});
});
test('cancellations are applied once, never yield a negative count; legacy final entries stay confirmed',()=>{
 assert.deepEqual(standing([{appointments:10},{appointments:4,entryState:'draft'}],-2),{total:12,official:8,provisional:4,hasDrafts:true});
 assert.deepEqual(standing([{appointments:2},{appointments:4,entryState:'draft'}],-3),{total:3,official:0,provisional:3,hasDrafts:true});
 assert.deepEqual(standing([],0),{total:0,official:0,provisional:0,hasDrafts:false});
});
