import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createScoreReplay, replayScoreTimeline, createScoreTimelineReplay, liveSkillCommands } from '../src/lib/scoring-rules/formal-score-replay.mjs';

const scoreNote = (_note, state) => ({ score: Math.floor(state.general * 1000000), factor: state.general });
const engine = () => createScoreReplay({ musicLengthMs: 1000, scoreNote });

test('compiled note arrivals preserve rollback, phases, empty frames and independent repeated runs',()=>{
 const events=Object.freeze([2,16,25,36,79,117,147,150,500].map((timeMs,sourceIndex)=>Object.freeze({timeMs,sourceIndex})));
 for(const frameRate of [30,60,120]){
  const run=createScoreTimelineReplay(events,frameRate);
  for(let seed=1;seed<=20;seed++){
   const commands=[0,1,2].flatMap(slot=>{
    const timeMs=(seed*31+slot*13)%100,rate=Math.fround((seed+slot)*.13),phase=['before','skill','after'][slot];
    return [{timeMs,arrivalTimeMs:timeMs+17,ownerId:slot*100+1,general:rate,phase},
      {timeMs:timeMs+95,arrivalTimeMs:timeMs+121,ownerId:slot*100+1,general:-rate,phase}];
   });
   for(const retainNotes of [false,true]){
    const expected=replayScoreTimeline({events,commands,frameRate,scoreNote,retainNotes});
    const actual=run({commands,scoreNote,retainNotes});
    assert.equal(actual.score,expected.score);
    assert.deepEqual(actual.notes,expected.notes);assert.deepEqual(actual.state,expected.state);
    for(const time of [0,80,300,500])assert.equal(actual.calculate(time),expected.calculate(time));
   }
  }
 }
});

test('bucket rollback matches vectors executed with the client ARM64 UndoDiff leaf', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/formal-score-undo-native.json', import.meta.url)));
  assert.equal(fixture.vectors.length, 32);
  for (const v of fixture.vectors) {
    const r = engine();
    for (const general of v.deltas) r.addFactor({ timeMs: 1, ownerId: 1, general });
    r.calculate(40); assert.equal(r.state.general, v.before);
    r.calculate(0); assert.equal(r.state.general, v.after);
  }
});

test('late factor recomputes already scored notes in its bucket, preserving exact timestamps', () => {
  const r = engine();
  r.addNote({ timeMs: 10, sourceIndex: 0 });
  r.addNote({ timeMs: 30, sourceIndex: 1 });
  assert.equal(r.calculate(40), 2000000);
  r.addFactor({ timeMs: 20, ownerId: 1, general: 1 });
  assert.equal(r.calculate(40), 3000000);
  assert.deepEqual(r.notes.map(n => n.result.score), [1000000, 2000000]);
  assert.equal(r.calculate(40), 3000000);
});

test('same timestamp uses owner then insertion, factors precede notes; no ends-first rule', () => {
  const r = engine();
  r.addFactor({ timeMs: 0, ownerId: 1, general: Math.fround(.3) });
  r.addFactor({ timeMs: 40, ownerId: 101, general: -Math.fround(.3) });
  r.addFactor({ timeMs: 40, ownerId: 1, general: 1 });
  r.addNote({ timeMs: 40, sourceIndex: 0 });
  r.calculate(40);
  assert.equal(r.notes[0].result.factor, 2);
});

test('rewind subtracts the accumulated float32 bucket delta, never restores a snapshot', () => {
  const r = engine();
  r.addFactor({ timeMs: 1, ownerId: 1, general: Math.fround(.3) });
  r.calculate(40);
  r.calculate(0);
  assert.equal(r.state.general, 0.9999999403953552);
  r.addNote({ timeMs: 0, sourceIndex: 0 });
  assert.equal(r.calculate(0), 999999);
  assert.equal(r.calculate(40), 999999);
});

test('rollback uses one bucket sum, not individual reverse operations', () => {
  const r = engine();
  for (const general of [Math.fround(.3), Math.fround(.7)]) r.addFactor({ timeMs: 1, ownerId: 1, general });
  r.calculate(40);
  r.calculate(0);
  assert.equal(r.state.general, 1); // sum32(.3,.7)=1; state32(1+.3+.7)=2.
});

test('a late note invalidates a bucket and is scored once; boundary reads include whole buckets', () => {
  const r = engine();
  r.addNote({ timeMs: 39, sourceIndex: 0 });
  assert.equal(r.calculate(1), 1000000);
  r.addNote({ timeMs: 5, sourceIndex: 1 });
  assert.equal(r.calculate(39), 2000000);
  assert.equal(r.calculate(0), 0);
  assert.equal(r.calculate(40), 2000000);
});

test('pending fixed score is applied once and participates in rewind/forward', () => {
  const r = engine();
  r.addFixedScore({ timeMs: 40, score: 10 });
  r.addFixedScore({ timeMs: 40, score: 20 });
  assert.equal(r.calculate(40), 20);
  assert.equal(r.calculate(40), 20);
  assert.equal(r.calculate(0), 0);
  assert.equal(r.calculate(40), 20);
});

