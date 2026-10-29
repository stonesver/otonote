// A cycle shares the player's collection, not a selected formation or grade.
// Keep old callers compatible while allowing each stage its own constraints.
export function eventYieldStageInput(input,mode){
 if(mode!=='challenge'||input.mode!=='ordinary'||!input.includeChallenge)return {...input,mode};
 const bandScope=input.challengeBandScope??'all';
 if(!['all','same'].includes(bandScope))throw Error('无效的后续挑战乐队范围');
 const constraints={...input.constraints};
 if(bandScope!=='same'){delete constraints.bandId;delete constraints.supportBandId;}
 return {...input,mode,scope:input.challengeScope&&input.challengeScope!=='same'?input.challengeScope:input.scope,
   constraints,basis:input.challengeBasis??input.basis};
}

export function eventYieldChallengeBandNote(input,summary=''){
 if(input.mode!=='ordinary'||!input.includeChallenge)return '';
 return input.challengeBandScope==='same'
   ? `后续挑战：沿用普通阶段的乐队筛选（${summary||'当前不限乐队'}）。`
   : '后续挑战：不限乐队，不受普通阶段的成员和留影乐队筛选限制。';
}
