# 沉浸式场景

首页与沉浸式模块共用场景能力判断、播放和导出组件。按已验证的内容身份启用，
未知字节保留原图并显示失配提示；目录名相同不能证明资源兼容。
当前支持范围由内容和客户端配置共同决定，不把源码入口等同于线上可用。

## 播放约定

每场从零播放入场动作并停在结束姿态。人物通过姓名／描述按钮或画面点击独立重播，
不重置其他人物时钟。减少动态模式默认展示结束帧。完整点击剧情、语音和新动作
不属于此入场播放契约。

同一 Spine 内多人不能通过重置整套骨架实现独立重播。每个人独立采样完整 Skeleton，
按核对过的 slot 归属和原生 drawOrder 合成一个显示网格，保留遮挡；环境使用全场时钟。
物理动态固定 60 Hz 推进，分数帧只应用姿态，回退从初态重建。同帧多次渲染不重复积分。
导出和取消后恢复人物姿态，不宣称与原生客户端像素级一致。

相机按客户端 `SetParameter` / `CalculateOrbitPosition` 重建，终点为
`defaultPositionOffset - normalize(originalOffset - defaultPositionOffset) * orbitRatio`，
同时处理 Unity／Three 的 Z 方向。背景采用 YXZ 欧拉顺序；移动端适配完整视野，
不保证与原生手机裁切相同。

## 内容配置

`tools/build_immersive_client_profiles.py` 根据独立提供的受信资源生成
`site/src/lib/immersive-client-profiles.json`。该 JSON 是程序使用的配置，不能作为旧报告删除。
生成前核对 metadata、catalog、预制体与包装摘要；运行时继续验证 scene、Spine、
atlas 和贴图的字节。Global 配置不能直接套用 JP，新增或变更内容须重新审阅绑定。

```sh
python3 tools/build_immersive_client_profiles.py \
  --resources-root /PRIVATE_RESOURCES \
  --package-root /PRIVATE_IMMERSIVE_PACKAGE \
  --output site/src/lib/immersive-client-profiles.json \
  --report output/verification/immersive-profiles.json
```

缺少主表角色的可见配角使用独立网页身份和已核对文本，不凭预制体角色编号猜测身份，
不修改 Master。共用骨架的附属层只绑定实际存在的 slot。

验证应覆盖全部受支持场景、每个人物重播、结束帧、键盘、窄屏、字节失配、WebGL
中断恢复、PNG／WebM 导出及取消后的姿态恢复。Safari、真实手机、JP 独立绑定与原生
对照尚需按[未结事项](../BACKLOG.md)核对，不能沿用旧 Chrome 验收扩大覆盖。
