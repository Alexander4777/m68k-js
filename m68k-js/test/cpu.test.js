import test from 'node:test';
import assert from 'node:assert/strict';
import { M68K, MemoryBus, M68K_REG } from '../src/index.js';

function setup(words) {
  const ram=new Uint8Array(0x10000), bus=new MemoryBus().map(0,ram), cpu=new M68K({bus});
  words.forEach((w,i)=>{ram[i*2]=w>>>8;ram[i*2+1]=w&255;});
  ram[0]=0;ram[1]=0;ram[2]=0x20;ram[3]=0;ram[4]=0;ram[5]=0; cpu.reset();
  return {cpu,ram};
}
test('reset reads SSP and PC',()=>{ const {cpu}=setup([0x4e71]); assert.equal(cpu.r.a7,0x2000); assert.equal(cpu.getReg(M68K_REG.SP),0x2000); assert.equal(cpu.r.pc,0); });
test('snapshot restores registers',()=>{ const {cpu}=setup([0x4e71]); cpu.r.d[0]=0x12345678; const s=cpu.snapshot(); cpu.r.d[0]=0; cpu.restore(s); assert.equal(cpu.r.d[0],0x12345678); });
