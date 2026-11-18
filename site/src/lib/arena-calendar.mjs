/** Calendar dates use the page's explicit UTC+8 display zone, never the host zone. */
const DAY=86400000,OFFSET=8*3600000;
const stamp=value=>Date.parse(value);
export const arenaDateKey=value=>Number.isFinite(stamp(value))?new Date(stamp(value)+OFFSET).toISOString().slice(0,10):null;
const midnight=key=>Date.parse(key+'T00:00:00+08:00');
const shiftMonth=(month,by)=>{
 const [year,m]=month.split('-').map(Number);
 return new Date(Date.UTC(year,m-1+by,1)).toISOString().slice(0,7);
};
export function arenaCalendar(context,{now=Date.now(),month=null,day=null}={}) {
 const season=context?.season,from=stamp(season?.validFrom),until=stamp(season?.validUntil);
 if(!Number.isFinite(from)||!Number.isFinite(until)||from>=until||!context.schedule?.length)return null;
 const first=arenaDateKey(new Date(from).toISOString()).slice(0,7);
 const last=arenaDateKey(new Date(until-1).toISOString()).slice(0,7);
 const today=arenaDateKey(new Date(now).toISOString());
 const requested=/^\d{4}-\d{2}-\d{2}$/.test(day??'')&&arenaDateKey(day+'T12:00:00+08:00')===day?day:null;
 const initial=requested??(context.condition&&context.condition.id!==context.current?.id?arenaDateKey(context.condition.validFrom):today)??today;
 let shown=/^\d{4}-(0[1-9]|1[0-2])$/.test(month??'')?month:initial.slice(0,7);
 shown=shown<first?first:shown>last?last:shown;
 const [y,m]=shown.split('-').map(Number),date=new Date(Date.UTC(y,m-1,1));
 const offset=(date.getUTCDay()+6)%7;
 const count=Math.ceil((offset+new Date(Date.UTC(y,m,0)).getUTCDate())/7)*7;
 const allCells=Array.from({length:count},(_,i)=>{
  const key=new Date(Date.UTC(y,m-1,1-offset+i)).toISOString().slice(0,10);
  const start=midnight(key),end=start+DAY,lo=Math.max(start,from),hi=Math.min(end,until);
  const inSeason=lo<hi;
  const periods=context.schedule.filter(r=>stamp(r.validFrom)<hi&&stamp(r.validUntil)>lo)
   .sort((a,b)=>stamp(a.validFrom)-stamp(b.validFrom));
  const starts=periods.filter(r=>arenaDateKey(r.validFrom)===key);
  const rows=starts.length?starts:periods;
  let cursor=lo,conflict=false,gap=false;
  for(const r of periods){const a=Math.max(lo,stamp(r.validFrom)),b=Math.min(hi,stamp(r.validUntil));
   if(a<cursor)conflict=true;if(a>cursor)gap=true;cursor=Math.max(cursor,b);
  }
  gap=gap||cursor<hi;
  return {key,date:Number(key.slice(-2)),inMonth:key.startsWith(shown),inSeason,
   today:key===today,rows,primary:conflict?null:rows.at(-1)??null,conflict,gap:inSeason&&gap};
 });
 // Keep incomplete recorded days, but omit whole weeks outside the season.
 const cells=Array.from({length:count/7},(_,i)=>allCells.slice(i*7,i*7+7))
  .filter(week=>week.some(c=>c.inSeason&&c.inMonth)).flat();
 const selected=cells.find(c=>c.key===initial&&c.inMonth&&c.inSeason)
  ??cells.find(c=>c.today&&c.inMonth&&c.inSeason)??cells.find(c=>c.inMonth&&c.inSeason);
 const invalidDay=day!=null&&!requested;
 const outsideSeason=requested&&(midnight(requested)>=until||midnight(requested)+DAY<=from);
 return {month:shown,invalidDay,outsideSeason:Boolean(outsideSeason),previous:shown>first?shiftMonth(shown,-1):null,next:shown<last?shiftMonth(shown,1):null,
  today,selected,cells};
}

/** A compact week preserves the monthly date semantics and exact period details. */
export function arenaCalendarWeek(context,model){
 if(!model?.selected)return {cells:[],previous:null,next:null};
 const index=model.cells.findIndex(c=>c.key===model.selected.key),start=index-index%7;
 const cells=model.cells.slice(start,start+7);
 const from=stamp(context.season.validFrom),until=stamp(context.season.validUntil);
 const adjacent=delta=>{
  const lo=midnight(cells[0].key)+delta*DAY,hi=lo+7*DAY;
  if(hi<=from||lo>=until)return null;
  return arenaDateKey(new Date(Math.max(lo,from)).toISOString());
 };
 return {cells,previous:adjacent(-7),next:adjacent(7)};
}
