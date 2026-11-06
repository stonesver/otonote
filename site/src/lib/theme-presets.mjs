export const DEFAULT_THEME = 'paper';

// Palette tokens only. Derived tokens stay in CSS; game colors keep their own identities.
export const THEME_PRESETS = [
  {
    id: 'paper', group: 'everyday',
    name: { 'zh-CN': '暖纸', en: 'Warm paper' },
    description: { 'zh-CN': '米白纸面与梅紫点缀', en: 'Warm ivory with plum accents' },
    tokens: {
      'color-scheme': 'light',
      text: '#11131b', 'text-soft': '#1b1e29', canvas: '#f0eee8', surface: '#fffdf7', 'surface-deep': '#dfdcd3',
      accent: '#7a3155', 'accent-bright': '#a14a73', secondary: '#79aec2', 'secondary-ink': '#315f73',
      border: '#c5c1ba', muted: '#655e63', 'on-accent': '#fff',
      warning: '#9a6a2f', 'warning-ink': '#714a1e', success: '#3e755d', 'success-ink': '#1f5b40', danger: '#ad4259', 'danger-ink': '#8c2941',
      'inverse-surface': '#1b1e29', 'inverse-text': '#fffdf7', 'inverse-muted': '#c5c1ba',
      'media-shade': '#080a10', 'media-text': '#fff', 'shadow-color': '#11131b', 'chart-5': '#7764a3',
    },
  },
  {
    id: 'night', group: 'everyday',
    name: { 'zh-CN': '蓝调夜场', en: 'Midnight blue' },
    description: { 'zh-CN': '深蓝夜色与柔和蓝光', en: 'Deep navy with a soft blue glow' },
    tokens: {
      'color-scheme': 'dark',
      text: '#eef3ff', 'text-soft': '#d4e0f2', canvas: '#0c1220', surface: '#131e31', 'surface-deep': '#1c2b43',
      accent: '#9fafff', 'accent-bright': '#c0cbff', secondary: '#72b8d1', 'secondary-ink': '#95d6ec',
      border: '#40516e', muted: '#a6b5cc', 'on-accent': '#101829',
      warning: '#e6b967', 'warning-ink': '#f3ce8a', success: '#83c5a2', 'success-ink': '#b4e3c8', danger: '#ef91a2', 'danger-ink': '#ffb2c0',
      'inverse-surface': '#070c16', 'inverse-text': '#edf3ff', 'inverse-muted': '#a9b6cc',
      'media-shade': '#030712', 'media-text': '#fff', 'shadow-color': '#02050b', 'chart-5': '#c8a6e8',
    },
  },
  {
    id: 'mist', group: 'everyday',
    name: { 'zh-CN': '青蓝晨雾', en: 'Morning mist' },
    description: { 'zh-CN': '清冷雾白与青蓝层次', en: 'Cool whites with teal and blue' },
    tokens: {
      'color-scheme': 'light',
      text: '#152e37', 'text-soft': '#294550', canvas: '#eaf1f3', surface: '#f7fbfc', 'surface-deep': '#d5e4e8',
      accent: '#246274', 'accent-bright': '#347889', secondary: '#77afc0', 'secondary-ink': '#345c85',
      border: '#adbec6', muted: '#4f646f', 'on-accent': '#fff',
      warning: '#916323', 'warning-ink': '#6f4d20', success: '#3b725e', 'success-ink': '#245e49', danger: '#a3475a', 'danger-ink': '#852e43',
      'inverse-surface': '#1c333f', 'inverse-text': '#f0f8fb', 'inverse-muted': '#bacdd6',
      'media-shade': '#071923', 'media-text': '#fff', 'shadow-color': '#122c36', 'chart-5': '#6b609e',
    },
  },
  {
    id: 'new-year', group: 'occasion',
    name: { 'zh-CN': '新岁朱金', en: 'New Year vermilion' },
    description: { 'zh-CN': '暖绢底色与朱红金彩', en: 'Warm silk, vermilion and antique gold' },
    tokens: {
      'color-scheme': 'light',
      text: '#351f1d', 'text-soft': '#553936', canvas: '#faf0e3', surface: '#fffaf1', 'surface-deep': '#ebdbc7',
      accent: '#a3312f', 'accent-bright': '#b83c36', secondary: '#cba55f', 'secondary-ink': '#7b581e',
      border: '#cfb69e', muted: '#705a52', 'on-accent': '#fff',
      warning: '#92611b', 'warning-ink': '#774b15', success: '#49715a', 'success-ink': '#315c43', danger: '#ab3340', 'danger-ink': '#8f2330',
      'inverse-surface': '#3e2020', 'inverse-text': '#fff3df', 'inverse-muted': '#ddc6af',
      'media-shade': '#210c0d', 'media-text': '#fff', 'shadow-color': '#351b18', 'chart-5': '#8a5c79',
    },
  },
  {
    id: 'christmas', group: 'occasion',
    name: { 'zh-CN': '松绿暖金', en: 'Evergreen Christmas' },
    description: { 'zh-CN': '深松绿与温暖灯金', en: 'Deep evergreen with warm golden light' },
    tokens: {
      'color-scheme': 'dark',
      text: '#f5f2e6', 'text-soft': '#e4e6d7', canvas: '#0c1d1a', surface: '#142d27', 'surface-deep': '#1d3c32',
      accent: '#e0bd73', 'accent-bright': '#f1d49c', secondary: '#92b5a3', 'secondary-ink': '#a1d1b2',
      border: '#496858', muted: '#b1c2b6', 'on-accent': '#17271f',
      warning: '#e1b966', 'warning-ink': '#f2d49a', success: '#92cba4', 'success-ink': '#b5dfbf', danger: '#ee9b9b', 'danger-ink': '#ffc1bb',
      'inverse-surface': '#091510', 'inverse-text': '#fff7e7', 'inverse-muted': '#bfccb9',
      'media-shade': '#06100b', 'media-text': '#fff8eb', 'shadow-color': '#020b07', 'chart-5': '#d0a1be',
    },
  },
  {
    id: 'anniversary', group: 'occasion',
    name: { 'zh-CN': '周年星光', en: 'Anniversary starlight' },
    description: { 'zh-CN': '紫色夜幕与星光粉蓝', en: 'Violet skies with pink and blue starlight' },
    tokens: {
      'color-scheme': 'dark',
      text: '#f9f1ff', 'text-soft': '#e7d9f6', canvas: '#1b132b', surface: '#271d3b', 'surface-deep': '#34264d',
      accent: '#d4b2ff', 'accent-bright': '#e8d0ff', secondary: '#8dc2e3', 'secondary-ink': '#a7dbf3',
      border: '#605070', muted: '#c0adcf', 'on-accent': '#28173b',
      warning: '#edc17e', 'warning-ink': '#ffe0ac', success: '#a0d3b5', 'success-ink': '#c0ecd0', danger: '#f0a1b4', 'danger-ink': '#ffc1d0',
      'inverse-surface': '#110b20', 'inverse-text': '#fbf3ff', 'inverse-muted': '#c6b5d8',
      'media-shade': '#0c0615', 'media-text': '#fff', 'shadow-color': '#0b0515', 'chart-5': '#f2b4d2',
    },
  },
];
