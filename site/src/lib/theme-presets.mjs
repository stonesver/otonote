export const DEFAULT_THEME = 'paper';

// Tinted canvases distinguish themes; content surfaces and text stay neutral.
// Derived tokens stay in CSS; game colors keep their own identities.
const lightPalette = {
  'color-scheme': 'light',
  text: '#242628', 'text-soft': '#414448', canvas: '#f5f5f4', surface: '#ffffff', 'surface-deep': '#e8eaeb',
  accent: '#34383b', 'accent-bright': '#50565b', secondary: '#9aa3aa', 'secondary-ink': '#535f68',
  border: '#ccd0d2', muted: '#62686d', 'on-accent': '#fff',
  warning: '#8a642b', 'warning-ink': '#76531f', success: '#3b6b4f', 'success-ink': '#2f583f', danger: '#a33f42', 'danger-ink': '#873033',
  'inverse-surface': '#26292c', 'inverse-text': '#f8f9f9', 'inverse-muted': '#bfc4c8',
  'media-shade': '#101214', 'media-text': '#fff', 'shadow-color': '#151719', 'chart-5': '#61758c',
};

export const THEME_PRESETS = [
  {
    id: 'paper', group: 'everyday',
    name: { 'zh-CN': '素白', en: 'White' },
    description: { 'zh-CN': '白 · 墨灰', en: 'White · Ink grey' },
    tokens: {...lightPalette},
  },
  {
    id: 'night', group: 'dark',
    name: { 'zh-CN': '夜间', en: 'Night' },
    description: { 'zh-CN': '炭灰 · 银白', en: 'Charcoal · Silver' },
    tokens: {
      'color-scheme': 'dark',
      text: '#eeeff0', 'text-soft': '#d0d3d5', canvas: '#191b1d', surface: '#222528', 'surface-deep': '#2d3135',
      accent: '#c4d0d3', 'accent-bright': '#e0e6e8', secondary: '#aebbc2', 'secondary-ink': '#becdd4',
      border: '#4c5155', muted: '#a9afb4', 'on-accent': '#202528',
      warning: '#d7b77c', 'warning-ink': '#e0c99e', success: '#93baa5', 'success-ink': '#b7d2c2', danger: '#dda4a6', 'danger-ink': '#ecc3c4',
      'inverse-surface': '#151719', 'inverse-text': '#f0f1f2', 'inverse-muted': '#b3b9be',
      'media-shade': '#0d0f10', 'media-text': '#fff', 'shadow-color': '#08090a', 'chart-5': '#b6b6c6',
    },
  },
  {
    id: 'mist', group: 'everyday',
    name: { 'zh-CN': '冷白', en: 'Cool white' },
    description: { 'zh-CN': '冷白 · 蓝与青灰', en: 'Cool white · Blue and muted teal' },
    tokens: {
      ...lightPalette, canvas: '#edf2f6',
      accent: '#215c9c', 'accent-bright': '#3d74ac', secondary: '#91b7bd', 'secondary-ink': '#3d6971',
    },
  },
  {
    id: 'apricot', group: 'everyday',
    name: { 'zh-CN': '暖白', en: 'Warm white' },
    description: { 'zh-CN': '杏白 · 砖红与灰绿', en: 'Apricot white · Brick red and grey green' },
    tokens: {
      ...lightPalette, canvas: '#f8f1e9',
      accent: '#8f4738', 'accent-bright': '#a55746', secondary: '#9eada9', 'secondary-ink': '#526963',
    },
  },
  {
    id: 'silver', group: 'everyday',
    name: { 'zh-CN': '石墨', en: 'Graphite' },
    description: { 'zh-CN': '灰白 · 钢灰与暖灰', en: 'Grey white · Steel grey and warm grey' },
    tokens: {
      ...lightPalette, canvas: '#edf0f3',
      accent: '#49575f', 'accent-bright': '#65737c', secondary: '#aba2a0', 'secondary-ink': '#675d59',
    },
  },
  {
    id: 'new-year', group: 'occasion',
    name: { 'zh-CN': '新年', en: 'New Year' },
    description: { 'zh-CN': '绢白 · 朱红与黄铜', en: 'Silk white · Vermilion and brass' },
    tokens: {
      ...lightPalette, canvas: '#faf1e6',
      accent: '#a13a2e', 'accent-bright': '#b24737', secondary: '#baa16f', 'secondary-ink': '#7a5b23',
    },
  },
  {
    id: 'christmas', group: 'occasion',
    name: { 'zh-CN': '圣诞', en: 'Christmas' },
    description: { 'zh-CN': '青白 · 松绿与红', en: 'Cool mint white · Pine green and red' },
    tokens: {
      ...lightPalette, canvas: '#edf5f3',
      accent: '#265c43', 'accent-bright': '#397456', secondary: '#bc4c43', 'secondary-ink': '#a23732',
    },
  },
  {
    id: 'anniversary', group: 'occasion',
    name: { 'zh-CN': '周年', en: 'Anniversary' },
    description: { 'zh-CN': '珍珠浅蓝 · 深蓝与金', en: 'Pearl blue · Navy and gold' },
    tokens: {
      ...lightPalette, canvas: '#eff3f9',
      accent: '#294c72', 'accent-bright': '#3c6085', secondary: '#b69a5e', 'secondary-ink': '#7b5d20',
    },
  },
  {
    id: 'attribute-red', group: 'attribute', attribute: 1,
    name: { 'zh-CN': '红赤', en: 'Red' },
    description: { 'zh-CN': '浅樱底 · 红赤与蓝灰', en: 'Pale cherry · Red and blue grey' },
    tokens: {
      ...lightPalette, canvas: '#f8edf1',
      accent: '#ad3455', 'accent-bright': '#bd4765', secondary: '#87a9b8', 'secondary-ink': '#416476',
    },
  },
  {
    id: 'attribute-azure', group: 'attribute', attribute: 2,
    name: { 'zh-CN': '绀碧', en: 'Azure' },
    description: { 'zh-CN': '浅蓝底 · 绀碧与沙色', en: 'Pale blue · Azure and sand' },
    tokens: {
      ...lightPalette, canvas: '#edf3fa',
      accent: '#2865a0', 'accent-bright': '#4178ae', secondary: '#c5b28a', 'secondary-ink': '#786139',
    },
  },
  {
    id: 'attribute-jade', group: 'attribute', attribute: 3,
    name: { 'zh-CN': '翡翠', en: 'Jade' },
    description: { 'zh-CN': '浅绿底 · 翡翠与麦色', en: 'Pale green · Jade and wheat' },
    tokens: {
      ...lightPalette, canvas: '#edf5f0',
      accent: '#27704f', 'accent-bright': '#3e805e', secondary: '#c6ad75', 'secondary-ink': '#766035',
    },
  },
  {
    id: 'attribute-gold', group: 'attribute', attribute: 4,
    name: { 'zh-CN': '山吹', en: 'Golden Yellow' },
    description: { 'zh-CN': '奶油底 · 山吹与灰蓝', en: 'Cream · Golden yellow and slate blue' },
    tokens: {
      ...lightPalette, canvas: '#faf5e5',
      accent: '#805c16', 'accent-bright': '#936c21', secondary: '#7b97b0', 'secondary-ink': '#47647e',
    },
  },
  {
    id: 'attribute-violet', group: 'attribute', attribute: 5,
    name: { 'zh-CN': '紫苑', en: 'Purple' },
    description: { 'zh-CN': '浅丁香底 · 紫苑与灰绿', en: 'Pale lilac · Purple and sage' },
    tokens: {
      ...lightPalette, canvas: '#f3eff8',
      accent: '#73529a', 'accent-bright': '#8562aa', secondary: '#9eafa1', 'secondary-ink': '#4b6956',
    },
  },
];