test('ideal clock advances empty frames before late arrivals and retains source owners', () => {
  const r = replayScoreTimeline({ events: [{ timeMs: 20, sourceIndex: 0 }, { timeMs: 35, sourceIndex: 1 }],
    commands: [{ timeMs: 0, arrivalTimeMs: 0, ownerId: 1, general: Math.fround(.3) },
      { timeMs: 25, arrivalTimeMs: 50, ownerId: 1, general: -Math.fround(.3) }], frameRate: 60, scoreNote });
  assert.equal(r.notes[0].result.factor, 1.2999999523162842);
  assert.equal(r.notes[1].result.factor, 0.9999999403953552);
  const skills = Array.from({ length: 5 }, () => ({ liveEffects: [{ active: true, type: 2000, rate: .3, durationMs: 100 }] }));
  const commands = liveSkillCommands([4, 3, 2, 1, 0], skills, [0, 1000, 2000, 3000, 4000], 60);
  assert.equal(commands[0].ownerId, 401);
  assert.equal(commands[1].timeMs, 100);
  assert.ok(commands[1].arrivalTimeMs > 100);
});

test('fractional duration ends on the first integer clock past the raw duration', () => {
  const skills = [{ liveEffects: [{ active: true, type: 2000, rate: 1, durationRawMs: 99.1, durationMs: 100 }] }];
  const commands = liveSkillCommands([0], skills, [0], 60);
  assert.equal(commands[1].timeMs, 100);
  assert.equal(commands[1].arrivalTimeMs, 100);
});

test('early input waits for its authored score bucket and high timestamps clamp to allocated tail', () => {
  const r = replayScoreTimeline({ events: [{ timeMs: 80, inputFrame: 0 }], commands: [], scoreNote });
  assert.equal(r.score, 1000000);
  const e = engine();
  e.addNote({ timeMs: 100000, sourceIndex: 0 });
  assert.equal(e.calculate(100000), 1000000);
  assert.equal(e.calculate(-10), 0);
  assert.equal(e.calculate(100000), 1000000);
});

test('captured native note IDs override projection order for simultaneous notes', () => {
  const seen = [];
  const r = createScoreReplay({ musicLengthMs: 100, scoreNote: n => { seen.push(n.nativeNoteId); return { score: 1 }; } });
  r.addNote({ timeMs: 40, sourceIndex: 0, nativeNoteId: 20 });
  r.addNote({ timeMs: 40, sourceIndex: 1, nativeNoteId: 10 });
  assert.equal(r.calculate(40), 2);
  assert.deepEqual(seen, [10, 20]);
  assert.throws(() => r.calculate(NaN), /timestamp/);
  assert.throws(() => createScoreReplay({ musicLengthMs: -1, scoreNote }), /length/);
});

test('input score then skill rescore retains the native same-frame subtraction residue', () => {
  const commands = [[61,121,1.84],[58,79,1.09],[27,61,1.66]].flatMap(([start,end,rate],slot) => [
    { timeMs:start, ownerId:slot*100+1, general:Math.fround(rate) },
    { timeMs:end, ownerId:slot*100+1, general:-Math.fround(rate) }]);
  const r = replayScoreTimeline({ events:[2,16,25,36,79,117,147,150].map(timeMs=>({timeMs})), commands, scoreNote });
  // Synthetic overlapping rates exercise repeated UndoDiff calls. The old
  // single-pass frame produced 13,339,996 by merging input and skill arrival.
  assert.deepEqual(r.notes.map(n=>n.result.score), [999999,999999,999999,2659999,2840001,2840001,1000001,1000001]);
  assert.equal(r.score, 13340000);
});

test('historical section reads run start then end and leave the shared cursor there', () => {
  let section;
  const r = replayScoreTimeline({ events: [{ timeMs: 0 }, { timeMs: 40 }, { timeMs: 80 }, { timeMs: 200 }],
    commands: [{ timeMs: 40, ownerId: 1, general: Math.fround(.3) }], scoreNote,
    frameActions: [{ frame: 6, run(replay) {
      const startScore = replay.calculate(0), endScore = replay.calculate(80);
      section = { startScore, endScore, score: endScore - startScore };
      replay.addFixedScore({ timeMs: 80, score: 17 });
    } }] });
  assert.equal(section.startScore, 1000000);
  assert.equal(section.score, 2599998);
  assert.equal(r.score, r.notes.reduce((sum, n) => sum + n.result.score, 0) + 17);
  assert.equal(r.calculate(0), 1000000);
  assert.equal(r.calculate(200), r.notes.reduce((sum, n) => sum + n.result.score, 0) + 17);
});

test('Gekisou after-score changes wait for the next frame, including an empty frame', () => {
  const seen = [];
  const r = replayScoreTimeline({ events: [{ timeMs: 20 }],
    commands: [{ timeMs: 20, arrivalFrame: 2, phase: 'after', ownerId: -1, general: 1 }], scoreNote,
    frameActions: [2, 3].map(frame => ({ frame, run: replay => seen.push(replay.score) })) });
  assert.deepEqual(seen, [1000000, 2000000]);
  assert.equal(r.score, 2000000);
});

test('a delayed section reward cannot be credited twice by later historical queries', () => {
  const r = engine();
  r.addNote({ timeMs: 40 }); r.addNote({ timeMs: 200 });
  r.calculate(300);
  r.addFixedScore({ timeMs: 80, score: 100 });
  assert.equal(r.calculate(320), 2000100);
  assert.equal(r.calculate(0), 0);
  assert.equal(r.calculate(80), 1000100);
  assert.equal(r.calculate(320), 2000100);
  assert.equal(r.calculate(80), 1000100);
  assert.equal(r.calculate(320), 2000100);
});
