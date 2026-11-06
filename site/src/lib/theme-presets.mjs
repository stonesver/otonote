export const DEFAULT_THEME = 'paper';

// Two-color palettes with light reading surfaces.
// Derived tokens stay in CSS; game colors keep their own identities.
const lightPalette = {
  'color-scheme': 'light',
  text: '#242628', 'text-soft': '#414448', canvas: '#f5f5f4', surface: '#ffffff', 'surface-deep': '#e8eaeb',
  accent: '#963b62', 'accent-bright': '#a3456f', secondary: '#d9e681', 'secondary-ink': '#536424', 'on-secondary': '#384319',
  border: '#ccd0d2', muted: '#62686d', 'on-accent': '#fff',
  warning: '#8a642b', 'warning-ink': '#76531f', success: '#3b6b4f', 'success-ink': '#2f583f', danger: '#a33f42', 'danger-ink': '#873033',
  'inverse-surface': '#26292c', 'inverse-text': '#f8f9f9', 'inverse-muted': '#bfc4c8',
  'media-shade': '#101214', 'media-text': '#fff', 'shadow-color': '#151719', 'chart-5': '#61758c',
};

export const THEME_PRESETS = [
  {
    id: 'paper', group: 'everyday',
    name: { 'zh-CN': '莓红 × 青柠', en: 'Berry × Lime' },
    description: { 'zh-CN': '莓红 · 青柠', en: 'Berry · Lime' },
    tokens: {...lightPalette},
  },
  {
    id: 'night', group: 'dark',
    name: { 'zh-CN': '夜间', en: 'Night' },
    description: { 'zh-CN': '炭灰 · 银蓝与暖金', en: 'Charcoal · Silver blue and warm gold' },
    tokens: {
      'color-scheme': 'dark',
      text: '#eeeff0', 'text-soft': '#d0d3d5', canvas: '#191b1d', surface: '#222528', 'surface-deep': '#2d3135',
      accent: '#c4d0d3', 'accent-bright': '#e0e6e8', secondary: '#d7bc9e', 'secondary-ink': '#dec7ae', 'on-secondary': '#28221d',
      border: '#4c5155', muted: '#a9afb4', 'on-accent': '#202528',
      warning: '#d7b77c', 'warning-ink': '#e0c99e', success: '#93baa5', 'success-ink': '#b7d2c2', danger: '#dda4a6', 'danger-ink': '#ecc3c4',
      'inverse-surface': '#151719', 'inverse-text': '#f0f1f2', 'inverse-muted': '#b3b9be',
      'media-shade': '#0d0f10', 'media-text': '#fff', 'shadow-color': '#08090a', 'chart-5': '#b6b6c6',
    },
  },
  {
    id: 'apricot', group: 'everyday',
    name: { 'zh-CN': '青绿 × 珊瑚', en: 'Teal × Coral' },
    description: { 'zh-CN': '青绿 · 珊瑚', en: 'Teal · Coral' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#126e69', 'accent-bright': '#21766e', secondary: '#f3907d', 'secondary-ink': '#963c2e', 'on-secondary': '#5b241a',
    },
  },
  {
    id: 'silver', group: 'everyday',
    name: { 'zh-CN': '靛蓝 × 柠黄', en: 'Indigo × Lemon' },
    description: { 'zh-CN': '靛蓝 · 柠黄', en: 'Indigo · Lemon' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#4852a2', 'accent-bright': '#5c63ac', secondary: '#f0d86c', 'secondary-ink': '#776013', 'on-secondary': '#51410d',
    },
  },
  {
    id: 'new-year', group: 'occasion',
    name: { 'zh-CN': '新年', en: 'New Year' },
    description: { 'zh-CN': '朱红 · 金黄', en: 'Vermilion · Gold' },
    tokens: {
      ...lightPalette, canvas: '#faf1e6',
      accent: '#a13a2e', 'accent-bright': '#b24737', secondary: '#f5cf6a', 'secondary-ink': '#7a5b23', 'on-secondary': '#613b10',
    },
  },
  {
    id: 'christmas', group: 'occasion',
    name: { 'zh-CN': '圣诞', en: 'Christmas' },
    description: { 'zh-CN': '松绿 · 圣诞红', en: 'Pine green · Christmas red' },
    tokens: {
      ...lightPalette, canvas: '#edf5f3',
      accent: '#265c43', 'accent-bright': '#397456', secondary: '#bc403c', 'secondary-ink': '#a23732', 'on-secondary': '#ffffff',
    },
  },
  {
    id: 'anniversary', group: 'occasion',
    name: { 'zh-CN': '周年', en: 'Anniversary' },
    description: { 'zh-CN': '深蓝 · 香槟金', en: 'Navy · Champagne gold' },
    tokens: {
      ...lightPalette, canvas: '#eff3f9',
      accent: '#294c72', 'accent-bright': '#3c6085', secondary: '#f2c85f', 'secondary-ink': '#7b5d20', 'on-secondary': '#543c10',
    },
  },
  {
    id: 'attribute-red', group: 'attribute', attribute: 1,
    name: { 'zh-CN': '红赤', en: 'Red' },
    description: { 'zh-CN': '红赤 · 湖蓝', en: 'Red · Aqua' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#ad3455', 'accent-bright': '#bd4765', secondary: '#78cbd0', 'secondary-ink': '#286269', 'on-secondary': '#173e44',
    },
  },
  {
    id: 'attribute-azure', group: 'attribute', attribute: 2,
    name: { 'zh-CN': '绀碧', en: 'Azure' },
    description: { 'zh-CN': '绀碧 · 橙黄', en: 'Azure · Amber' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#2865a0', 'accent-bright': '#4178ae', secondary: '#ffc26e', 'secondary-ink': '#7b5019', 'on-secondary': '#523719',
    },
  },
  {
    id: 'attribute-jade', group: 'attribute', attribute: 3,
    name: { 'zh-CN': '翡翠', en: 'Jade' },
    description: { 'zh-CN': '翡翠 · 樱粉', en: 'Jade · Cherry pink' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#27704f', 'accent-bright': '#3e805e', secondary: '#efa4bb', 'secondary-ink': '#903c60', 'on-secondary': '#58223a',
    },
  },
  {
    id: 'attribute-gold', group: 'attribute', attribute: 4,
    name: { 'zh-CN': '山吹', en: 'Golden Yellow' },
    description: { 'zh-CN': '山吹 · 天蓝', en: 'Golden yellow · Sky blue' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#805c16', 'accent-bright': '#936c21', secondary: '#86b9e4', 'secondary-ink': '#315f85', 'on-secondary': '#1b4160',
    },
  },
  {
    id: 'attribute-violet', group: 'attribute', attribute: 5,
    name: { 'zh-CN': '紫苑', en: 'Purple' },
    description: { 'zh-CN': '紫苑 · 嫩绿', en: 'Purple · Spring green' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#73529a', 'accent-bright': '#8562aa', secondary: '#bddc79', 'secondary-ink': '#536728', 'on-secondary': '#3a4a1c',
    },
  },
];
