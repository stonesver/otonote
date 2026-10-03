# 服装全身静态图

游戏内服装图标只有上半身。服装列表使用从对应模型预先生成的透明 WebP，访问者只下载图片；Live2D 工作台仍按需加载模型。

## 生成

在开发机准备同一内容版本的 `costumes.json`、Live2D 清单、已发布内容库和外置 Cubism Core。安装站点锁定 Node 依赖及 Python Pillow，然后执行：

```sh
python -m tools.costume_poster_server \
  --costumes /PRIVATE/costumes.json \
  --models /PRIVATE/live2d-catalog.json \
  --content /PRIVATE/content \
  --core /PRIVATE/live2dcubismcore.min.js \
  --output output/costume-posters \
  --port 4420
```

打开终端显示的本机地址，点击生成。工具优先使用同角色、同服装名的剧情模型；没有对应剧情模型时，要求演出模型具有 `ParamInstrumentOff` 开关并关闭乐器。其他参数采用来源默认值，输出最长 800 像素的完整视图 WebP。不支持无乐器展示的模型应停止生成，不能混入带乐器图片。中断后可继续复用相同模型及展示模式已完成的图片；不同来源不能混入原暂存目录。完成后将暂存目录改名封存。私有资源和生成结果不提交 Git。

## 纳入内容候选

将封存目录放入内容生产程序可读取的输入根，并在该环境输入计划增加 `costumePosterInputs`，结构为 `{"root":"相对输入根的图片目录","sha256":"manifest.json 的 SHA-256"}`。重新生成内容候选。编译器校验清单、全部图片摘要以及对应模型来源后，将图片复制进 `public/costumes/posters/`，投影填写 `poster`。

素材相同的后续版本可以复用图片。模型来源摘要变化或新增服装时会显示图片待补充，重新生成并绑定图片后再验收，不将上一造型当作新造型。只缺少图片不会阻断既有资料；声明的清单或图片损坏则阻止候选产出。

发布前检查全部需要的服装均有主图，列表网络请求中没有 `.moc3`、模型纹理或播放器下载，并按正常流程发布同一验收候选。
