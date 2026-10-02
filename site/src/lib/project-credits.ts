// Selected visitor-facing credits. Keep the versioned inventory in
// THIRD_PARTY_NOTICES.md in sync when dependencies change.
type Credit = { name: string; url: string; license: string; zh: string; en: string };

export const projectCreditGroups: { zh: string; en: string; projects: Credit[] }[] = [
  {
    zh: '页面与交互', en: 'Pages & interaction',
    projects: [
      { name: 'Astro', url: 'https://astro.build/', license: 'MIT',
        zh: '页面模板与静态构建。', en: 'Page templates and static builds.' },
      { name: 'TypeScript', url: 'https://www.typescriptlang.org/', license: 'Apache-2.0',
        zh: '页面逻辑与数据类型检查。', en: 'Page logic and data type checking.' },
      { name: 'Three.js', url: 'https://threejs.org/', license: 'MIT',
        zh: '演出场景中的 WebGL 渲染。', en: 'WebGL rendering for performance scenes.' },
      { name: 'PixiJS', url: 'https://pixijs.com/', license: 'MIT',
        zh: 'Live2D 预览的二维渲染基础。', en: '2D rendering for Live2D previews.' },
    ],
  },
  {
    zh: '角色与演出', en: 'Characters & performances',
    projects: [
      { name: 'pixi-live2d-display', url: 'https://github.com/guansss/pixi-live2d-display', license: 'MIT',
        zh: '连接 PixiJS 与 Live2D 模型。', en: 'Connects PixiJS to Live2D models.' },
      { name: 'Live2D Cubism Core', url: 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html', license: 'Live2D Proprietary Software License Agreement',
        zh: 'Live2D 模型运行库；需按官方许可另行获取，不随公开源码提供。',
        en: 'Live2D model runtime, obtained separately under its own terms; excluded from the public source.' },
      { name: 'Spine Runtimes', url: 'https://github.com/EsotericSoftware/spine-runtimes', license: 'Spine Runtimes License Agreement',
        zh: '通过 spine-threejs 播放骨骼动画，适用 Spine 专门许可。',
        en: 'Skeletal animation through spine-threejs, subject to the Spine runtime terms.' },
    ],
  },
  {
    zh: '内容与媒体处理', en: 'Content & media processing',
    projects: [
      { name: 'UnityPy', url: 'https://github.com/K0lb3/UnityPy', license: 'MIT',
        zh: '解析 Unity 资源并整理为站点可用内容。', en: 'Reads Unity assets for the content pipeline.' },
      { name: 'WannaCRI', url: 'https://github.com/donmai-me/WannaCRI', license: 'MIT',
        zh: '解析和提取 CRI USM 媒体。', en: 'Reads and extracts CRI USM media.' },
      { name: 'FFmpeg', url: 'https://ffmpeg.org/legal.html', license: 'LGPL / GPL',
        zh: '音视频转码与校验；具体许可取决于所用构建。', en: 'Media conversion and validation; the license depends on the build.' },
      { name: 'vgmstream', url: 'https://github.com/vgmstream/vgmstream', license: 'See COPYING',
        zh: '游戏音频解码；各组件许可见项目 COPYING。', en: 'Game audio decoding; see COPYING for component terms.' },
    ],
  },
  {
    zh: '查询与图片生成', en: 'Queries & image generation',
    projects: [
      { name: 'FastAPI', url: 'https://fastapi.tiangolo.com/', license: 'MIT',
        zh: '查询、管理和机器人服务的接口框架。', en: 'API framework for query, admin and bot services.' },
      { name: 'Uvicorn', url: 'https://www.uvicorn.org/', license: 'BSD-3-Clause',
        zh: '运行 Python Web 服务。', en: 'Runs the Python web services.' },
      { name: 'SQLite', url: 'https://sqlite.org/copyright.html', license: 'Public domain',
        zh: '查询数据库与服务状态存储。', en: 'Query databases and service state storage.' },
      { name: 'Pillow', url: 'https://python-pillow.org/', license: 'MIT-CMU',
        zh: '机器人回复图片的绘制与排版。', en: 'Renders and lays out bot reply images.' },
      { name: 'Noto Fonts', url: 'https://github.com/notofonts', license: 'OFL-1.1',
        zh: '机器人图片的中文与符号字体；字体许可按实际使用的文件保留。',
        en: 'CJK and symbol fonts for bot images, with notices retained for the files used.' },
    ],
  },
];
