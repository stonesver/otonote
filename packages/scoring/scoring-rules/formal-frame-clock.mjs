const f32 = Math.fround;

/** Music timestamps and deltaTime are independent inputs in the client.
 * A supplied clock is a scenario, never an inferred device recording. */
export function createFrameClock({ frameRate = 60, frames = null, phaseMs = 0 } = {}) {
  if (![30, 60, 120].includes(frameRate)) throw new Error('模拟帧率须为 30、60 或 120');
  if (!Number.isFinite(phaseMs) || phaseMs < 0 || phaseMs >= 1000 / frameRate || frames && phaseMs !== 0) throw new Error('参考帧对齐无效');
  if (frames != null) {
    if (!Array.isArray(frames) || !frames.length || frames.length > 100000) throw new Error('无效的逐帧时钟');
    frames = frames.map((frame, i) => {
      if (!Number.isSafeInteger(frame.timeMs) || frame.timeMs < 0 || (i && frame.timeMs < frames[i - 1].timeMs) ||
          !Number.isFinite(frame.deltaSeconds) || frame.deltaSeconds < 0 || frame.deltaSeconds > 10) throw new Error(`无效的第 ${i} 帧`);
      return { timeMs: frame.timeMs, deltaSeconds: f32(frame.deltaSeconds) };
    });
  }
  function at(index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('无效的帧序号');
    if (frames && index >= frames.length) throw new Error('逐帧时钟未覆盖结算和技能结束，请补齐尾帧');
    return frames?.[index] ?? { timeMs: Math.floor(index * 1000 / frameRate + phaseMs), deltaSeconds: f32(1 / frameRate) };
  }
  function indexAt(timeMs) {
    if (!Number.isFinite(timeMs)) throw new Error('无效的输入时刻');
    if (!frames) return Math.max(0, Math.ceil((timeMs - phaseMs) * frameRate / 1000));
    let lo = 0, hi = frames.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].timeMs < timeMs) lo = mid + 1; else hi = mid; }
    at(lo);
    return lo;
  }
  return { at, indexAt, frameRate, frames, phaseMs, kind: frames ? 'explicit_frames' : 'ideal' };
}

// MusicStopwatch.Update 0x6a63bb8 / get_ElapsedMilliseconds 0x6a63b6c.
export const advanceStopwatch = (elapsed, deltaSeconds) => f32(f32(elapsed) + f32(deltaSeconds));
export const stopwatchMilliseconds = elapsed => Math.trunc(f32(f32(elapsed) * 1000));

// BeforeUpdate: state 5 accumulates the maximum late window; transition to 6
// resets the stopwatch. State 6 accumulates 500 ms, then 7; 8 is the next frame.
export function gekisouReleaseFrames(clock, endMs, lateWindowMs, completeDelayMs = 500) {
  const endFrame = clock.indexAt(endMs);
  let elapsed = 0, settleFrame, releaseFrame;
  for (let frame = endFrame + 1; frame < endFrame + 100000; frame++) {
    elapsed = advanceStopwatch(elapsed, clock.at(frame).deltaSeconds);
    if (settleFrame === undefined && stopwatchMilliseconds(elapsed) >= lateWindowMs) {
      settleFrame = frame; elapsed = 0;
    } else if (settleFrame !== undefined && stopwatchMilliseconds(elapsed) >= completeDelayMs) {
      releaseFrame = frame;
      clock.at(frame + 1);
      return { endFrame, settleFrame, releaseFrame };
    }
  }
  throw new Error('激奏等待时钟未推进到结算');
}

export function nativeSkillDuration(seconds, extensionMs = 0) {
  if (!Number.isFinite(seconds) || !Number.isFinite(extensionMs)) throw new Error('无效的技能时长');
  return f32(f32(f32(seconds) * 1000) + f32(extensionMs));
}

export function executingSkillEnd({ startMs, nowMs, seconds, extensionMs = 0, durationRawMs, force = false, musicLengthMs = 0 }) {
  const raw = durationRawMs ?? nativeSkillDuration(seconds, extensionMs);
  if (!force && !(seconds > 0 && raw < f32(nowMs - startMs))) return null;
  const finish = force ? nowMs : startMs + Math.ceil(raw);
  return musicLengthMs > 0 ? Math.min(finish, musicLengthMs) : finish;
}

/** Executing ends strictly AFTER duration; ExecuteFrame on the next update
 * ends on equality. A short effect that finishes in ExecuteFrame uses that
 * frame's timestamp, while normal expiry emits start + ceil(f32 duration). */
export function skillEndFrame(clock, startMs, durationRawMs, musicLengthMs = Infinity) {
  const startFrame = clock.indexAt(startMs), next = startFrame + 1;
  let frame, timeMs;
  if (f32(clock.at(next).timeMs - startMs) >= durationRawMs) {
    frame = next; timeMs = clock.at(next).timeMs;
  } else {
    frame = Math.max(next + 1, clock.indexAt(startMs + Math.floor(durationRawMs) + 1));
    timeMs = executingSkillEnd({ startMs, nowMs: clock.at(frame).timeMs, seconds: 1, durationRawMs });
  }
  return { frame, timeMs: Math.min(timeMs, musicLengthMs), startFrame };
}
