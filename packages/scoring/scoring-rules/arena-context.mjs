/** Manual conditions are explicit until a versioned arena schedule is available.
 * Copy only song rows: power, skill targets and mission rewards share this view. */
export function applyArenaContext(rules, input) {
  const { bandId, musicType, missions, participantCount } = input;
  if (!rules.tables.Character.some(c => c._bandID === bandId)) throw Error('请选择有效乐队');
  if (![0, 1, 2, 3, 4, 5, 99].includes(musicType)) throw Error('舞台属性无效');
  if (!Array.isArray(missions) || missions.length !== 3 || missions.some(m => ![0, 1, 2, 3].includes(m))) throw Error('舞台需要三段任务');
  if (!Number.isInteger(participantCount) || participantCount < 2 || participantCount > 5) throw Error('对局人数应为 2–5 人');
  const context = { source: 'manual', bandId, musicType, missions: [...missions], participantCount };
  return { context, rules: { ...rules, tables: { ...rules.tables, LiveMusic: rules.tables.LiveMusic.map(song => ({
    ...song, _musicType: musicType || song._musicType,
    ...Object.fromEntries(missions.map((mission, i) => [`_gekisouMission${i + 1}`, mission || song[`_gekisouMission${i + 1}`]]))
  })) } } };
}
