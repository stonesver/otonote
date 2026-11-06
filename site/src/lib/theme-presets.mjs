export const DEFAULT_THEME = 'paper';

// Each palette pairs navigation color with a distinct action color; reading surfaces stay light.
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
    description: { 'zh-CN': '莓红导航 · 青柠操作区', en: 'Berry navigation · Lime actions' },
    tokens: {...lightPalette},
  },
  {
    id: 'night', group: 'dark',
    name: { 'zh-CN': '夜间', en: 'Night' },
    description: { 'zh-CN': '银蓝导航 · 暖金操作区', en: 'Silver blue navigation · Warm gold actions' },
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
    id: 'mist', group: 'everyday',
    name: { 'zh-CN': '蓝 × 橙', en: 'Blue × Orange' },
    description: { 'zh-CN': '蓝色导航 · 杏橙操作区', en: 'Blue navigation · Apricot actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#255bb2', 'accent-bright': '#366ac0', secondary: '#ffb36d', 'secondary-ink': '#91400d', 'on-secondary': '#572b11',
    },
  },
  {
    id: 'apricot', group: 'everyday',
    name: { 'zh-CN': '青绿 × 珊瑚', en: 'Teal × Coral' },
    description: { 'zh-CN': '青绿导航 · 珊瑚操作区', en: 'Teal navigation · Coral actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#126e69', 'accent-bright': '#21766e', secondary: '#f3907d', 'secondary-ink': '#963c2e', 'on-secondary': '#5b241a',
    },
  },
  {
    id: 'silver', group: 'everyday',
    name: { 'zh-CN': '靛蓝 × 柠黄', en: 'Indigo × Lemon' },
    description: { 'zh-CN': '靛蓝导航 · 柠黄操作区', en: 'Indigo navigation · Lemon actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#4852a2', 'accent-bright': '#5c63ac', secondary: '#f0d86c', 'secondary-ink': '#776013', 'on-secondary': '#51410d',
    },
  },
  {
    id: 'new-year', group: 'occasion',
    name: { 'zh-CN': '新年', en: 'New Year' },
    description: { 'zh-CN': '朱红导航 · 金黄操作区', en: 'Vermilion navigation · Gold actions' },
    tokens: {
      ...lightPalette, canvas: '#faf1e6',
      accent: '#a13a2e', 'accent-bright': '#b24737', secondary: '#f5cf6a', 'secondary-ink': '#7a5b23', 'on-secondary': '#613b10',
    },
  },
  {
    id: 'christmas', group: 'occasion',
    name: { 'zh-CN': '圣诞', en: 'Christmas' },
    description: { 'zh-CN': '松绿导航 · 圣诞红操作区', en: 'Pine navigation · Christmas red actions' },
    tokens: {
      ...lightPalette, canvas: '#edf5f3',
      accent: '#265c43', 'accent-bright': '#397456', secondary: '#bc403c', 'secondary-ink': '#a23732', 'on-secondary': '#ffffff',
    },
  },
  {
    id: 'anniversary', group: 'occasion',
    name: { 'zh-CN': '周年', en: 'Anniversary' },
    description: { 'zh-CN': '深蓝导航 · 香槟金操作区', en: 'Navy navigation · Champagne actions' },
    tokens: {
      ...lightPalette, canvas: '#eff3f9',
      accent: '#294c72', 'accent-bright': '#3c6085', secondary: '#f2c85f', 'secondary-ink': '#7b5d20', 'on-secondary': '#543c10',
    },
  },
  {
    id: 'attribute-red', group: 'attribute', attribute: 1,
    name: { 'zh-CN': '红赤', en: 'Red' },
    description: { 'zh-CN': '红赤导航 · 湖蓝操作区', en: 'Red navigation · Aqua actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#ad3455', 'accent-bright': '#bd4765', secondary: '#78cbd0', 'secondary-ink': '#286269', 'on-secondary': '#173e44',
    },
  },
  {
    id: 'attribute-azure', group: 'attribute', attribute: 2,
    name: { 'zh-CN': '绀碧', en: 'Azure' },
    description: { 'zh-CN': '绀碧导航 · 橙黄操作区', en: 'Azure navigation · Amber actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#2865a0', 'accent-bright': '#4178ae', secondary: '#ffc26e', 'secondary-ink': '#7b5019', 'on-secondary': '#523719',
    },
  },
  {
    id: 'attribute-jade', group: 'attribute', attribute: 3,
    name: { 'zh-CN': '翡翠', en: 'Jade' },
    description: { 'zh-CN': '翡翠导航 · 樱粉操作区', en: 'Jade navigation · Pink actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#27704f', 'accent-bright': '#3e805e', secondary: '#efa4bb', 'secondary-ink': '#903c60', 'on-secondary': '#58223a',
    },
  },
  {
    id: 'attribute-gold', group: 'attribute', attribute: 4,
    name: { 'zh-CN': '山吹', en: 'Golden Yellow' },
    description: { 'zh-CN': '山吹导航 · 天蓝操作区', en: 'Gold navigation · Sky blue actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#805c16', 'accent-bright': '#936c21', secondary: '#86b9e4', 'secondary-ink': '#315f85', 'on-secondary': '#1b4160',
    },
  },
  {
    id: 'attribute-violet', group: 'attribute', attribute: 5,
    name: { 'zh-CN': '紫苑', en: 'Purple' },
    description: { 'zh-CN': '紫苑导航 · 嫩绿操作区', en: 'Purple navigation · Spring green actions' },
    tokens: {
      ...lightPalette, canvas: '#f6f7f8',
      accent: '#73529a', 'accent-bright': '#8562aa', secondary: '#bddc79', 'secondary-ink': '#536728', 'on-secondary': '#3a4a1c',
    },
  },
];
