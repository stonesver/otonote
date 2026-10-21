// Archive traffic has a separate bounded wait; other workbench APIs keep 12s.
export async function request(path, options={}) {
 const archive=path.startsWith('/api/archive/'),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(new Error(archive?'归档请求超时，请重试；原件仍可下载。':'请求超时，请重试。')),archive?45000:12000);
 try {
  const response=await fetch(path,{...options,cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error(response.status===401?'认证已失效，请重新登录管理入口。':response.status===403?'当前入口不允许执行此操作。':response.status===409?'数据已变更或存在请求冲突，请刷新后核对。':response.status===400?'请求参数无效，请检查输入。':'请求未完成，请检查节点状态。');
  return await response.json();
 } finally {clearTimeout(timer);}
}
