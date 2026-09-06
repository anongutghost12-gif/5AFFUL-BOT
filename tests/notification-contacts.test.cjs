'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), vm = require('vm')
const { createRequire } = require('module')
const { EventEmitter } = require('events')
const root = path.resolve(__dirname, '..')

function load(file, mocks = {}, extra = {}) {
  const filename = path.join(root, file), module = { exports: {} }, native = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require: key => key in mocks ? mocks[key] : native(key), Buffer, console, process, global: {},
    setInterval, clearInterval, ...extra,
  }, { filename })
  return module.exports
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('available with a JID stays offline; DM reads are blocked through single and bulk APIs', async () => {
  const intervals = [], sent = [], ev = new EventEmitter()
  const socket = { ev,
    sendPresenceUpdate: async (type, jid) => { sent.push(['presence', type, jid]); ev.emit('connection.update', {isOnline:type==='available'}) },
    readMessages: async keys => sent.push(['readMessages', keys]),
    sendReceipts: async (keys, type) => sent.push(['sendReceipts', keys, type]),
    sendReceipt: async (...args) => sent.push(['sendReceipt', ...args]),
  }
  const guard = load('lib/safful-mobile-notifications.js', {}, {
    setInterval: fn => { const t = {fn,unref(){}}; intervals.push(t); return t },
    clearInterval: timer => { if (timer) timer.closed = true },
  })
  guard(socket); guard(socket)
  ev.emit('connection.update', {connection:'open'}); await settle()
  await socket.sendPresenceUpdate('available', '233240000003@s.whatsapp.net')
  await socket.sendPresenceUpdate('available', 'group@g.us')
  await socket.sendPresenceUpdate('composing', '233240000003@s.whatsapp.net')
  assert.ok(!sent.some(row=>row[0]==='presence' && row[1]==='available'))
  assert.ok(sent.some(row=>row[1]==='composing'))
  const dm={remoteJid:'900003@lid',id:'dm'}, group={remoteJid:'group@g.us',id:'g'}, status={remoteJid:'status@broadcast',id:'s'}
  await socket.readMessages([dm,group,status])
  await socket.sendReceipts([dm,group], 'read-self')
  await socket.sendReceipt(dm.remoteJid,undefined,['dm'],'read')
  await socket.sendReceipt(dm.remoteJid,undefined,['dm'],'inactive')
  await socket.sendReceipt(dm.remoteJid,'status@broadcast',['s'],'read')
  assert.equal(sent.find(row=>row[0]==='readMessages')[1].length,2)
  assert.equal(sent.find(row=>row[0]==='sendReceipts')[1].length,1)
  const receipts=sent.filter(row=>row[0]==='sendReceipt')
  assert.equal(receipts.length,2); assert.equal(receipts[0][4],'inactive'); assert.equal(receipts[1][2],'status@broadcast')
  assert.equal(intervals.length,1)
  ev.emit('connection.update',{connection:'close'}); assert.equal(intervals[0].closed,true)
  const count=sent.length; intervals[0].fn(); await settle(); assert.equal(sent.length,count)
})

test('factory enforces offline config on first pairing and replacement sockets', () => {
  const options=[], sockets=[]
  const Module={_load(){return {default:config=>{options.push(config);const s={ev:new EventEmitter()};sockets.push(s);return s}}}}
  const guard=load('lib/safful-mobile-notifications.js',{module:Module})
  guard.installMobileNotificationGuard()
  const factory=Module._load('@whiskeysockets/baileys',{filename:path.join(root,'lib/smd.js')}).default
  factory({markOnlineOnConnect:true,auth:{creds:{registered:false}}})
  factory({markOnlineOnConnect:true,auth:{creds:{registered:true}}})
  assert.ok(options.every(config=>config.markOnlineOnConnect===false))
  assert.ok(sockets.every(socket=>socket.__saffulMobileNotificationsGuard))
})

test('non-admin LID roster resolves saved contacts stored under PN or LID keys', async () => {
  const identities=require('../lib/safful-identities')
  const vcf=load('plugins/vcf.js',{'../lib/plugins':{cmd(){}},'../lib/safful-identities':identities})
  const socket={signalRepository:{lidMapping:{getPNForLID:async()=>undefined}}}
  const metadata={subject:'Team',participants:[{id:'233240000001@s.whatsapp.net'},{id:'900003@lid'}, {id:'900004:3@lid'}, {id:'900005@lid'}]}
  const store={contacts:{
    '233240000003@s.whatsapp.net':{id:'233240000003@s.whatsapp.net',lid:'900003@lid',name:'Ama'},
    '900004@lid':{id:'900004@lid',phoneNumber:'233240000004@s.whatsapp.net',name:'Kojo'},
  }}
  const {rows,unresolved}=await vcf.collectContacts(socket,metadata,store)
  assert.equal(rows.length,3); assert.equal(unresolved,1)
  assert.equal(rows[1].name,'Ama'); assert.equal(rows[2].number,'233240000004')
})

test('passive contact updates and observed sender mappings remain available without admin permissions', async () => {
  const ids=require('../lib/safful-identities'), stored=[]
  const socket={ev:new EventEmitter(),signalRepository:{lidMapping:{storeLIDPNMappings:async pairs=>stored.push(...pairs)}}}
  ids.attachContactCache(socket); ids.attachContactCache(socket)
  socket.ev.emit('contacts.upsert',[{id:'233240000003@s.whatsapp.net',lid:'900003@lid',name:'Ama'}])
  socket.ev.emit('messages.upsert',{messages:[{key:{remoteJid:'team@g.us',participant:'900004@lid',participantAlt:'233240000004@s.whatsapp.net'},pushName:'Kojo'}]})
  await settle()
  assert.equal(await ids.resolvePhone(socket,'900003@lid'),'233240000003@s.whatsapp.net')
  assert.equal(await ids.resolvePhone(socket,'900004@lid'),'233240000004@s.whatsapp.net')
  assert.equal(stored.length,2)
  assert.equal(socket.ev.listenerCount('contacts.upsert'),1)
})

test('export falls back to participating roster and never includes unrelated groups', async () => {
  const ids=require('../lib/safful-identities'), sent=[]
  const vcf=load('plugins/vcf.js',{'../lib/plugins':{cmd(){}},'../lib/safful-identities':ids})
  const socket={user:{id:'233240000001@s.whatsapp.net'},sendMessage:async(...args)=>sent.push(args),
    groupMetadata:async()=>({id:'team@g.us',subject:'Team',size:2,participants:[{id:'233240000001@s.whatsapp.net'}]}),
    groupFetchAllParticipating:async()=>({
      'team@g.us':{id:'team@g.us',subject:'Team',participants:[{id:'233240000001@s.whatsapp.net'},{id:'900003@lid',phoneNumber:'233240000003@s.whatsapp.net'}]},
      'other@g.us':{participants:[{id:'233240000099@s.whatsapp.net'}]},
    }),
  }
  await vcf.exportContacts({chat:'team@g.us'},'',{Void:socket})
  assert.equal(sent.length,1)
  const file=sent[0][1].document.toString()
  assert.ok(file.includes('233240000003')); assert.ok(!file.includes('233240000099'))
})
