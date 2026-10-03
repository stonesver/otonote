export const MODES = {
  'member-level': {label:'角色卡 · 等级', kind:'member', cols:6, x:147, y:122, dx:167.5, dy:214, w:148, h:194},
  'member-training': {label:'角色卡 · 特训', kind:'member', cols:6, x:147, y:122, dx:167.5, dy:214, w:148, h:194},
  support: {label:'留影卡', kind:'support', cols:4, x:170, y:120, dx:241.5, dy:146.5, w:216, h:121},
};

export function regions(width, height, mode) {
  const p=MODES[mode];
  if(!p)throw Error('请选择截图类型');
  const ratio=width/height;
  if(ratio<1.25 || ratio>2.5)throw Error('当前原型支持横屏列表截图，请使用未裁切的横屏截图');
  const normalizedHeight=Math.round(height*1280/width), result=[];
  // Grid is calibrated to this game-list layout. Partial cards are never inferred.
  for(let row=0;row<20;row++){
    const y=Math.round(p.y+row*p.dy);
    if(y+p.h>normalizedHeight-10)break;
    for(let col=0;col<p.cols;col++)result.push({x:Math.round(p.x+col*p.dx),y,w:p.w,h:p.h,row,col});
  }
  return result;
}

export function numericValue(text, mode, confidence=100) {
  const clean=String(text).trim();
  if(!/^\d{1,3}$/.test(clean) || confidence<45)return null;
  const value=Number(clean), max=mode==='member-training'?5:100;
  return Number.isInteger(value)&&value>=1&&value<=max?value:null;
}

export function mergeObservations(rows, catalog) {
  const allowed=new Map(catalog.cards.map(c=>[c.id,c]));
  const cards=new Map(), conflicts=[], excluded=[];
  for(const row of rows){
    if(!row.selected || !row.cardId){excluded.push(row.key);continue;}
    const identity=allowed.get(row.cardId);
    if(!identity || identity.kind!==row.kind)throw Error('卡牌不属于当前识别索引');
    const next=cards.get(row.cardId)??{id:row.cardId,kind:row.kind,observations:{},sources:[]};
    const fields=row.kind==='member'?['level','training','awakeningStars']:['level','supportPetals'];
    for(const field of fields){
      const value=row.observations[field];
      if(value===null || value===undefined || value==='')continue;
      const max=field==='level'?100:5;
      if(!Number.isInteger(value)||value<1||value>max)throw Error(`${identity.name}：养成数值无效`);
      if(next.observations[field]!==undefined&&next.observations[field]!==value){
        conflicts.push({id:row.cardId,field,values:[next.observations[field],value]});
      }else next.observations[field]=value;
    }
    next.sources.push(row.key);cards.set(row.cardId,next);
  }
  return {format:'otonote-image-observations',schemaVersion:1,sourceReleaseId:catalog.sourceReleaseId,
    region:catalog.region,requiresConfirmation:true,cards:[...cards.values()],conflicts,excluded,
    note:'Game observations only. Missing skills stay missing. Not a full inventory backup; never replace an inventory with this draft.'};
}
