/** Resolve display conditions without changing the official regulation or its identity. */
export function resolveArenaCondition(condition, song=null) {
 if(!condition)return null;
 const original=song?.missions??[];
 const missions=condition.missions.map((type,i)=>type||([1,2,3].includes(original[i])?original[i]:null));
 const attribute=condition.attribute||([1,2,3,4,5,99].includes(song?.attribute)?song.attribute:null);
 return {attribute,missions,songDependent:condition.attribute===0||condition.missions.includes(0),
  songId:song?.id??null,resolved:attribute!==null&&missions.every(type=>[1,2,3].includes(type))};
}
