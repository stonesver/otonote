export const DEFAULT_THEME = 'paper';

// Shared neutral surfaces and text keep color in controls and small accents.
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
    description: { 'zh-CN': '冷白 · 蓝', en: 'Cool white · Blue' },
    tokens: {
      ...lightPalette, canvas: '#f3f5f7',
      accent: '#215c9c', 'accent-bright': '#3d74ac', secondary: '#8daabd', 'secondary-ink': '#476779',
    },
  },
  {
    id: 'apricot', group: 'everyday',
    name: { 'zh-CN': '暖白', en: 'Warm white' },
    description: { 'zh-CN': '暖白 · 砖红', en: 'Warm white · Brick red' },
    tokens: {
      ...lightPalette, canvas: '#f7f5f2',
      accent: '#8f4738', 'accent-bright': '#a55746', secondary: '#b1a99b', 'secondary-ink': '#66594a',
    },
  },
  {
    id: 'silver', group: 'everyday',
    name: { 'zh-CN': '石墨', en: 'Graphite' },
    description: { 'zh-CN': '浅灰 · 钢灰', en: 'Light grey · Steel grey' },
    tokens: {
      ...lightPalette, canvas: '#f0f1f1',
      accent: '#49575f', 'accent-bright': '#65737c', secondary: '#aaafb1', 'secondary-ink': '#535b60',
    },
  },
  {
    id: 'new-year', group: 'occasion',
    name: { 'zh-CN': '新年', en: 'New Year' },
    description: { 'zh-CN': '暖白 · 朱红与黄铜', en: 'Warm white · Vermilion and brass' },
    tokens: {
      ...lightPalette, canvas: '#f7f5f2',
      accent: '#a13a2e', 'accent-bright': '#b24737', secondary: '#baa16f', 'secondary-ink': '#7a5b23',
    },
  },
  {
    id: 'christmas', group: 'occasion',
    name: { 'zh-CN': '圣诞', en: 'Christmas' },
    description: { 'zh-CN': '白 · 常绿与红', en: 'White · Evergreen and red' },
    tokens: {
      ...lightPalette,
      accent: '#265c43', 'accent-bright': '#397456', secondary: '#bc4c43', 'secondary-ink': '#a23732',
    },
  },
  {
    id: 'anniversary', group: 'occasion',
    name: { 'zh-CN': '周年', en: 'Anniversary' },
    description: { 'zh-CN': '白 · 深蓝与金', en: 'White · Navy and gold' },
    tokens: {
      ...lightPalette,
      accent: '#294c72', 'accent-bright': '#3c6085', secondary: '#b69a5e', 'secondary-ink': '#7b5d20',
    },
  },
  {
    id: 'attribute-red', group: 'attribute', attribute: 1,
    name: { 'zh-CN': '红赤', en: 'Red' },
    description: { 'zh-CN': '白 · 红赤', en: 'White · Red' },
    tokens: {
      ...lightPalette,
      accent: '#ad3455', 'accent-bright': '#bd4765', secondary: '#cf7d90', 'secondary-ink': '#854c5b',
    },
  },
  {
    id: 'attribute-azure', group: 'attribute', attribute: 2,
    name: { 'zh-CN': '绀碧', en: 'Azure' },
    description: { 'zh-CN': '白 · 绀碧', en: 'White · Azure' },
    tokens: {
      ...lightPalette,
      accent: '#2865a0', 'accent-bright': '#4178ae', secondary: '#7fa6cf', 'secondary-ink': '#486580',
    },
  },
  {
    id: 'attribute-jade', group: 'attribute', attribute: 3,
    name: { 'zh-CN': '翡翠', en: 'Jade' },
    description: { 'zh-CN': '白 · 翡翠', en: 'White · Jade' },
    tokens: {
      ...lightPalette,
      accent: '#27704f', 'accent-bright': '#3e805e', secondary: '#87b19b', 'secondary-ink': '#426750',
    },
  },
  {
    id: 'attribute-gold', group: 'attribute', attribute: 4,
    name: { 'zh-CN': '山吹', en: 'Golden Yellow' },
    description: { 'zh-CN': '白 · 山吹', en: 'White · Golden yellow' },
    tokens: {
      ...lightPalette,
      accent: '#805c16', 'accent-bright': '#936c21', secondary: '#c2a562', 'secondary-ink': '#75613a',
    },
  },
  {
    id: 'attribute-violet', group: 'attribute', attribute: 5,
    name: { 'zh-CN': '紫苑', en: 'Purple' },
    description: { 'zh-CN': '白 · 紫苑', en: 'White · Purple' },
    tokens: {
      ...lightPalette,
      accent: '#73529a', 'accent-bright': '#8562aa', secondary: '#a58abd', 'secondary-ink': '#665178',
    },
  },
];
