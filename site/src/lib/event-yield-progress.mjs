/** Search nodes have no fixed total: report the outer proof and live frontier
 * separately instead of displaying a growing counter as N / …. */
export function eventYieldWorkerProgress(message,elapsedMs){
 const p=message.detail,format=n=>Number(n).toLocaleString('zh-CN');
 const visited=message.parallelGoals?.length
  ?message.parallelGoals.reduce((sum,goal)=>sum+(goal.visited??0),0):p?.visited;
 const label=p?.phase==='event-group-proof'&&Number.isInteger(visited)
  ?`验证最优收益 · 已检查 ${format(visited)} 个分支`:undefined;
 let detail=typeof p==='object'&&p?`${message.stage} ${p.completed??''} / ${p.total??'…'}`:p;
 if(p?.phase==='event-group-proof'){
  const parts=[message.goal==='eventPoints'?'活动 pt':message.goal==='badges'?'道具':message.goal==='grade'?'档位优先':'完整比较'];
  if(Number.isInteger(p.group)&&p.groups>0)parts.push(`搜索组 ${p.group} / ${p.groups}（已完成 ${p.groupsCompleted??p.group-1} 组）`);
  if(p.leaderTotal>0)parts.push(`当前组队长 ${p.leader} / ${p.leaderTotal}`);
  if(Number.isInteger(p.visited))parts.push(`已检查 ${format(p.visited)} 个分支`);
  if(Number.isInteger(p.frontier))parts.push(`当前队长待检查 ${format(p.frontier)} 个分支`);
  parts.push(`已用时 ${format(Math.floor(Math.max(0,elapsedMs)/1000))} 秒`,'分支总量动态变化，仍在证明最优性');
  detail=parts.join(' · ');
 }
 if(message.parallelGoals?.length>1){
  detail=message.parallelGoals.map(p=>{const name=p.goal==='eventPoints'?'活动 pt':'道具';return p.groups>0?`${name}：${p.groupsCompleted??0} / ${p.groups} 组完成，已检查 ${format(p.visited??0)} 个分支`:`${name}：准备与复算候选`;}).join(' · ')+` · 已用时 ${format(Math.floor(Math.max(0,elapsedMs)/1000))} 秒`;
 }
 if(message.parallelism>1)detail=`${message.parallelism} 个计算线程 · ${detail??'准备完整计算'}`;
 return {...message,title:message.title??'所有候选歌曲',detail,...(label?{label}:{})};
}
