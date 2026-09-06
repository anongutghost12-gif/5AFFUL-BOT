'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm')
const { EventEmitter } = require('events')

function setup(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoview-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  if (saved) fs.writeFileSync(file, JSON.stringify(saved))
  let now = 100000
  const timers = new Map(), globals = {}, commands = []
  const env = { SAFFUL_AUTOVIEW_FILE: file, STATUS_VIEW_INTERVAL: '0' }
  function load(relative, mocks) {
    const filename = path.resolve(__dirname, '..', relative), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: name => name in mocks ? mocks[name] : require(name), module, exports: module.exports,
      __dirname: path.dirname(filename), __filename: filename,
      process: { env }, global: globals, console: { log() {}, error() {} },
      Date: class extends Date { static now() { return now } },
      setTimeout: (fn, delay) => { const timer = { unref() {} }; timers.set(timer, {fn,at:now+delay}); return timer },
      clearTimeout: timer => timers.delete(timer),
    }, { filename })
    return module.exports
  }
  const plugins = { smd() {}, cmd: (options, fn) => commands.push({options,fn}) }
  const engine = load('plugins/statusauto.smd', {'../lib/plugins':plugins,'../lib/safful-status-save':{attach(){}}})
  load('plugins/autoview.js', {'../lib/plugins':plugins,'./statusauto.smd':engine,
    '../lib/safful-identities':{isOperator:async m=>Boolean(m.fromMe)}})
  function socket() {
    const s={ev:new EventEmitter(), receipts:[], sendReceipt:async(...args)=>s.receipts.push(args)}
    return s
  }
  async function tick(ms) {
    now+=ms
    for(let count=0;count<20;count++) {
      const next=[...timers].find(([,task])=>task.at<=now)
      if(!next) return
      timers.delete(next[0]); next[1].fn()
      await new Promise(resolve=>setImmediate(resolve))
    }
    throw new Error('Timer loop did not settle')
  }
  return {engine,socket,tick,globals,commands,file}
}
function status(id) { return {key:{id,remoteJid:'status@broadcast',participant:'900003@lid',participantAlt:'233240000003@s.whatsapp.net',fromMe:false},message:{conversation:'status'}} }
const settle = () => new Promise(resolve=>setImmediate(resolve))

test('on views immediately using correct broadcast receipt; duplicates are skipped',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('on')
  s.ev.emit('messages.upsert',{messages:[status('a')]});await settle()
  assert.equal(s.receipts.length,1);assert.equal(s.receipts[0][0],'status@broadcast');assert.equal(s.receipts[0][1],'900003@lid');assert.equal(s.receipts[0][3],'read')
  s.ev.emit('messages.upsert',{messages:[status('a')]});await settle();assert.equal(s.receipts.length,1)
})

test('1-10 minute delays are accepted; delay waits, off cancels and zero changes nothing',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s)
  for(let i=1;i<=10;i++)assert.equal(h.engine.setMode(String(i)),String(i))
  h.engine.setMode('1');s.ev.emit('messages.upsert',{messages:[status('delayed')]})
  await h.tick(59999);assert.equal(s.receipts.length,0)
  await h.tick(1);assert.equal(s.receipts.length,1)
  s.ev.emit('messages.upsert',{messages:[status('cancelled')]});h.engine.setMode('off')
  await h.tick(600000);assert.equal(s.receipts.length,1)
  assert.throws(()=>h.engine.setMode('0'));assert.equal(h.engine.getMode(),'off')
  assert.throws(()=>h.engine.setMode('11'));assert.throws(()=>h.engine.setMode('1.5'))
})

test('switching to on views queued statuses; pause prevents delayed viewing until resumed',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('10')
  s.ev.emit('messages.upsert',{messages:[status('switch')]});h.engine.setMode('on');await h.tick(0);assert.equal(s.receipts.length,1)
  h.engine.setMode('1');s.ev.emit('messages.upsert',{messages:[status('pause')]});h.globals.saffulChatbotPaused=true
  await h.tick(60000);assert.equal(s.receipts.length,1)
  h.globals.saffulChatbotPaused=false;await h.tick(1000);assert.equal(s.receipts.length,2)
})

test('overlapping instant batches do not duplicate receipts; failures retry on replacement socket',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('on')
  let release;const gate=new Promise(resolve=>{release=resolve})
  s.sendReceipt=async(...args)=>{s.receipts.push(args);await gate}
  s.ev.emit('messages.upsert',{messages:[status('one')]});s.ev.emit('messages.upsert',{messages:[status('two')]})
  assert.equal(s.receipts.length,1);release();await settle();await h.tick(0);assert.equal(s.receipts.length,2)
  s.sendReceipt=async()=>{throw new Error('connection lost')}
  s.ev.emit('messages.upsert',{messages:[status('retry')]});await settle()
  s.ev.emit('connection.update',{connection:'close'})
  const replacement=h.socket();h.engine.attach(replacement);replacement.ev.emit('connection.update',{connection:'open'})
  await h.tick(30000);assert.equal(replacement.receipts.length,1)
})

test('legacy off/delay settings load; command on/off persist and rejects zero or unauthorized users',async t=>{
  const h=setup(t,{minutes:0}),s=h.socket(),replies=[]
  assert.equal(h.engine.getMode(),'off')
  const run=h.commands[0].fn,m={fromMe:true,reply:async text=>replies.push(text)}
  await run(m,'on',{Void:s});assert.equal(h.engine.getMode(),'instant');assert.equal(JSON.parse(fs.readFileSync(h.file)).mode,'instant')
  await run(m,'0',{Void:s});assert.equal(h.engine.getMode(),'instant');assert.match(replies.at(-1),/no longer supported/)
  await run({fromMe:false,reply:m.reply},'off',{Void:s,ownerNumber:'233240000001'});assert.equal(h.engine.getMode(),'instant')
  await run(m,'off',{Void:s});assert.equal(h.engine.getMode(),'off')
  const delayed=setup(t,{minutes:7});assert.equal(delayed.engine.getMode(),'7')
})
