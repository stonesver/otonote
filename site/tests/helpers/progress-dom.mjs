/** Minimal progress DOM for controller tests; workers and inputs remain test-owned. */
export function installProgressDom(t,anchor) {
 const previous=globalThis.document;
 globalThis.document={createElement:()=>({dataset:{},children:[],append(...nodes){this.children.push(...nodes);},setAttribute(){},removeAttribute(){}})};
 anchor.before=node=>{anchor.progressNode=node;};
 t.after(()=>{if(previous)globalThis.document=previous;else delete globalThis.document;});
}
