import {eventTimestamp} from './event-time.mjs';

/** Show the next relevant boundary for the current event phase. */
export function homeEventTiming(start, end, now = Date.now(), en = false) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {state: 'unknown', label: en ? 'Schedule unavailable' : '时间待确认', endLabel: ''};
  }
  if (now >= end) return {state: 'ended', label: en ? 'Ended' : '已结束', endLabel: ''};
  const duration = target => {
    const minutes = Math.ceil((target - now) / 60000);
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
    if (days) return en ? `${days}d ${hours}h` : `${days}天 ${hours}小时`;
    if (hours) return en ? `${hours}h ${mins}m` : `${hours}小时 ${mins}分`;
    return en ? `${minutes}m` : `${minutes}分钟`;
  };
  const upcoming = now < start;
  return {
    state: upcoming ? 'upcoming' : 'active',
    label: upcoming ? (en ? `Starts in ${duration(start)}` : `距开始 ${duration(start)}`) : (en ? 'Live now' : '进行中'),
    endLabel: upcoming ? '' : (en ? `Ends in ${duration(end)}` : `距结束 ${duration(end)}`)
  };
}
export function scheduleLabel(start, end, now, en = false, card = false) {
  if(start !== null && start > now)return en ? 'Upcoming' : '即将登场';
  if(card)return en ? 'In collection' : '已收录';
  if(end !== null && end <= now)return en ? 'Ended' : '已结束';
  if(start !== null && end !== null)return en ? 'Live now' : '进行中';
  return en ? 'Schedule' : '活动日程';
}
/** @template {{id:number,name:string,schedule:{startAt:string|null,endAt:string|null,timeZone?:string|null}}} T @param {T[]} events @returns {(T & {start:number|null,end:number|null})[]} */
export function homeEvents(events, region, now = Date.now(), limit = 2) {
  const rows=events.map(event=>({...event,start:eventTimestamp(event.schedule.startAt,region,event.schedule.timeZone),end:eventTimestamp(event.schedule.endAt,region,event.schedule.timeZone)}));
  const priority=event=>event.start!==null&&event.end!==null&&event.start<=now&&event.end>now?0:event.start!==null&&event.start>now?1:2;
  return rows.sort((a,b)=>priority(a)-priority(b)||(priority(a)===1?(a.start??0)-(b.start??0):(b.start??0)-(a.start??0))).slice(0,limit);
}
